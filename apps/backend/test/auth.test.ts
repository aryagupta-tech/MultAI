import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import test from 'node:test';
import type { FastifyRequest } from 'fastify';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { AuthService } from '../src/auth.js';
import type { Config } from '../src/config.js';
import { ApiError } from '../src/errors.js';
import { pkceChallenge, verifyGoogleIdentity, type OidcClient } from '../src/oidc.js';
import { createTestContext } from './helpers.js';

const syntheticConfig: Config = {
  environment: 'test', host: '127.0.0.1', port: 4310,
  databaseUrl: 'postgres://synthetic.invalid/multai',
  publicOrigin: 'http://127.0.0.1:4310', desktopCallbackUri: 'multai-dev://auth/callback',
  googleClientId: 'synthetic-client', googleClientSecret: 'synthetic-secret',
  googleRedirectUri: 'http://127.0.0.1:4310/v1/auth/google/callback',
};

/** Synthetic provider double: no real Google identity or provider acceptance. */
function syntheticOidc(subject = 'synthetic-person'): OidcClient {
  return {
    authorizationUrl(input) {
      const url = new URL('https://synthetic.invalid/authorize');
      url.searchParams.set('state', input.state);
      url.searchParams.set('nonce', input.nonce);
      return url.toString();
    },
    async exchange() { return { subject, displayName: 'Synthetic person' }; },
  };
}

const requestFor = (token: string) => ({ headers: { authorization: `Bearer ${token}` } } as FastifyRequest);
const rejectedWith = (code: string) => (error: unknown) => error instanceof ApiError && error.code === code;

async function signIn(auth: AuthService, deviceName = 'Synthetic desktop', proof: { deviceId: string; deviceSecret: string } | undefined = undefined) {
  const codeVerifier = randomBytes(32).toString('base64url');
  const start = await auth.start(pkceChallenge(codeVerifier));
  const state = new URL(start.authorizationUrl).searchParams.get('state')!;
  const callback = new URL(await auth.callback(state, 'synthetic-authorization-code'));
  const input = {
    flowId: start.flowId,
    completionCode: callback.searchParams.get('completionCode')!, codeVerifier, deviceName, ...proof,
  };
  return { tokens: await auth.exchange(input), input, state };
}

test('synthetic OIDC completion requires the initiating desktop proof and is one-use', async (t) => {
  const context = await createTestContext(); t.after(context.close);
  const auth = new AuthService(context.db, syntheticConfig, syntheticOidc());
  const verifier = randomBytes(32).toString('base64url');
  const start = await auth.start(pkceChallenge(verifier));
  const state = new URL(start.authorizationUrl).searchParams.get('state')!;
  const callback = new URL(await auth.callback(state, 'synthetic-code'));
  assert.equal(callback.origin, 'null');
  assert.equal(callback.protocol, 'multai-dev:');
  assert.equal(callback.hostname, 'auth');
  assert.equal(callback.pathname, '/callback');
  const input = {
    flowId: start.flowId, completionCode: callback.searchParams.get('completionCode')!,
    codeVerifier: verifier, deviceName: 'Synthetic desktop',
  };
  const changedCallback = new AuthService(context.db, { ...syntheticConfig, desktopCallbackUri: 'multai-dev://auth/changed' }, syntheticOidc());
  await assert.rejects(changedCallback.exchange(input), rejectedWith('invalid_flow'));
  const changedClient = new AuthService(context.db, { ...syntheticConfig, googleClientId: 'changed-synthetic-client' }, syntheticOidc());
  await assert.rejects(changedClient.exchange(input), rejectedWith('invalid_flow'));
  await assert.rejects(auth.exchange({ ...input, codeVerifier: randomBytes(32).toString('base64url') }), rejectedWith('invalid_flow'));
  const tokens = await auth.exchange(input);
  const actor = await auth.authenticateRequest(requestFor(tokens.accessToken));
  assert.equal(actor.deviceId, tokens.deviceId);
  await assert.rejects(auth.exchange(input), rejectedWith('invalid_flow'));
  await assert.rejects(auth.callback(state, 'synthetic-code'), rejectedWith('invalid_flow'));
  assert.equal((await context.db.query('SELECT * FROM workspaces WHERE owner_id=$1', [actor.userId])).rowCount, 1);
  const stored = await context.db.query('SELECT token_hash FROM access_tokens UNION ALL SELECT token_hash FROM refresh_tokens');
  assert.equal(stored.rows.some((row) => [tokens.accessToken, tokens.refreshToken].includes(row.token_hash as string)), false);
  assert.ok(stored.rows.every((row) => /^[a-f0-9]{64}$/.test(row.token_hash as string)));
  const flow = (await context.db.query('SELECT identity,provider_verifier,completion_hash FROM oauth_flows WHERE id=$1', [start.flowId])).rows[0];
  assert.deepEqual(flow, { identity: null, provider_verifier: null, completion_hash: null });
});

