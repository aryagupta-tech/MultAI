import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { WebSocket } from 'ws';
import { CollaborationService } from '../src/collaboration.js';
import { createTestContext, seedActor } from './helpers.js';

async function eventually(condition: () => boolean, timeout = 3000): Promise<void> {
  const deadline = Date.now() + timeout;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error('Live connection condition timed out.');
    await new Promise(resolve => setTimeout(resolve, 20));
  }
}

function collect(socket: WebSocket) {
  const messages: {type: string; event: {sequence: number; payload: unknown}}[] = [];
  socket.on('message', data => {const message = JSON.parse(data.toString()) as typeof messages[number]; if (message.type === 'event') messages.push(message);});
  return messages;
}
function presenceOf(socket: WebSocket) {
  const updates: {userId: string; typing: boolean; viewing: string | null}[][] = [];
  socket.on('message', data => {const message = JSON.parse(data.toString()) as {type: string; participants?: typeof updates[number]}; if (message.type === 'presence') updates.push(message.participants!);});
  return updates;
}

async function connect(address: string, path: string, token?: string, origin?: string) {
  const socket = new WebSocket(`${address.replace('http:', 'ws:')}${path}`, {headers: {
    ...(token ? {authorization: `Bearer ${token}`} : {}),
    ...(origin ? {origin} : {}),
  }});
  await new Promise<void>((resolve,reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  return socket;
}

test('live stream replays from cursor, sends new events once, and closes on sign-out', async t => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const owner = await seedActor(ctx.db);
  const service = new CollaborationService(ctx.db);
  const created = await ctx.app.inject({method: 'POST', url: '/v1/sessions', headers: {authorization: `Bearer ${owner.token}`}, payload: {requestId: randomUUID(), message: {kind: 'discussion', text: 'First discussion'}}});
  assert.equal(created.statusCode, 201);
  const id = created.json().session.id as string;
  const address = await ctx.app.listen({port: 0, host: '127.0.0.1'});
  const socket = await connect(address, `/v1/sessions/${id}/live?after=1`, owner.token);
  t.after(() => socket.terminate());
  const events = collect(socket);
  await eventually(() => events.length === 1);
  assert.equal(events[0]?.event.sequence, 2);
  await service.postMessage(owner.actor, id, {requestId: randomUUID(), kind: 'discussion', text: 'Next discussion'});
  await eventually(() => events.length === 2);
  assert.deepEqual(events.map(item => item.event.sequence), [2, 3]);
  const logout = await ctx.app.inject({method: 'POST', url: '/v1/auth/logout', headers: {authorization: `Bearer ${owner.token}`}});
  assert.equal(logout.statusCode, 204);
  await eventually(() => socket.readyState === 3);
  const replay = await ctx.app.inject({url: `/v1/sessions/${id}/events`, headers: {authorization: `Bearer ${owner.token}`}});
  assert.equal(replay.statusCode, 401);
});

test('revocation closes an already connected participant and denies later replay', async t => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const owner = await seedActor(ctx.db, 'Owner');
  const guest = await seedActor(ctx.db, 'Guest');
  const service = new CollaborationService(ctx.db);
  const create = await ctx.app.inject({method: 'POST', url: '/v1/sessions', headers: {authorization: `Bearer ${owner.token}`}, payload: {requestId: randomUUID(), message: {kind: 'discussion', text: 'Shared'}}});
  const id = create.json().session.id as string;
  const invitation = await service.createInvitation(owner.actor, id, {});
  const join = await service.requestJoin(guest.actor, {token: invitation.invitation.token});
  assert.ok('requestId' in join);
  await service.admit(owner.actor, id, join.requestId!, {role: 'collaborator'});
  const address = await ctx.app.listen({port: 0, host: '127.0.0.1'});
  const socket = await connect(address, `/v1/sessions/${id}/live`, guest.token);
  t.after(() => socket.terminate());
  const messages = collect(socket);
  await eventually(() => messages.length > 0);
  await service.revokeParticipant(owner.actor, id, guest.actor.userId);
  await eventually(() => socket.readyState === 3);
  const replay = await ctx.app.inject({url: `/v1/sessions/${id}/events`, headers: {authorization: `Bearer ${guest.token}`}});
  assert.equal(replay.statusCode, 403);
});

