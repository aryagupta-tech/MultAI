import assert from 'node:assert/strict';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {mkdtemp, mkdir, writeFile, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {test} from 'node:test';
import type {Config} from '../src/config.js';
import {pkceChallenge, type OidcClient} from '../src/oidc.js';
import {CollaborationService} from '../src/collaboration.js';
import {BrowserReviewService} from '../src/browser-review.js';
import {createTestContext, seedActor, testConfig} from './helpers.js';

// The phone's real signing code (WebCrypto), not a test double. Loaded by URL so this service's own
// TypeScript program does not compile a sibling package.
type Jwk = {kty: 'EC'; crv: 'P-256'; x: string; y: string};
type Envelope = Record<string, unknown> & {requestId: string; issuedAt: number; expiresAt: number};
interface Core {
  generatePhoneKeys(): Promise<{signing: CryptoKeyPair; encryption: CryptoKeyPair}>;
  exportPublic(key: CryptoKey): Promise<Jwk>;
  keyThumbprint(signing: Jwk, encryption: Jwk): Promise<string>;
  verificationCode(pairingId: string, thumbprint: string): Promise<string>;
  buildEnvelope(input: Record<string, unknown>): Envelope;
  signControl(envelope: Envelope, key: CryptoKey): Promise<{envelope: Envelope; signature: string}>;
  verifyControl(signed: {envelope: unknown; signature: string}, key: Jwk): Promise<boolean>;
  normalizePairingCode(code: string): string | null;
}
const core = await import(new URL('../../../packages/companion-core/src/index.ts', import.meta.url).href) as Core;

type Context = Awaited<ReturnType<typeof createTestContext>>;
type Identity = Awaited<ReturnType<typeof seedActor>>;
const bearer = (identity: Identity) => ({authorization: `Bearer ${identity.token}`});
const secret = () => randomBytes(32).toString('base64url');
const ORIGIN = testConfig.publicOrigin;

async function buildSession(ctx: Context, owner: Identity, text = 'Synthetic instruction: fix the fixture.') {
  const create = await ctx.app.inject({method: 'POST', url: '/v1/sessions', headers: bearer(owner), payload: {requestId: randomUUID(), message: {kind: 'instruction', text}}});
  assert.equal(create.statusCode, 201, create.body);
  const id = create.json().session.id as string;
  const changed = await ctx.app.inject({method: 'PATCH', url: `/v1/sessions/${id}/mode`, headers: bearer(owner), payload: {mode: 'build', expectedGeneration: create.json().session.runtimeGeneration}});
  assert.equal(changed.statusCode, 200, changed.body);
  return {id, instructionId: create.json().event.payload.messageId as string};
}

interface Phone {credential: string; keys: Awaited<ReturnType<typeof core.generatePhoneKeys>>; pairingId: string; auth: {authorization: string}}
async function pair(ctx: Context, owner: Identity, sessionIds: string[], name = 'Synthetic Pixel'): Promise<Phone> {
  const created = await ctx.app.inject({method: 'POST', url: '/v1/controller-pairings', headers: bearer(owner), payload: {sessionIds, grantSeconds: 86_400}});
  assert.equal(created.statusCode, 201, created.body);
  const {code, id, link} = created.json().pairing as {code: string; id: string; link: string};
  assert.match(code, /^[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}$/u);
  assert.ok(link.startsWith(`${ORIGIN}/app/#pair=`), 'the code travels only in the URL fragment');
  const keys = await core.generatePhoneKeys();
  const signingKey = await core.exportPublic(keys.signing.publicKey), encryptionKey = await core.exportPublic(keys.encryption.publicKey);
  const credential = secret();
  const claim = await ctx.app.inject({method: 'POST', url: '/v1/controller/claim', payload: {code: code.toLowerCase(), requestId: randomUUID(), credential, deviceName: name, platform: 'android', signingKey, encryptionKey}});
  assert.equal(claim.statusCode, 200, claim.body);
  const thumbprint = await core.keyThumbprint(signingKey, encryptionKey);
  assert.equal(claim.json().pairing.verificationCode, await core.verificationCode(id, thumbprint));
  const detail = await ctx.app.inject({method: 'GET', url: `/v1/controller-pairings/${id}`, headers: bearer(owner)});
  assert.equal(detail.json().pairing.deviceName, name);
  assert.equal(detail.json().pairing.verificationCode, claim.json().pairing.verificationCode);
  const confirmed = await ctx.app.inject({method: 'POST', url: `/v1/controller-pairings/${id}/confirm`, headers: bearer(owner), payload: {keyThumbprint: thumbprint, sessionIds}});
  assert.equal(confirmed.statusCode, 200, confirmed.body);
  return {credential, keys, pairingId: id, auth: {authorization: `Controller ${credential}`}};
}

async function signed(phone: Phone, input: {sessionId: string; runGeneration: number; kind: string; target: object; now?: number; lifetimeMs?: number; requestId?: string}) {
  const envelope = core.buildEnvelope({pairingId: phone.pairingId, sessionId: input.sessionId, runGeneration: input.runGeneration, kind: input.kind as 'stop', target: input.target as Record<string, never>, now: input.now ?? Date.now(), ...(input.lifetimeMs ? {lifetimeMs: input.lifetimeMs} : {}), ...(input.requestId ? {requestId: input.requestId} : {})});
  return core.signControl(envelope, phone.keys.signing.privateKey);
}
const submit = (ctx: Context, phone: Phone, body: unknown) => ctx.app.inject({method: 'POST', url: '/v1/controller/requests', headers: phone.auth, payload: body as object});
const detail = async (ctx: Context, phone: Phone, sessionId: string) => {
  const reply = await ctx.app.inject({method: 'GET', url: `/v1/controller/sessions/${sessionId}`, headers: phone.auth});
  assert.equal(reply.statusCode, 200, reply.body);
  return reply.json();
};

async function startRun(ctx: Context, owner: Identity, sessionId: string, instructionId: string) {
  const generation = (await ctx.app.inject({method: 'GET', url: `/v1/sessions/${sessionId}`, headers: bearer(owner)})).json().session.runtimeGeneration as number;
  const body = {requestId: randomUUID(), connectionId: randomUUID(), model: 'synthetic-fixture-model', instructionId, leaseToken: secret(), expectedGeneration: generation};
  const reply = await ctx.app.inject({method: 'POST', url: `/v1/sessions/${sessionId}/runs`, headers: bearer(owner), payload: body});
  assert.equal(reply.statusCode, 200, reply.body);
  const run = reply.json().run as {id: string; generation: number};
  return {run, body, path: `/v1/sessions/${sessionId}/runs/${run.id}`};
}
async function requestAction(ctx: Context, owner: Identity, sessionId: string, running: Awaited<ReturnType<typeof startRun>>, command = 'npm test') {
  const descriptor = {version: 1, requestId: randomUUID(), sessionId, originalOwnerId: owner.actor.userId, originalDeviceId: owner.actor.deviceId, accountGeneration: 1, sessionGeneration: running.run.generation, runtimeGeneration: running.run.generation, connectionId: running.body.connectionId, payerId: owner.actor.userId, resourceIdentity: `workspace:${sessionId}`, cwd: '/private/synthetic-workspace', expiresAt: Date.now() + 120_000, operation: {kind: 'shell', executable: '/bin/sh', argv: ['-c', command], commandText: command}};
  const reply = await ctx.app.inject({method: 'POST', url: `${running.path}/actions`, headers: bearer(owner), payload: {leaseToken: running.body.leaseToken, descriptor}});
  assert.equal(reply.statusCode, 200, reply.body);
  return reply.json() as {actionId: string; fingerprint: string};
}
/** The same account signed in on another device (an ordinary Google sign-in on a phone). */
async function secondDevice(ctx: Context, owner: Identity): Promise<Identity> {
  const deviceId = randomUUID(), authSessionId = randomUUID(), token = secret();
  await ctx.db.query('INSERT INTO devices (id,user_id,name) VALUES ($1,$2,$3)', [deviceId, owner.actor.userId, 'Synthetic owner phone']);
  await ctx.db.query("INSERT INTO auth_sessions (id,user_id,device_id,expires_at) VALUES ($1,$2,$3,now()+interval '30 days')", [authSessionId, owner.actor.userId, deviceId]);
  await ctx.db.query("INSERT INTO access_tokens (token_hash,auth_session_id,expires_at) VALUES ($1,$2,now()+interval '15 minutes')", [createHash('sha256').update(token).digest('hex'), authSessionId]);
  return {actor: {userId: owner.actor.userId, deviceId, authSessionId}, token, refreshToken: secret()};
}
const hostPoll = async (ctx: Context, owner: Identity) => {
  const reply = await ctx.app.inject({method: 'GET', url: '/v1/host/control-requests?wait=0', headers: bearer(owner)});
  assert.equal(reply.statusCode, 200, reply.body);
  return reply.json().requests as {id: string; pairingId: string; sessionId: string; envelope: {kind: string}; signature: string}[];
};

test('pairing is desktop-initiated, one-use, short-lived and confirmed for an exact key', async t => {
  const ctx = await createTestContext(); t.after(() => ctx.close());
  const owner = await seedActor(ctx.db, 'Synthetic owner');
  const target = await buildSession(ctx, owner);
  const created = await ctx.app.inject({method: 'POST', url: '/v1/controller-pairings', headers: bearer(owner), payload: {sessionIds: [target.id]}});
  const {code, id} = created.json().pairing;
  const keys = await core.generatePhoneKeys();
  const signingKey = await core.exportPublic(keys.signing.publicKey), encryptionKey = await core.exportPublic(keys.encryption.publicKey);
  const claimBody = {code, requestId: randomUUID(), credential: secret(), deviceName: 'Synthetic phone', platform: 'web', signingKey, encryptionKey};
  // Not confirmed yet: the credential is useless.
  const first = await ctx.app.inject({method: 'POST', url: '/v1/controller/claim', payload: claimBody});
  assert.equal(first.statusCode, 200, first.body);
  const retry = await ctx.app.inject({method: 'POST', url: '/v1/controller/claim', payload: claimBody});
  assert.equal(retry.json().pairing.id, first.json().pairing.id, 'a lost answer can be retried with the same claim');
  const second = await ctx.app.inject({method: 'POST', url: '/v1/controller/claim', payload: {...claimBody, requestId: randomUUID(), credential: secret()}});
  assert.equal(second.statusCode, 404, 'the code works once');
  const pending = await ctx.app.inject({method: 'GET', url: `/v1/controller/sessions/${target.id}`, headers: {authorization: `Controller ${claimBody.credential}`}});
  assert.equal(pending.statusCode, 403);
  assert.equal(pending.json().error.code, 'controller_pending');
  const status = await ctx.app.inject({method: 'GET', url: '/v1/controller/status', headers: {authorization: `Controller ${claimBody.credential}`}});
  assert.equal(status.json().pairing.status, 'awaiting_confirmation');
  // A substituted key or a wider scope cannot be confirmed.
  const wrongKey = await ctx.app.inject({method: 'POST', url: `/v1/controller-pairings/${id}/confirm`, headers: bearer(owner), payload: {keyThumbprint: 'f'.repeat(64), sessionIds: [target.id]}});
  assert.equal(wrongKey.statusCode, 409);
  const other = await buildSession(ctx, owner);
  const wider = await ctx.app.inject({method: 'POST', url: `/v1/controller-pairings/${id}/confirm`, headers: bearer(owner), payload: {keyThumbprint: await core.keyThumbprint(signingKey, encryptionKey), sessionIds: [target.id, other.id]}});
  assert.equal(wider.statusCode, 409);
  const declined = await ctx.app.inject({method: 'POST', url: `/v1/controller-pairings/${id}/decline`, headers: bearer(owner)});
  assert.equal(declined.json().pairing.status, 'declined');
  const after = await ctx.app.inject({method: 'GET', url: '/v1/controller/status', headers: {authorization: `Controller ${claimBody.credential}`}});
  assert.equal(after.statusCode, 403, 'a declined phone has no access');
  // An expired code cannot be claimed.
  const late = await ctx.app.inject({method: 'POST', url: '/v1/controller-pairings', headers: bearer(owner), payload: {sessionIds: [target.id]}});
  await ctx.db.query("UPDATE controller_pairings SET code_expires_at=now()-interval '1 second' WHERE id=$1", [late.json().pairing.id]);
  const expired = await ctx.app.inject({method: 'POST', url: '/v1/controller/claim', payload: {...claimBody, code: late.json().pairing.code, requestId: randomUUID(), credential: secret()}});
  assert.equal(expired.statusCode, 404);
  // Only hashes are stored.
  const stored = await ctx.db.query('SELECT code_hash,token_hash FROM controller_pairings WHERE id=$1', [id]);
  assert.equal(stored.rows[0].code_hash, createHash('sha256').update(core.normalizePairingCode(code)!).digest('hex'));
  assert.equal(stored.rows[0].token_hash, null, 'declining forgets the credential');
});

test('collaborators, guests, other devices and plain sign-ins never get owner control', async t => {
  const ctx = await createTestContext(); t.after(() => ctx.close());
  const owner = await seedActor(ctx.db, 'Synthetic owner');
  const collaborator = await seedActor(ctx.db, 'Synthetic collaborator');
  const target = await buildSession(ctx, owner);
  const collaboration = new CollaborationService(ctx.db);
  const invitation = await collaboration.createInvitation(owner.actor, target.id, {});
  const join = await collaboration.requestJoin(collaborator.actor, {token: invitation.invitation.token});
  await collaboration.admit(owner.actor, target.id, (join as {requestId: string}).requestId, {role: 'collaborator'});
  // The owner signed in with Google on another device: same account, different device.
  const ownerPhone = await secondDevice(ctx, owner);
  for (const identity of [collaborator, ownerPhone]) {
    const create = await ctx.app.inject({method: 'POST', url: '/v1/controller-pairings', headers: bearer(identity), payload: {sessionIds: [target.id]}});
    assert.equal(create.statusCode, 403, `${create.body}`);
    const state = await ctx.app.inject({method: 'PUT', url: `/v1/sessions/${target.id}/control-state`, headers: bearer(identity), payload: {state: {}}});
    assert.ok([400, 403].includes(state.statusCode));
  }
  const phone = await pair(ctx, owner, [target.id]);
  // The owner's other device sees none of the host's requests and cannot acknowledge them.
  const running = await startRun(ctx, owner, target.id, target.instructionId);
  const stop = await submit(ctx, phone, await signed(phone, {sessionId: target.id, runGeneration: running.run.generation, kind: 'stop', target: {}}));
  assert.equal(stop.statusCode, 201, stop.body);
  assert.equal((await ctx.app.inject({method: 'GET', url: '/v1/host/control-requests', headers: bearer(ownerPhone)})).json().requests.length, 0);
  const ack = await ctx.app.inject({method: 'POST', url: `/v1/host/control-requests/${stop.json().request.id}/ack`, headers: bearer(ownerPhone), payload: {outcome: 'accepted', code: 'stopped'}});
  assert.equal(ack.statusCode, 404);
  const collaboratorAck = await ctx.app.inject({method: 'POST', url: `/v1/host/control-requests/${stop.json().request.id}/ack`, headers: bearer(collaborator), payload: {outcome: 'accepted', code: 'stopped'}});
  assert.equal(collaboratorAck.statusCode, 404);
  // A controller credential is not a native credential, and a native token is not a controller credential.
  for (const url of ['/v1/me', `/v1/sessions/${target.id}`, `/v1/sessions/${target.id}/stop`]) {
    const reply = await ctx.app.inject({method: url.endsWith('stop') ? 'POST' : 'GET', url, headers: {authorization: `Bearer ${phone.credential}`}});
    assert.equal(reply.statusCode, 401, url);
  }
  const asController = await ctx.app.inject({method: 'GET', url: '/v1/controller/status', headers: {authorization: `Controller ${owner.token}`}});
  assert.equal(asController.statusCode, 403);
  // A browser reviewer cannot use controller routes either.
  const review = new BrowserReviewService(ctx.db);
  const reviewInvite = await review.createReviewInvitation(owner.actor, target.id, {});
  const reviewer = secret();
  await review.join({invitationToken: reviewInvite.invitation.token, credential: reviewer, requestId: randomUUID(), name: 'Guest'});
  const guest = await ctx.app.inject({method: 'GET', url: '/v1/controller/status', headers: {authorization: `Controller ${reviewer}`}});
  assert.equal(guest.statusCode, 403);
  const guestRequest = await ctx.app.inject({method: 'POST', url: '/v1/controller/requests', headers: {authorization: `Review ${reviewer}`}, payload: await signed(phone, {sessionId: target.id, runGeneration: running.run.generation, kind: 'stop', target: {}})});
  assert.equal(guestRequest.statusCode, 403);
});

test('requests are bound to session, generation, fingerprint, expiry and signature', async t => {
  const ctx = await createTestContext(); t.after(() => ctx.close());
  const owner = await seedActor(ctx.db, 'Synthetic owner');
  const target = await buildSession(ctx, owner);
  const outside = await buildSession(ctx, owner);
  const phone = await pair(ctx, owner, [target.id]);
  const running = await startRun(ctx, owner, target.id, target.instructionId);
  const action = await requestAction(ctx, owner, target.id, running);
  const view = await detail(ctx, phone, target.id);
  assert.equal(view.pendingAction.actionId, action.actionId);
  assert.equal(view.pendingAction.fingerprint, action.fingerprint);
  assert.equal(view.pendingAction.command, 'npm test');
  assert.equal(view.pendingAction.cwd, undefined, 'host paths stay on the desktop');
  const approve = {actionId: action.actionId, actionFingerprint: action.fingerprint};
  const good = await signed(phone, {sessionId: target.id, runGeneration: running.run.generation, kind: 'approve', target: approve});
  const first = await submit(ctx, phone, good);
  assert.equal(first.statusCode, 201, first.body);
  // Duplicate taps and lost answers return the same request.
  const replies = await Promise.all(Array.from({length: 6}, () => submit(ctx, phone, good)));
  for (const reply of replies) {assert.ok([200, 201].includes(reply.statusCode), reply.body); assert.equal(reply.json().request.id, first.json().request.id);}
  assert.equal((await ctx.db.query('SELECT count(*)::int AS n FROM control_requests')).rows[0].n, 1);
  // Same id, different content: refused.
  const changed = await signed(phone, {sessionId: target.id, runGeneration: running.run.generation, kind: 'reject', target: approve, requestId: good.envelope.requestId});
  assert.equal((await submit(ctx, phone, changed)).statusCode, 409);
  // A tampered field breaks the signature.
  const tampered = {...good, envelope: {...good.envelope, requestId: randomUUID(), target: {...approve, actionFingerprint: 'e'.repeat(64)}}};
  assert.equal((await submit(ctx, phone, tampered)).json().error.code, 'control_signature_invalid');
  // A changed command has a different fingerprint and needs a new approval.
  const wrongFingerprint = await signed(phone, {sessionId: target.id, runGeneration: running.run.generation, kind: 'approve', target: {...approve, actionFingerprint: 'e'.repeat(64)}});
  assert.equal((await submit(ctx, phone, wrongFingerprint)).json().error.code, 'action_changed');
  const stale = await signed(phone, {sessionId: target.id, runGeneration: running.run.generation - 1, kind: 'approve', target: approve});
  assert.equal((await submit(ctx, phone, stale)).json().error.code, 'stale_generation');
  const expired = await signed(phone, {sessionId: target.id, runGeneration: running.run.generation, kind: 'stop', target: {}, now: Date.now() - 130_000});
  assert.equal((await submit(ctx, phone, expired)).json().error.code, 'control_expired');
  const future = await signed(phone, {sessionId: target.id, runGeneration: running.run.generation, kind: 'stop', target: {}, now: Date.now() + 120_000});
  assert.equal((await submit(ctx, phone, future)).json().error.code, 'control_expired');
  const tooLong = {...good, envelope: {...good.envelope, requestId: randomUUID(), expiresAt: good.envelope.issuedAt + 600_000}};
  const resigned = await core.signControl(tooLong.envelope, phone.keys.signing.privateKey);
  assert.equal((await submit(ctx, phone, resigned)).json().error.code, 'control_expired');
  const crossSession = await signed(phone, {sessionId: outside.id, runGeneration: 2, kind: 'stop', target: {}});
  assert.equal((await submit(ctx, phone, crossSession)).statusCode, 403);
  assert.equal((await ctx.app.inject({method: 'GET', url: `/v1/controller/sessions/${outside.id}/events`, headers: phone.auth})).statusCode, 403);
  // Another phone's envelope signed with its own key is refused for this pairing.
  const second = await pair(ctx, owner, [target.id], 'Second phone');
  const foreign = await signed(second, {sessionId: target.id, runGeneration: running.run.generation, kind: 'stop', target: {}});
  assert.equal((await submit(ctx, phone, foreign)).statusCode, 403);
  // Unknown fields are rejected outright.
  const extra = await submit(ctx, phone, {...good, envelope: {...good.envelope, requestId: randomUUID(), shell: 'rm -rf /'}});
  assert.equal(extra.statusCode, 400);
});

test('the host receives, decides and acknowledges; Stop cancels what is still waiting', async t => {
  const ctx = await createTestContext(); t.after(() => ctx.close());
  const owner = await seedActor(ctx.db, 'Synthetic owner');
  const target = await buildSession(ctx, owner);
  const phone = await pair(ctx, owner, [target.id]);
  const other = await pair(ctx, owner, [target.id], 'Tablet');
  const running = await startRun(ctx, owner, target.id, target.instructionId);
  const action = await requestAction(ctx, owner, target.id, running);
  const approve = {actionId: action.actionId, actionFingerprint: action.fingerprint};
  // Two controllers decide at once: both reach the host, which can only honor one.
  const [a, b] = await Promise.all([
    submit(ctx, phone, await signed(phone, {sessionId: target.id, runGeneration: running.run.generation, kind: 'approve', target: approve})),
    submit(ctx, other, await signed(other, {sessionId: target.id, runGeneration: running.run.generation, kind: 'reject', target: approve})),
  ]);
  assert.equal(a.statusCode, 201, a.body); assert.equal(b.statusCode, 201, b.body);
  const delivered = await hostPoll(ctx, owner);
  assert.deepEqual(delivered.map(item => item.id).sort(), [a.json().request.id, b.json().request.id].sort());
  // The host verifies each signature with the key it confirmed.
  const pairings = (await ctx.app.inject({method: 'GET', url: '/v1/controller-pairings', headers: bearer(owner)})).json().pairings as {id: string; signingKey: Jwk}[];
  for (const item of delivered) {
    const key = pairings.find(p => p.id === item.pairingId)!.signingKey;
    assert.ok(await core.verifyControl({envelope: item.envelope, signature: item.signature}, key));
  }
  const status = async (id: string, by = id === b.json().request.id ? other : phone) => (await ctx.app.inject({method: 'GET', url: `/v1/controller/requests/${id}`, headers: by.auth})).json().request.status;
  assert.equal(await status(a.json().request.id), 'delivered', 'delivered is not done: the phone keeps waiting for the host');
  const ok = await ctx.app.inject({method: 'POST', url: `/v1/host/control-requests/${a.json().request.id}/ack`, headers: bearer(owner), payload: {outcome: 'accepted', code: 'approved'}});
  assert.equal(ok.statusCode, 200, ok.body);
  const again = await ctx.app.inject({method: 'POST', url: `/v1/host/control-requests/${a.json().request.id}/ack`, headers: bearer(owner), payload: {outcome: 'accepted', code: 'approved'}});
  assert.equal(again.statusCode, 200, 'a lost acknowledgement can be resent');
  const flipped = await ctx.app.inject({method: 'POST', url: `/v1/host/control-requests/${a.json().request.id}/ack`, headers: bearer(owner), payload: {outcome: 'rejected', code: 'approved'}});
  assert.equal(flipped.statusCode, 409);
  await ctx.app.inject({method: 'POST', url: `/v1/host/control-requests/${b.json().request.id}/ack`, headers: bearer(owner), payload: {outcome: 'rejected', code: 'already_decided', message: 'The approval was already decided.'}});
  assert.equal(await status(a.json().request.id), 'accepted');
  assert.equal(await status(b.json().request.id), 'rejected');
  const events = (await ctx.app.inject({method: 'GET', url: `/v1/sessions/${target.id}/events?after=0`, headers: bearer(owner)})).json().events as {type: string; actorId: string; payload: {deviceName: string; outcome: string}}[];
  const acknowledged = events.filter(event => event.type === 'control.acknowledged');
  assert.equal(acknowledged.length, 2, 'every phone action is visibly attributed in the timeline');
  assert.ok(acknowledged.every(event => event.actorId === owner.actor.userId));
  assert.deepEqual(acknowledged.map(event => event.payload.deviceName).sort(), ['Synthetic Pixel', 'Tablet']);
  // Stop: pending phone requests are canceled; a late host acknowledgement still records what happened.
  const steer = await ctx.app.inject({method: 'POST', url: `/v1/sessions/${target.id}/messages`, headers: bearer(owner), payload: {requestId: randomUUID(), kind: 'instruction', text: 'Use cents'}});
  const steerId = steer.json().event.payload.messageId;
  const waiting = await submit(ctx, phone, await signed(phone, {sessionId: target.id, runGeneration: running.run.generation, kind: 'steer', target: {instructionId: steerId}}));
  assert.equal(waiting.statusCode, 201, waiting.body);
  const stopped = await ctx.app.inject({method: 'POST', url: `/v1/sessions/${target.id}/stop`, headers: bearer(owner)});
  assert.equal(stopped.statusCode, 200);
  assert.equal(await status(waiting.json().request.id), 'canceled');
  assert.equal((await hostPoll(ctx, owner)).length, 0, 'nothing canceled is delivered later');
  const lateApprove = await submit(ctx, phone, await signed(phone, {sessionId: target.id, runGeneration: running.run.generation, kind: 'approve', target: approve}));
  assert.equal(lateApprove.statusCode, 409, 'a stopped run’s approval cannot be requested');
  // Audit trail.
  const audit = (await ctx.app.inject({method: 'GET', url: `/v1/controller-pairings/${phone.pairingId}/audit`, headers: bearer(owner)})).json().audit as {event: string}[];
  for (const event of ['pairing.created', 'pairing.claimed', 'pairing.confirmed', 'request.submitted', 'request.accepted']) assert.ok(audit.some(item => item.event === event), event);
});

test('start and conflict decisions bind the exact queue the owner reviewed', async t => {
  const ctx = await createTestContext(); t.after(() => ctx.close());
  const owner = await seedActor(ctx.db, 'Synthetic owner');
  const collaborator = await seedActor(ctx.db, 'Synthetic collaborator');
  const target = await buildSession(ctx, owner);
  const collaboration = new CollaborationService(ctx.db);
  const invitation = await collaboration.createInvitation(owner.actor, target.id, {});
  const join = await collaboration.requestJoin(collaborator.actor, {token: invitation.invitation.token});
  await collaboration.admit(owner.actor, target.id, (join as {requestId: string}).requestId, {role: 'collaborator'});
  const phone = await pair(ctx, owner, [target.id]);
  let view = await detail(ctx, phone, target.id);
  assert.equal(view.queue.requiresReview, false);
  const start = await signed(phone, {sessionId: target.id, runGeneration: view.session.runtimeGeneration, kind: 'start', target: {instructionId: target.instructionId, queueFingerprint: view.queue.fingerprint}});
  assert.equal((await submit(ctx, phone, start)).statusCode, 201);
  // A teammate adds a different direction: the reviewed queue changed.
  await ctx.app.inject({method: 'POST', url: `/v1/sessions/${target.id}/messages`, headers: bearer(collaborator), payload: {requestId: randomUUID(), kind: 'instruction', text: 'Use floats instead'}});
  const staleStart = await signed(phone, {sessionId: target.id, runGeneration: view.session.runtimeGeneration, kind: 'start', target: {instructionId: target.instructionId, queueFingerprint: view.queue.fingerprint}});
  assert.equal((await submit(ctx, phone, staleStart)).json().error.code, 'stale_resolution');
  view = await detail(ctx, phone, target.id);
  assert.equal(view.queue.requiresReview, true);
  // Authors show their names; the owner is marked as the host.
  assert.deepEqual(view.queue.pending.map((item: {author: string}) => item.author), ['Synthetic owner (host)', 'Synthetic collaborator']);
  const plainStart = await signed(phone, {sessionId: target.id, runGeneration: view.session.runtimeGeneration, kind: 'start', target: {instructionId: target.instructionId, queueFingerprint: view.queue.fingerprint}});
  assert.equal((await submit(ctx, phone, plainStart)).json().error.code, 'instruction_conflict', 'conflicting directions need a decision');
  const resolve = await signed(phone, {sessionId: target.id, runGeneration: view.session.runtimeGeneration, kind: 'resolve', target: {instructionId: target.instructionId, queueFingerprint: view.queue.fingerprint, resolution: 'Use integer cents.'}});
  assert.equal((await submit(ctx, phone, resolve)).statusCode, 201);
  // The host's own start with that resolution and fingerprint is what the service accepts.
  const generation = view.session.runtimeGeneration;
  const hostStart = await ctx.app.inject({method: 'POST', url: `/v1/sessions/${target.id}/runs`, headers: bearer(owner), payload: {requestId: randomUUID(), connectionId: randomUUID(), model: 'synthetic-fixture-model', instructionId: target.instructionId, leaseToken: secret(), expectedGeneration: generation, resolution: 'Use integer cents.', resolutionFingerprint: view.queue.fingerprint}});
  assert.equal(hostStart.statusCode, 200, hostStart.body);
  const pendingAfter = (await detail(ctx, phone, target.id)).queue.pending;
  assert.equal(pendingAfter.length, 0, 'unchosen directions never run later');
});

test('revocation, grant expiry and session deletion take effect immediately', async t => {
  const ctx = await createTestContext(); t.after(() => ctx.close());
  const owner = await seedActor(ctx.db, 'Synthetic owner');
  const target = await buildSession(ctx, owner);
  const phone = await pair(ctx, owner, [target.id]);
  const running = await startRun(ctx, owner, target.id, target.instructionId);
  const waiting = await submit(ctx, phone, await signed(phone, {sessionId: target.id, runGeneration: running.run.generation, kind: 'stop', target: {}}));
  assert.equal(waiting.statusCode, 201);
  const revoked = await ctx.app.inject({method: 'DELETE', url: `/v1/controller-pairings/${phone.pairingId}`, headers: bearer(owner)});
  assert.equal(revoked.statusCode, 200);
  const after = await ctx.app.inject({method: 'GET', url: '/v1/controller/status', headers: phone.auth});
  assert.equal(after.statusCode, 403);
  assert.equal(after.json().error.code, 'controller_revoked');
  assert.equal((await hostPoll(ctx, owner)).length, 0, 'a revoked phone’s waiting request is never delivered');
  assert.equal((await ctx.db.query('SELECT status FROM control_requests WHERE id=$1', [waiting.json().request.id])).rows[0].status, 'canceled');
  // Grant expiry.
  const second = await pair(ctx, owner, [target.id], 'Expiring phone');
  await ctx.db.query("UPDATE controller_pairings SET expires_at=now()-interval '1 second' WHERE id=$1", [second.pairingId]);
  const expired = await ctx.app.inject({method: 'GET', url: '/v1/controller/status', headers: second.auth});
  assert.equal(expired.json().error.code, 'controller_expired');
  // The phone can remove itself.
  const third = await pair(ctx, owner, [target.id], 'Self-removing phone');
  assert.equal((await ctx.app.inject({method: 'POST', url: '/v1/controller/unpair', headers: third.auth, payload: {}})).statusCode, 200);
  assert.equal((await ctx.app.inject({method: 'GET', url: '/v1/controller/status', headers: third.auth})).statusCode, 403);
  // Revoking the host device itself ends every pairing it made.
  const fourth = await pair(ctx, owner, [target.id], 'Host-revoked phone');
  await ctx.db.query('UPDATE devices SET revoked_at=now() WHERE id=$1', [owner.actor.deviceId]);
  assert.equal((await ctx.app.inject({method: 'GET', url: '/v1/controller/status', headers: fourth.auth})).statusCode, 403);
  await ctx.db.query('UPDATE devices SET revoked_at=NULL WHERE id=$1', [owner.actor.deviceId]);
  // Deleting the session revokes a pairing that covered only it.
  const fifth = await pair(ctx, owner, [target.id], 'Deleted-session phone');
  await ctx.app.inject({method: 'POST', url: `/v1/sessions/${target.id}/stop`, headers: bearer(owner)});
  await ctx.db.query("UPDATE sessions SET status='inactive' WHERE id=$1", [target.id]);
  const challenge = await ctx.app.inject({method: 'POST', url: `/v1/sessions/${target.id}/deletion-challenge`, headers: bearer(owner)});
  const deleted = await ctx.app.inject({method: 'DELETE', url: `/v1/sessions/${target.id}`, headers: bearer(owner), payload: {confirmationToken: challenge.json().confirmationToken}});
  assert.equal(deleted.statusCode, 200, deleted.body);
  assert.equal((await ctx.app.inject({method: 'GET', url: '/v1/controller/status', headers: fifth.auth})).statusCode, 403);
  assert.equal((await ctx.db.query('SELECT count(*)::int AS n FROM control_requests WHERE session_id=$1', [target.id])).rows[0].n, 0);
});

test('host state reports are host-only, validated and age-stamped for the phone', async t => {
  const ctx = await createTestContext(); t.after(() => ctx.close());
  const owner = await seedActor(ctx.db, 'Synthetic owner');
  const target = await buildSession(ctx, owner);
  const phone = await pair(ctx, owner, [target.id]);
  assert.equal((await detail(ctx, phone, target.id)).host, null, 'no report means unknown, never online');
  const state = {v: 1, host: 'online', runtimeGeneration: 2, run: {status: 'idle', runId: null, at: Date.now()}, approval: null, access: 'ask', model: 'synthetic-model', locked: 0};
  assert.equal((await ctx.app.inject({method: 'PUT', url: `/v1/sessions/${target.id}/control-state`, headers: bearer(owner), payload: {state}})).statusCode, 200);
  const view = await detail(ctx, phone, target.id);
  assert.equal(view.host.state.host, 'online');
  assert.ok(view.host.ageMs < 5_000);
  const bad = await ctx.app.inject({method: 'PUT', url: `/v1/sessions/${target.id}/control-state`, headers: bearer(owner), payload: {state: {...state, shell: '/bin/sh'}}});
  assert.equal(bad.statusCode, 400, 'unknown fields cannot smuggle anything to the phone');
  // Participants see only the coarse state; outsiders see nothing.
  const viewer = await seedActor(ctx.db, 'Synthetic viewer');
  const outsider = await seedActor(ctx.db, 'Synthetic outsider');
  const collaboration = new CollaborationService(ctx.db);
  const invitation = await collaboration.createInvitation(owner.actor, target.id, {});
  const join = await collaboration.requestJoin(viewer.actor, {token: invitation.invitation.token});
  await collaboration.admit(owner.actor, target.id, (join as {requestId: string}).requestId, {role: 'viewer'});
  const presence = await ctx.app.inject({method: 'GET', url: `/v1/sessions/${target.id}/host-presence`, headers: bearer(viewer)});
  assert.equal(presence.statusCode, 200, presence.body);
  assert.deepEqual(presence.json().report.state, {host: 'online', run: {status: 'idle'}, locked: 0});
  assert.equal(presence.json().connected, false);
  assert.equal(JSON.stringify(presence.json()).includes('synthetic-model'), false, 'nothing beyond the coarse state');
  assert.equal((await ctx.app.inject({method: 'GET', url: `/v1/sessions/${target.id}/host-presence`, headers: bearer(outsider)})).statusCode, 403);
  await ctx.db.query("UPDATE host_control_state SET updated_at=now()-interval '5 minutes' WHERE session_id=$1", [target.id]);
  assert.ok((await detail(ctx, phone, target.id)).host.ageMs >= 299_000, 'a stale report reads as offline on the phone');
});

test('browser cookies are HttpOnly, SameSite=Strict and refused without the page origin', async t => {
  const ctx = await createTestContext(); t.after(() => ctx.close());
  const owner = await seedActor(ctx.db, 'Synthetic owner');
  const target = await buildSession(ctx, owner);
  const created = await ctx.app.inject({method: 'POST', url: '/v1/controller-pairings', headers: bearer(owner), payload: {sessionIds: [target.id]}});
  const keys = await core.generatePhoneKeys();
  const credential = secret();
  const body = {code: created.json().pairing.code, requestId: randomUUID(), credential, deviceName: 'Safari on iPhone', platform: 'ios', signingKey: await core.exportPublic(keys.signing.publicKey), encryptionKey: await core.exportPublic(keys.encryption.publicKey)};
  const forged = await ctx.app.inject({method: 'POST', url: '/v1/controller/claim', headers: {'x-multai-client': 'web', origin: 'https://evil.example'}, payload: body});
  assert.equal(forged.statusCode, 403);
  const claim = await ctx.app.inject({method: 'POST', url: '/v1/controller/claim', headers: {'x-multai-client': 'web', host:new URL(ORIGIN).host,origin: ORIGIN}, payload: body});
  assert.equal(claim.statusCode, 200, claim.body);
  const cookie = String(claim.headers['set-cookie']);
  assert.match(cookie, /^multai_controller=[A-Za-z0-9_-]{43}; Path=\/v1\/controller; Max-Age=\d+; HttpOnly; SameSite=Strict$/u);
  assert.ok(!claim.body.includes(credential), 'the credential is never echoed back');
  const jar = {host:new URL(ORIGIN).host,cookie: `multai_controller=${credential}`};
  const noOrigin = await ctx.app.inject({method: 'GET', url: '/v1/controller/status', headers: jar});
  assert.equal(noOrigin.statusCode, 403, 'a cookie alone is not enough (CSRF)');
  const crossSite = await ctx.app.inject({method: 'GET', url: '/v1/controller/status', headers: {...jar, origin: 'https://evil.example', 'x-multai-client': 'web'}});
  assert.equal(crossSite.statusCode, 403);
  const noHeader = await ctx.app.inject({method: 'GET', url: '/v1/controller/status', headers: {...jar, host:new URL(ORIGIN).host,origin: ORIGIN}});
  assert.equal(noHeader.statusCode, 403);
  const ok = await ctx.app.inject({method: 'GET', url: '/v1/controller/status', headers: {...jar, host:new URL(ORIGIN).host,origin: ORIGIN, 'x-multai-client': 'web'}});
  assert.equal(ok.statusCode, 200, ok.body);
  // Browsers omit Origin on same-origin GETs; the custom header and Sec-Fetch-Site decide.
  const sameOriginGet = await ctx.app.inject({method: 'GET', url: '/v1/controller/status', headers: {...jar, 'x-multai-client': 'web', 'sec-fetch-site': 'same-origin'}});
  assert.equal(sameOriginGet.statusCode, 200, sameOriginGet.body);
  const crossSiteGet = await ctx.app.inject({method: 'GET', url: '/v1/controller/status', headers: {...jar, 'x-multai-client': 'web', 'sec-fetch-site': 'cross-site'}});
  assert.equal(crossSiteGet.statusCode, 403);
  const noOriginPost = await ctx.app.inject({method: 'POST', url: '/v1/controller/unpair', headers: {...jar, 'x-multai-client': 'web'}, payload: {}});
  assert.equal(noOriginPost.statusCode, 403, 'a cookie POST must name its origin');
  const forget = await ctx.app.inject({method: 'POST', url: '/v1/controller/forget', headers: {host:new URL(ORIGIN).host,origin: ORIGIN, 'x-multai-client': 'web'}, payload: {}});
  assert.match(String(forget.headers['set-cookie']), /Max-Age=0/u);
});

test('Android app origin gets CORS for header-authenticated routes only', async t => {
  const ctx = await createTestContext({config: {...testConfig, companionOrigins: ['https://localhost']}}); t.after(() => ctx.close());
  const preflight = await ctx.app.inject({method: 'OPTIONS', url: '/v1/controller/status', headers: {origin: 'https://localhost', 'access-control-request-method': 'GET'}});
  assert.equal(preflight.statusCode, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], 'https://localhost');
  assert.equal(preflight.headers['access-control-allow-credentials'], undefined, 'never with credentials');
  const evil = await ctx.app.inject({method: 'OPTIONS', url: '/v1/controller/status', headers: {origin: 'https://evil.example', 'access-control-request-method': 'GET'}});
  assert.equal(evil.headers['access-control-allow-origin'], undefined);
  const cookieRoute = await ctx.app.inject({method: 'OPTIONS', url: '/v1/web/auth/refresh', headers: {origin: 'https://localhost', 'access-control-request-method': 'POST'}});
  assert.equal(cookieRoute.headers['access-control-allow-origin'], undefined, 'cookie routes are same-origin only');
});