test('same-device proof restores the original device after signout without crossing account or revocation boundaries', async (t) => {
  const context = await createTestContext(); t.after(context.close);
  const auth = new AuthService(context.db, syntheticConfig, syntheticOidc());
  const first = await signIn(auth);
  assert.ok(first.tokens.deviceSecret);
  const firstActor = await auth.authenticateRequest(requestFor(first.tokens.accessToken));
  const proof = { deviceId: first.tokens.deviceId, deviceSecret: first.tokens.deviceSecret! };
  const stored = (await context.db.query('SELECT reauth_secret_hash FROM devices WHERE id=$1', [proof.deviceId])).rows[0];
  assert.notEqual(stored.reauth_secret_hash, proof.deviceSecret);
  assert.match(stored.reauth_secret_hash as string, /^[a-f0-9]{64}$/);
  await auth.logout(firstActor);
  const resumed = await signIn(auth, 'Same synthetic desktop', proof);
  const resumedActor = await auth.authenticateRequest(requestFor(resumed.tokens.accessToken));
  assert.equal(resumedActor.deviceId, firstActor.deviceId);
  assert.equal(resumedActor.userId, firstActor.userId);
  assert.notEqual(resumedActor.authSessionId, firstActor.authSessionId);
  assert.equal(resumed.tokens.deviceSecret, undefined);
  assert.equal((await context.db.query('SELECT * FROM devices WHERE user_id=$1', [firstActor.userId])).rowCount, 1);
  await assert.rejects(signIn(auth, 'Wrong secret', { ...proof, deviceSecret: randomBytes(32).toString('base64url') }), rejectedWith('invalid_device_proof'));
  const otherAuth = new AuthService(context.db, syntheticConfig, syntheticOidc('different-synthetic-account'));
  await assert.rejects(signIn(otherAuth, 'Other account', proof), rejectedWith('device_account_mismatch'));
  await auth.revokeDevice(resumedActor, resumedActor.deviceId);
  await assert.rejects(signIn(auth, 'Revoked original device', proof), rejectedWith('invalid_device_proof'));
});

test('refresh reuse durably revokes the entire access-token family', async (t) => {
  const context = await createTestContext(); t.after(context.close);
  const auth = new AuthService(context.db, syntheticConfig, syntheticOidc());
  const { tokens } = await signIn(auth);
  const rotated = await auth.refresh(tokens.refreshToken);
  await auth.authenticateRequest(requestFor(rotated.accessToken));
  await assert.rejects(auth.refresh(tokens.refreshToken), rejectedWith('invalid_credentials'));
  await assert.rejects(auth.authenticateRequest(requestFor(rotated.accessToken)), rejectedWith('invalid_credentials'));
  await assert.rejects(auth.authenticateRequest(requestFor(tokens.accessToken)), rejectedWith('invalid_credentials'));
  await assert.rejects(auth.refresh(rotated.refreshToken), rejectedWith('invalid_credentials'));
});

test('concurrent refresh admits one rotation and reuse fences the racing winner', async (t) => {
  const context = await createTestContext(); t.after(context.close);
  const auth = new AuthService(context.db, syntheticConfig, syntheticOidc());
  const { tokens } = await signIn(auth);
  const results = await Promise.allSettled([auth.refresh(tokens.refreshToken), auth.refresh(tokens.refreshToken)]);
  const winners = results.filter((result) => result.status === 'fulfilled');
  assert.equal(winners.length, 1);
  assert.equal(results.filter((result) => result.status === 'rejected').length, 1);
  assert.equal(winners[0]!.status, 'fulfilled');
  if (winners[0]!.status === 'fulfilled') {
    await assert.rejects(auth.authenticateRequest(requestFor(winners[0]!.value.accessToken)), rejectedWith('invalid_credentials'));
  }
});