test('live transport denies browser origins, missing bearer and invalid replay cursor', async t => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const owner = await seedActor(ctx.db);
  const create = await ctx.app.inject({method: 'POST', url: '/v1/sessions', headers: {authorization: `Bearer ${owner.token}`}, payload: {requestId: randomUUID(), message: {kind: 'discussion', text: 'Private'}}});
  const id = create.json().session.id as string;
  const address = await ctx.app.listen({port: 0, host: '127.0.0.1'});
  await assert.rejects(connect(address, `/v1/sessions/${id}/live`, owner.token, 'https://untrusted.example'), /403/);
  await assert.rejects(connect(address, `/v1/sessions/${id}/live`), /401/);
  await assert.rejects(connect(address, `/v1/sessions/${id}/live?after=999`, owner.token), /409/);
});

test('health separates database readiness, unconfigured identity and host-local inference', async t => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const ready = await ctx.app.inject('/health/ready');
  assert.equal(ready.statusCode, 200);
  assert.deepEqual(ready.json(), {database: 'ready', identity: 'not_configured', inference: 'host_local'});
  assert.equal(ready.headers['cache-control'], 'no-store');
  const response = await ctx.app.inject({method: 'POST', url: '/v1/auth/google/start', payload: {codeChallenge: 'secret-invalid-body'}});
  assert.equal(response.statusCode, 400);
  assert.ok(!response.body.includes('secret-invalid-body'));
});

test('presence: who is online, typing and viewing reaches everyone in the session, and leaving is seen', async t => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const owner = await seedActor(ctx.db, 'Owner');
  const guest = await seedActor(ctx.db, 'Guest');
  const service = new CollaborationService(ctx.db);
  const create = await ctx.app.inject({method: 'POST', url: '/v1/sessions', headers: {authorization: `Bearer ${owner.token}`}, payload: {requestId: randomUUID(), message: {kind: 'discussion', text: 'Shared'}}});
  const id = create.json().session.id as string;
  const invitation = await service.createInvitation(owner.actor, id, {});
  const join = await service.requestJoin(guest.actor, {token: invitation.invitation.token});
  assert.ok('requestId' in join);
  await service.admit(owner.actor, id, join.requestId!, {role: 'viewer'});
  const address = await ctx.app.listen({port: 0, host: '127.0.0.1'});
  const hostSocket = await connect(address, `/v1/sessions/${id}/live`, owner.token);
  t.after(() => hostSocket.terminate());
  const seen = presenceOf(hostSocket);
  await eventually(() => seen.at(-1)?.length === 1);
  const guestSocket = await connect(address, `/v1/sessions/${id}/live`, guest.token);
  const guestSeen = presenceOf(guestSocket);
  await eventually(() => seen.at(-1)?.length === 2 && guestSeen.length > 0);
  guestSocket.send(JSON.stringify({type: 'presence', typing: true, viewing: 'src/cart.js'}));
  await eventually(() => seen.at(-1)?.some(entry => entry.userId === guest.actor.userId && entry.typing && entry.viewing === 'src/cart.js') ?? false);
  // Too many updates in a second are dropped, not an error.
  for (let i = 0; i < 10; i++) guestSocket.send(JSON.stringify({type: 'presence', typing: false, viewing: null}));
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(guestSocket.readyState, 1);
  guestSocket.terminate();
  await eventually(() => seen.at(-1)?.length === 1 && seen.at(-1)![0]!.userId === owner.actor.userId);
  // Anything other than a presence update ends the stream.
  hostSocket.send('{"type":"event"}');
  await eventually(() => hostSocket.readyState === 3);
});