test('the browser companion is served with a strict policy and nothing outside its build', async t => {
  const folder = await mkdtemp(path.join(tmpdir(), 'multai-companion-'));
  t.after(() => rm(folder, {recursive: true, force: true}));
  await mkdir(path.join(folder, 'assets'));
  await writeFile(path.join(folder, 'index.html'), '<!doctype html><title>MultAI</title><script type="module" src="/app/assets/app-abc.js"></script>');
  await writeFile(path.join(folder, 'assets', 'app-abc.js'), 'console.log(1)');
  await writeFile(path.join(folder, 'manifest.webmanifest'), '{}');
  await mkdir(path.join(folder,'downloads'));
  await writeFile(path.join(folder,'downloads','latest.json'),JSON.stringify({file:'multai-companion-0.1.2.apk'}));
  await writeFile(path.join(folder,'downloads','multai-companion-0.1.2.apk'),Buffer.from('PK synthetic APK transport fixture'));
  await writeFile(path.join(folder,'downloads','multai-companion-0.1.2.apk.sha256'),'synthetic checksum');
  const ctx = await createTestContext({config: {...testConfig, companionDirectory: folder, androidCertificates: [Array.from({length: 32}, () => 'AB').join(':')]}}); t.after(() => ctx.close());
  const index = await ctx.app.inject({method: 'GET', url: '/app/'});
  assert.equal(index.statusCode, 200);
  assert.match(String(index.headers['content-security-policy']), /script-src 'self';/u);
  assert.doesNotMatch(String(index.headers['content-security-policy']), /unsafe/u);
  assert.equal(index.headers['cache-control'], 'no-cache');
  const deep = await ctx.app.inject({method: 'GET', url: '/app/sessions/123'});
  assert.equal(deep.statusCode, 200, 'app routes load the app');
  const browserCallback = await ctx.app.inject({method: 'GET', url: '/app/auth'});
  assert.equal(browserCallback.statusCode, 200, 'the browser-only completion path loads the companion');
  assert.equal(browserCallback.body, index.body);
  assert.equal(browserCallback.headers['content-security-policy'], index.headers['content-security-policy']);
  const asset = await ctx.app.inject({method: 'GET', url: '/app/assets/app-abc.js'});
  assert.equal(asset.headers['cache-control'], 'public, max-age=31536000, immutable');
  const download=await ctx.app.inject({method:'GET',url:'/app/android'});
  assert.equal(download.statusCode,302);
  assert.equal(download.headers.location,'/app/downloads/multai-companion-0.1.2.apk');
  assert.equal(download.headers['cache-control'],'no-store');
  const apk=await ctx.app.inject({method:'GET',url:download.headers.location});
  assert.equal(apk.headers['content-type'],'application/vnd.android.package-archive');
  assert.equal(apk.headers['content-disposition'],'attachment');
  assert.equal(apk.body,'PK synthetic APK transport fixture');
  assert.equal((await ctx.app.inject({method:'GET',url:'/app/downloads/multai-companion-0.1.2.apk.sha256'})).body,'synthetic checksum');
  await writeFile(path.join(folder,'downloads','latest.json'),JSON.stringify({file:'../../private.apk'}));
  const invalid=await createTestContext({config:{...testConfig,companionDirectory:folder}});t.after(()=>invalid.close());
  assert.equal((await invalid.app.inject({method:'GET',url:'/app/android'})).statusCode,404,'malformed release metadata cannot select arbitrary files');
  for (const url of ['/app/../src/app.ts', '/app/%2e%2e/package.json', '/app/assets/missing.js', '/app/.env']) {
    const reply = await ctx.app.inject({method: 'GET', url});
    assert.ok(reply.statusCode === 404 || (reply.statusCode === 200 && reply.body.includes('<title>MultAI')), `${url} ${reply.statusCode}`);
    assert.ok(!reply.body.includes('import'), url);
  }
  const links = await ctx.app.inject({method: 'GET', url: '/.well-known/assetlinks.json'});
  assert.equal(links.json()[0].target.package_name, 'si.multai.companion');
});