test('logout, device revocation, and cross-account device ownership are enforced', async (t) => {
  const context = await createTestContext(); t.after(context.close);
  const auth = new AuthService(context.db, syntheticConfig, syntheticOidc());
  const first = await signIn(auth, 'First synthetic device');
  const second = await signIn(auth, 'Second synthetic device');
  const firstActor = await auth.authenticateRequest(requestFor(first.tokens.accessToken));
  const secondActor = await auth.authenticateRequest(requestFor(second.tokens.accessToken));
  assert.equal(firstActor.userId, secondActor.userId);
  assert.notEqual(firstActor.deviceId, secondActor.deviceId);
  assert.equal((await context.db.query('SELECT * FROM workspaces')).rowCount, 1);
  const otherAuth = new AuthService(context.db, syntheticConfig, syntheticOidc('other-synthetic-person'));
  const other = await signIn(otherAuth);
  const otherActor = await otherAuth.authenticateRequest(requestFor(other.tokens.accessToken));
  await assert.rejects(otherAuth.revokeDevice(otherActor, firstActor.deviceId), rejectedWith('device_not_found'));
  await auth.revokeDevice(secondActor, firstActor.deviceId);
  await assert.rejects(auth.authenticateRequest(requestFor(first.tokens.accessToken)), rejectedWith('invalid_credentials'));
  await assert.rejects(auth.refresh(first.tokens.refreshToken), rejectedWith('invalid_credentials'));
  await auth.authenticateRequest(requestFor(second.tokens.accessToken));
  await auth.logout(secondActor);
  await assert.rejects(auth.authenticateRequest(requestFor(second.tokens.accessToken)), rejectedWith('invalid_credentials'));
  await otherAuth.authenticateRequest(requestFor(other.tokens.accessToken));
});

test('expired flows, callback replay, and rejected identity checks never issue credentials', async (t) => {
  const context = await createTestContext(); t.after(context.close);
  const provider = syntheticOidc();
  provider.exchange = async () => { throw new ApiError(401, 'invalid_identity', 'Synthetic rejection'); };
  const auth = new AuthService(context.db, syntheticConfig, provider);
  const start = await auth.start(pkceChallenge(randomBytes(32).toString('base64url')));
  const state = new URL(start.authorizationUrl).searchParams.get('state')!;
  await assert.rejects(auth.callback(state, 'synthetic-code'), rejectedWith('invalid_identity'));
  await assert.rejects(auth.callback(state, 'synthetic-code'), rejectedWith('invalid_flow'));
  const expired = await auth.start(pkceChallenge(randomBytes(32).toString('base64url')));
  await context.db.query("UPDATE oauth_flows SET expires_at=now()-interval '1 second' WHERE id=$1", [expired.flowId]);
  await assert.rejects(auth.callback(new URL(expired.authorizationUrl).searchParams.get('state')!, 'synthetic-code'), rejectedWith('invalid_flow'));
  assert.equal((await context.db.query('SELECT * FROM access_tokens')).rowCount, 0);
});

test('real OIDC verifier rejects synthetic wrong signatures, nonce, issuer, audience, expiry and missing expiry', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'synthetic-key', alg: 'RS256', use: 'sig' };
  const key = createLocalJWKSet({ keys: [jwk] });
  const claims = { sub: 'synthetic-subject', nonce: 'synthetic-nonce', name: 'Synthetic person' };
  const token = (overrides: Record<string, unknown> = {}, options: { issuer?: string; audience?: string; expiry?: string | number | null } = {}) => {
    let jwt = new SignJWT({ ...claims, ...overrides }).setProtectedHeader({ alg: 'RS256', kid: 'synthetic-key' })
      .setIssuer(options.issuer ?? 'https://accounts.google.com').setAudience(options.audience ?? 'synthetic-client').setIssuedAt();
    if (options.expiry !== null) jwt = jwt.setExpirationTime(options.expiry ?? '10m');
    return jwt.sign(privateKey);
  };
  assert.deepEqual(await verifyGoogleIdentity(await token(), 'synthetic-client', 'synthetic-nonce', key), {
    subject: 'synthetic-subject', displayName: 'Synthetic person',
  });
  const invalid = [
    await token({ nonce: 'wrong-nonce' }), await token({}, { issuer: 'https://synthetic.invalid' }),
    await token({}, { audience: 'other-client' }), await token({}, { expiry: Math.floor(Date.now() / 1000) - 30 }),
    await token({}, { expiry: null }),
  ];
  const wrong = await generateKeyPair('RS256');
  invalid.push(await new SignJWT(claims).setProtectedHeader({ alg: 'RS256', kid: 'synthetic-key' })
    .setIssuer('https://accounts.google.com').setAudience('synthetic-client').setIssuedAt().setExpirationTime('10m').sign(wrong.privateKey));
  for (const idToken of invalid) {
    await assert.rejects(verifyGoogleIdentity(idToken, 'synthetic-client', 'synthetic-nonce', key), rejectedWith('invalid_identity'));
  }
});

test('unconfigured real Google sign-in is unavailable and cannot become a development login bypass', async (t) => {
  const context = await createTestContext(); t.after(context.close);
  const response = await context.app.inject({ method: 'POST', url: '/v1/auth/google/start', payload: { codeChallenge: pkceChallenge(randomBytes(32).toString('base64url')) } });
  assert.equal(response.statusCode, 503);
  const bypass = await context.app.inject({ method: 'POST', url: '/v1/auth/development-login', payload: { userId: 'synthetic-person' } });
  assert.equal(bypass.statusCode, 404);
});
