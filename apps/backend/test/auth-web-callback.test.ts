import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {test} from 'node:test';
import {AuthService, signInClients} from '../src/auth.js';
import type {Config} from '../src/config.js';
import {pkceChallenge, type OidcClient} from '../src/oidc.js';
import {createTestContext, testConfig} from './helpers.js';

const secret = () => randomBytes(32).toString('base64url');
const oidc: OidcClient = {
  authorizationUrl(input) {const url = new URL('https://synthetic.invalid/authorize'); url.searchParams.set('state', input.state); return url.href;},
  async exchange() {return {subject: 'synthetic-browser-callback', displayName: 'Synthetic browser callback'};},
};
const modes = [
  {...testConfig, environment: 'test', publicOrigin: 'http://127.0.0.1:4310'},
  {...testConfig, environment: 'production', publicOrigin: 'https://api.multai.test', desktopClientId: 'multai-desktop', desktopCallbackUri: 'multai://auth/callback'},
] satisfies Config[];

for (const mode of modes) {
  const config: Config = {...mode, googleClientId: 'synthetic-client', googleClientSecret: 'synthetic-secret', googleRedirectUri: `${mode.publicOrigin}/v1/auth/google/callback`};
  test(`${mode.environment}: browser completion stays outside Android App Links; native completion is unchanged`, async t => {
    const ctx = await createTestContext({config, oidc}); t.after(() => ctx.close());
    const auth = new AuthService(ctx.db, config, oidc);
    const headers = {origin: config.publicOrigin, 'x-multai-client': 'web'};
    const verifier = secret() + secret();
    const started = await ctx.app.inject({method: 'POST', url: '/v1/web/auth/start', headers, payload: {codeChallenge: pkceChallenge(verifier)}});
    assert.equal(started.statusCode, 200, started.body);
    const flow = (await ctx.db.query('SELECT desktop_callback_uri,desktop_client_id FROM oauth_flows WHERE id=$1', [started.json().flowId])).rows[0]!;
    assert.equal(flow.desktop_callback_uri, `${config.publicOrigin}/app/auth`);
    assert.equal(flow.desktop_client_id, config.environment === 'production' ? 'multai-companion-web' : 'multai-companion-web-development');
    const state = new URL(started.json().authorizationUrl).searchParams.get('state')!;
    const completed = await ctx.app.inject({method: 'GET', url: `/v1/auth/google/callback?state=${state}&code=synthetic`});
    assert.equal(completed.statusCode, 303);
    const destination = new URL(String(completed.headers.location));
    assert.equal(destination.origin, config.publicOrigin);
    assert.equal(destination.pathname, '/app/auth');
    assert.ok(!['/app', '/app/'].includes(destination.pathname), 'the APK cannot intercept the browser PKCE callback');
    assert.equal(destination.search, '', 'completion credentials remain in the fragment');
    assert.equal(completed.headers['cache-control'], 'no-store');
    assert.equal(completed.headers['referrer-policy'], 'no-referrer');
    const [flowId, completionCode] = destination.hash.slice('#signin='.length).split('.');
    const body = {flowId, completionCode, codeVerifier: verifier, deviceName: 'Synthetic browser'};
    assert.equal((await ctx.app.inject({method: 'POST', url: '/v1/auth/google/exchange', payload: body})).statusCode, 401);
    const exchanged = await ctx.app.inject({method: 'POST', url: '/v1/web/auth/exchange', headers, payload: body});
    assert.equal(exchanged.statusCode, 200, exchanged.body);
    assert.equal(exchanged.json().refreshToken, undefined);
    assert.match(String(exchanged.headers['set-cookie']), /HttpOnly; SameSite=Strict/u);
    if (mode.environment === 'production') assert.match(String(exchanged.headers['set-cookie']), /; Secure$/u);
    assert.equal((await ctx.app.inject({method: 'POST', url: '/v1/web/auth/exchange', headers, payload: body})).statusCode, 401, 'completion remains one-use');

    const android = await auth.start(pkceChallenge(verifier), 'android');
    const native = new URL(await auth.callback(new URL(android.authorizationUrl).searchParams.get('state')!, 'synthetic'));
    assert.equal(native.protocol, mode.environment === 'production' ? 'multai-companion:' : 'multai-companion-dev:');
    assert.equal(native.hostname, 'auth');
    assert.equal(native.pathname, '/callback');
    assert.equal(native.search, '');
    assert.match(native.hash, /^#signin=/u);
  });

  test(`${mode.environment}: legacy browser flows survive rollout and return on the browser-only path`, async t => {
    const ctx = await createTestContext({config, oidc}); t.after(() => ctx.close());
    const auth = new AuthService(ctx.db, config, oidc);
    for (const phase of ['before-callback', 'before-exchange']) {
      const verifier = secret() + secret();
      const started = await auth.start(pkceChallenge(verifier), 'web');
      if (phase === 'before-callback') await ctx.db.query('UPDATE oauth_flows SET desktop_callback_uri=$1 WHERE id=$2', [`${config.publicOrigin}/app/`, started.flowId]);
      const completed = new URL(await auth.callback(new URL(started.authorizationUrl).searchParams.get('state')!, 'synthetic'));
      assert.equal(completed.pathname, '/app/auth', 'even an old stored callback returns outside native App Links');
      if (phase === 'before-exchange') await ctx.db.query('UPDATE oauth_flows SET desktop_callback_uri=$1 WHERE id=$2', [`${config.publicOrigin}/app/`, started.flowId]);
      const completionCode = completed.hash.slice('#signin='.length).split('.')[1]!;
      const input = {flowId: started.flowId, completionCode, codeVerifier: verifier, deviceName: 'Synthetic legacy browser'};
      await assert.rejects(auth.exchange(input), error => (error as {code?: string}).code === 'invalid_flow');
      assert.ok((await auth.exchange(input, ['web'])).accessToken);
    }
  });

  test(`${mode.environment}: callback compatibility never accepts a foreign origin, mode or arbitrary return path`, async t => {
    const ctx = await createTestContext({config, oidc}); t.after(() => ctx.close());
    const auth = new AuthService(ctx.db, config, oidc);
    for (const callback of ['https://foreign.invalid/app/', 'https://foreign.invalid/app/auth']) {
      const started = await auth.start(pkceChallenge(secret() + secret()), 'web');
      await ctx.db.query('UPDATE oauth_flows SET desktop_callback_uri=$1 WHERE id=$2', [callback, started.flowId]);
      await assert.rejects(auth.callback(new URL(started.authorizationUrl).searchParams.get('state')!, 'synthetic'), error => (error as {code?: string}).code === 'invalid_flow');
    }
    const started = await auth.start(pkceChallenge(secret() + secret()), 'web');
    const otherClient = config.environment === 'production' ? 'multai-companion-web-development' : 'multai-companion-web';
    await ctx.db.query('UPDATE oauth_flows SET desktop_client_id=$1,desktop_callback_uri=$2 WHERE id=$3', [otherClient, 'https://api.multai.test/app/auth', started.flowId]);
    await assert.rejects(auth.callback(new URL(started.authorizationUrl).searchParams.get('state')!, 'synthetic'), error => (error as {code?: string}).code === 'invalid_flow');
    const current = await auth.start(pkceChallenge(secret() + secret()), 'web');
    for (const suffix of ['/app/auth/', '/app/login', '/app/auth?next=https://foreign.invalid', '/app/auth#signin=bad']) {
      await assert.rejects(ctx.db.query('UPDATE oauth_flows SET desktop_callback_uri=$1 WHERE id=$2', [`${config.publicOrigin}${suffix}`, current.flowId]), error => (error as {code?: string}).code === '23514');
    }
    const rejected = await ctx.app.inject({method: 'POST', url: '/v1/web/auth/start', headers: {origin: config.publicOrigin, 'x-multai-client': 'web'}, payload: {codeChallenge: pkceChallenge(secret() + secret()), callbackUri: 'https://foreign.invalid/app/auth'}});
    assert.equal(rejected.statusCode, 400, 'clients cannot choose a completion destination');
    assert.equal(signInClients(config).find(client => client.kind === 'web')!.callbackUri, `${config.publicOrigin}/app/auth`);
  });
}