/** Synthetic provider double: no real Google identity. */
const oidc: OidcClient = {
  authorizationUrl(input) {const url = new URL('https://synthetic.invalid/authorize'); url.searchParams.set('state', input.state); return url.toString();},
  async exchange() {return {subject: 'synthetic-phone-person', displayName: 'Synthetic phone person'};},
};
test('browser and Android sign-ins use the same Google redirect and hand off in a fragment', async t => {
  const config: Config = {...testConfig, googleClientId: 'synthetic-client', googleClientSecret: 'synthetic-secret', googleRedirectUri: `${ORIGIN}/v1/auth/google/callback`};
  const ctx = await createTestContext({config, oidc}); t.after(() => ctx.close());
  const web = {host:new URL(ORIGIN).host,origin: ORIGIN, 'x-multai-client': 'web'};
  const verifier = secret() + secret();
  assert.equal((await ctx.app.inject({method: 'POST', url: '/v1/web/auth/start', payload: {codeChallenge: pkceChallenge(verifier)}})).statusCode, 403);
  const start = await ctx.app.inject({method: 'POST', url: '/v1/web/auth/start', headers: web, payload: {codeChallenge: pkceChallenge(verifier)}});
  assert.equal(start.statusCode, 200, start.body);
  const state = new URL(start.json().authorizationUrl).searchParams.get('state')!;
  const callback = await ctx.app.inject({method: 'GET', url: `/v1/auth/google/callback?state=${state}&code=synthetic`});
  assert.equal(callback.statusCode, 303);
  const location = String(callback.headers.location);
  assert.ok(location.startsWith(`${ORIGIN}/app/auth#signin=`), location);
  assert.ok(!location.split('#')[0]!.includes('signin'), 'nothing secret in the query string');
  const [flowId, completionCode] = location.split('#signin=')[1]!.split('.');
  // A web flow cannot be completed through the native exchange.
  const native = await ctx.app.inject({method: 'POST', url: '/v1/auth/google/exchange', payload: {flowId, completionCode, codeVerifier: verifier, deviceName: 'x'}});
  assert.equal(native.statusCode, 401);
  const exchange = await ctx.app.inject({method: 'POST', url: '/v1/web/auth/exchange', headers: web, payload: {flowId, completionCode, codeVerifier: verifier, deviceName: 'Safari on iPhone'}});
  assert.equal(exchange.statusCode, 200, exchange.body);
  assert.equal(exchange.json().refreshToken, undefined, 'the refresh token never reaches page script');
  const cookie = String(exchange.headers['set-cookie']);
  assert.match(cookie, /^multai_web_refresh=[A-Za-z0-9_-]{43}; Path=\/v1\/web\/auth; Max-Age=\d+; HttpOnly; SameSite=Strict$/u);
  const refreshCookie = cookie.split(';')[0]!;
  const me = await ctx.app.inject({method: 'GET', url: '/v1/me', headers: {authorization: `Bearer ${exchange.json().accessToken}`}});
  assert.equal(me.json().displayName, 'Synthetic phone person');
  // A browser sign-in is a new device: it sees none of a desktop host's control requests.
  const browser = {token: exchange.json().accessToken} as Identity;
  assert.equal((await ctx.app.inject({method: 'GET', url: '/v1/host/control-requests', headers: bearer(browser)})).json().requests.length, 0);
  assert.equal((await ctx.app.inject({method: 'POST', url: '/v1/web/auth/refresh', headers: {cookie: refreshCookie}})).statusCode, 403, 'CSRF: cookie without origin');
  const refreshed = await ctx.app.inject({method: 'POST', url: '/v1/web/auth/refresh', headers: {...web, cookie: refreshCookie}, payload: {}});
  assert.equal(refreshed.statusCode, 200, refreshed.body);
  const logout = await ctx.app.inject({method: 'POST', url: '/v1/web/auth/logout', headers: {...web, cookie: String(refreshed.headers['set-cookie']).split(';')[0]!}, payload: {}});
  assert.equal(logout.statusCode, 204);
  assert.match(String(logout.headers['set-cookie']), /Max-Age=0/u);
  // Android uses a custom-scheme callback and the fragment, too.
  const android = await ctx.app.inject({method: 'POST', url: '/v1/auth/google/start', payload: {codeChallenge: pkceChallenge(verifier), client: 'android'}});
  const androidState = new URL(android.json().authorizationUrl).searchParams.get('state')!;
  const page = await ctx.app.inject({method: 'GET', url: `/v1/auth/google/callback?state=${androidState}&code=synthetic`});
  assert.equal(page.statusCode, 200);
  assert.match(page.body, /multai-companion-dev:\/\/auth\/callback#signin=/u);
  assert.match(page.body, /MultAI Companion/u);
});
