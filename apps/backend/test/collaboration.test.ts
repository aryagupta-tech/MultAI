import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { CollaborationService } from '../src/collaboration.js';
import { ApiError } from '../src/errors.js';
import { createTestContext, seedActor } from './helpers.js';

const hasCode = (code: string) => (error: unknown) => error instanceof ApiError && error.code === code;

test('first send is durably idempotent under concurrent PostgreSQL requests', async (t) => {
  const context = await createTestContext(); t.after(context.close);
  const owner = await seedActor(context.db);
  const headers = {authorization: `Bearer ${owner.token}`};
  const payload = {requestId: randomUUID(), message: {kind: 'instruction', text: 'Create a fresh backend.'}};
  const responses = await Promise.all(Array.from({length: 16}, () => context.app.inject({method: 'POST',url: '/v1/sessions',headers,payload})));
  for (const response of responses) {
    assert.equal(response.statusCode, 201, response.body);
    assert.deepEqual(response.json(), responses[0]!.json());
  }
  const body = responses[0]!.json();
  assert.equal(body.session.mode, 'plan');
  assert.equal(body.session.status, 'inactive');
  assert.equal(body.session.capabilities.execute, true);
  assert.equal(body.session.hostDeviceId, undefined);
  assert.equal(body.event.type, 'message.instruction');
  assert.equal(body.event.payload.queueStatus, 'pending');
  assert.equal((await context.db.query('SELECT * FROM sessions')).rowCount, 1);
  assert.equal((await context.db.query('SELECT * FROM instruction_queue')).rowCount, 1);
  assert.equal((await context.db.query('SELECT * FROM shared_events')).rowCount, 2);
  const conflict = await context.app.inject({method: 'POST',url: '/v1/sessions',headers,payload: {...payload,message: {...payload.message,text: 'Different content'}}});
  assert.equal(conflict.statusCode, 409);
  assert.equal(conflict.json().error.code, 'idempotency_conflict');
});

test('messages stay attributed and strictly ordered; replay pages deduplicate retries', async (t) => {
  const context = await createTestContext(); t.after(context.close);
  const owner = await seedActor(context.db, 'Owner');
  const collaborator = await seedActor(context.db, 'Collaborator');
  const service = new CollaborationService(context.db);
  const initial = await service.createSession(owner.actor, {requestId: randomUUID(),message: {kind: 'discussion',text: 'Discuss first'}}) as {session: {id: string}};
  const sessionId = initial.session.id;
  const invitation = await service.createInvitation(owner.actor, sessionId, {}) as {invitation: {token: string}};
  const join = await service.requestJoin(collaborator.actor, {token: invitation.invitation.token});
  await service.admit(owner.actor, sessionId, join.requestId!, {role: 'collaborator'});
  const sends = Array.from({length: 24}, (_, index) => ({requestId: randomUUID(),kind: index % 2 ? 'instruction' : 'discussion',text: `Message ${index}`}));
  const results = await Promise.all(sends.map((input, index) => service.postMessage(index % 2 ? owner.actor : collaborator.actor, sessionId, input)));
  const retry = await service.postMessage(collaborator.actor, sessionId, sends[0]);
  assert.deepEqual(retry, results[0]);
  let cursor = 0;
  const all = [];
  for (;;) {
    const page = await service.readEvents(collaborator.actor, sessionId, cursor, 7);
    all.push(...page.events);
    if (!page.events.length) break;
    cursor = page.cursor;
  }
  assert.deepEqual(all.map((event) => event.sequence), Array.from({length: all.length}, (_, index) => index + 1));
  assert.equal(new Set(all.map((event) => event.id)).size, all.length);
  assert.equal(all.filter((event) => event.type === 'message.discussion').length, 13);
  assert.equal(all.filter((event) => event.type === 'message.instruction').length, 12);
  const authored = all.find((event) => (event.payload as {text?: string}).text === 'Message 0');
  assert.equal(authored!.actorId, collaborator.actor.userId);
  assert.equal((await context.db.query('SELECT * FROM instruction_queue')).rowCount, 12);
  assert.equal((await service.readEvents(owner.actor, sessionId, cursor)).events.length, 0);
  await assert.rejects(service.readEvents(owner.actor, sessionId, cursor + 1), hasCode('cursor_ahead'));
});

test('invitation possession creates a pending request; admitted viewers remain read-only', async (t) => {
  const context = await createTestContext(); t.after(context.close);
  const owner = await seedActor(context.db, 'Owner');
  const viewer = await seedActor(context.db, 'Viewer');
  const service = new CollaborationService(context.db);
  const created = await service.createSession(owner.actor, {requestId: randomUUID(),message: {kind: 'discussion',text: 'Only owner'}}) as {session: {id: string}};
  const id = created.session.id;
  const invite = await service.createInvitation(owner.actor, id, {});
  const join = await service.requestJoin(viewer.actor, {token: invite.invitation.token});
  assert.equal(join.status, 'pending');
  await assert.rejects(service.readEvents(viewer.actor, id, 0), hasCode('membership_required'));
  const listed = await service.listJoinRequests(owner.actor, id);
  assert.equal(listed.requests[0]!.userId, viewer.actor.userId);
  await service.admit(owner.actor, id, join.requestId!, {role: 'viewer'});
  const snapshot = await service.getSession(viewer.actor, id);
  assert.equal(snapshot.session.role, 'viewer');
  const response = await context.app.inject({
    method: 'POST',url: `/v1/sessions/${id}/messages`,headers: {authorization: `Bearer ${viewer.token}`},
    payload: {requestId: randomUUID(),kind: 'instruction',text: 'Viewer may not execute'},
  });
  assert.equal(response.statusCode, 403);
  assert.equal(response.json().error.code, 'read_only');
  await assert.rejects(service.setMode(viewer.actor, id, {mode: 'build',expectedGeneration: 1}), hasCode('original_host_required'));
  await assert.rejects(service.createInvitation(viewer.actor, id, {}), hasCode('original_host_required'));
  await assert.rejects(service.deletionChallenge(viewer.actor, id), hasCode('original_host_required'));
  assert.equal((await context.db.query('SELECT * FROM instruction_queue')).rowCount, 0);
});

test('expired and revoked invitations cannot join or be admitted', async (t) => {
  const context = await createTestContext(); t.after(context.close);
  const owner = await seedActor(context.db);
  const guest = await seedActor(context.db);
  const service = new CollaborationService(context.db);
  const created = await service.createSession(owner.actor, {requestId: randomUUID(),message: {kind: 'discussion',text: 'Hello'}}) as {session: {id: string}};
  const id = created.session.id;
  const invite = await service.createInvitation(owner.actor, id, {});
  const pending = await service.requestJoin(guest.actor, {token: invite.invitation.token});
  await service.revokeInvitation(owner.actor, id, invite.invitation.id);
  await assert.rejects(service.admit(owner.actor, id, pending.requestId!, {role: 'collaborator'}), hasCode('join_request_unavailable'));
  await assert.rejects(service.requestJoin(guest.actor, {token: invite.invitation.token}), hasCode('invitation_unavailable'));
  const expired = await service.createInvitation(owner.actor, id, {});
  await context.db.query("UPDATE invitations SET expires_at=now()-interval '1 second' WHERE id=$1", [expired.invitation.id]);
  await assert.rejects(service.requestJoin(guest.actor, {token: expired.invitation.token}), hasCode('invitation_unavailable'));
  assert.equal((await service.listJoinRequests(owner.actor, id)).requests.length, 0);
  const stored = await context.db.query<{token_hash: string}>('SELECT token_hash FROM invitations WHERE id=$1', [invite.invitation.id]);
  assert.notEqual(stored.rows[0]!.token_hash, invite.invitation.token);
  assert.match(stored.rows[0]!.token_hash, /^[a-f0-9]{64}$/u);
});

test('revocation closes HTTP and replay access, and old admission cannot resurrect membership', async (t) => {
  const context = await createTestContext(); t.after(context.close);
  const owner = await seedActor(context.db);
  const guest = await seedActor(context.db);
  const service = new CollaborationService(context.db);
  const created = await service.createSession(owner.actor, {requestId: randomUUID(),message: {kind: 'discussion',text: 'Hello'}}) as {session: {id: string}};
  const id = created.session.id;
  const invitation = await service.createInvitation(owner.actor, id, {});
  const join = await service.requestJoin(guest.actor, {token: invitation.invitation.token});
  const otherInvitation = await service.createInvitation(owner.actor, id, {});
  const oldPendingJoin = await service.requestJoin(guest.actor, {token: otherInvitation.invitation.token});
  await service.admit(owner.actor, id, join.requestId!, {role: 'collaborator'});
  await service.postMessage(guest.actor, id, {requestId: randomUUID(),kind: 'discussion',text: 'Before revocation'});
  await service.revokeParticipant(owner.actor, id, guest.actor.userId);
  await assert.rejects(service.readEvents(guest.actor, id, 0), hasCode('membership_required'));
  await assert.rejects(service.postMessage(guest.actor, id, {requestId: randomUUID(),kind: 'discussion',text: 'After revocation'}), hasCode('membership_required'));
  const response = await context.app.inject({method: 'GET',url: `/v1/sessions/${id}`,headers: {authorization: `Bearer ${guest.token}`}});
  assert.equal(response.statusCode, 403);
  await assert.rejects(service.admit(owner.actor, id, join.requestId!, {role: 'collaborator'}), hasCode('admission_revoked'));
  await assert.rejects(service.admit(owner.actor, id, oldPendingJoin.requestId!, {role: 'collaborator'}), hasCode('admission_revoked'));
  assert.equal((await service.listSessions(guest.actor, {})).sessions.length, 0);
});

test('session content capacity retains reserved space for revoking every active grant', async (t) => {
  const context = await createTestContext(); t.after(context.close);
  const owner = await seedActor(context.db);
  const guest = await seedActor(context.db);
  const service = new CollaborationService(context.db);
  const created = await service.createSession(owner.actor, {requestId: randomUUID(),message: {kind: 'discussion',text: 'Hello'}}) as {session: {id: string}};
  const id = created.session.id;
  const invitation = await service.createInvitation(owner.actor, id, {});
  const join = await service.requestJoin(guest.actor, {token: invitation.invitation.token});
  await service.admit(owner.actor, id, join.requestId!, {role: 'viewer'});
  // Synthetic capacity fixture; the production API cannot skip event sequences.
  await context.db.query('UPDATE sessions SET event_sequence=99744 WHERE id=$1', [id]);
  await assert.rejects(service.postMessage(owner.actor, id, {requestId: randomUUID(),kind: 'discussion',text: 'At capacity'}), hasCode('session_capacity'));
  await service.revokeParticipant(owner.actor, id, guest.actor.userId);
  await service.revokeInvitation(owner.actor, id, invitation.invitation.id);
  await assert.rejects(service.getSession(guest.actor, id), hasCode('membership_required'));
  assert.equal((await service.getSession(owner.actor, id)).session.lastSequence, 99746);
});

test('original-host and generation checks protect mode changes and inactive deletion', async (t) => {
  const context = await createTestContext(); t.after(context.close);
  const owner = await seedActor(context.db);
  const service = new CollaborationService(context.db);
  const created = await service.createSession(owner.actor, {requestId: randomUUID(),message: {kind: 'discussion',text: 'Hello'}}) as {session: {id: string}};
  const id = created.session.id;
  const otherHost = {...owner.actor,deviceId: randomUUID(),authSessionId: randomUUID()};
  await context.db.query('INSERT INTO devices(id,user_id,name) VALUES($1,$2,$3)', [otherHost.deviceId, owner.actor.userId, 'Another host']);
  await context.db.query("INSERT INTO auth_sessions(id,user_id,device_id,expires_at) VALUES($1,$2,$3,now()+interval '1 day')", [otherHost.authSessionId, owner.actor.userId, otherHost.deviceId]);
  assert.equal((await service.getSession(otherHost, id)).session.capabilities.manage, false);
  await assert.rejects(service.setMode(otherHost, id, {mode: 'build',expectedGeneration: 1}), hasCode('original_host_required'));
  const changed = await service.setMode(owner.actor, id, {mode: 'build',expectedGeneration: 1});
  assert.equal(changed.session.runtimeGeneration, 2);
  assert.equal(changed.session.capabilities.execute, true);
  await assert.rejects(service.setMode(owner.actor, id, {mode: 'plan',expectedGeneration: 1}), hasCode('stale_generation'));
  await context.db.query("UPDATE sessions SET status='running' WHERE id=$1", [id]);
  await assert.rejects(service.setMode(owner.actor, id, {mode: 'plan',expectedGeneration: 2}), hasCode('session_active'));
  await assert.rejects(service.deletionChallenge(owner.actor, id), hasCode('session_active'));
});

test('confirmed deletion purges shared content, fences retry identities, and exposes only tombstones', async (t) => {
  const context = await createTestContext(); t.after(context.close);
  const owner = await seedActor(context.db);
  const stranger = await seedActor(context.db);
  const service = new CollaborationService(context.db);
  const payload = {requestId: randomUUID(),message: {kind: 'instruction',text: 'Private shared instruction'}};
  const created = await service.createSession(owner.actor, payload) as {session: {id: string}};
  const id = created.session.id;
  const other = await service.createSession(owner.actor, {requestId: randomUUID(),message: {kind: 'discussion',text: 'Keep this session'}}) as {session: {id: string}};
  const invitation = await service.createInvitation(owner.actor, id, {});
  const initialChallenge = await service.deletionChallenge(owner.actor, id);
  await service.setMode(owner.actor, id, {mode: 'build',expectedGeneration: 1});
  await assert.rejects(service.deleteSession(owner.actor, id, {confirmationToken: initialChallenge.confirmationToken}), hasCode('confirmation_required'));
  const challenge = await service.deletionChallenge(owner.actor, id);
  await assert.rejects(service.deleteSession(owner.actor, other.session.id, {confirmationToken: challenge.confirmationToken}), hasCode('confirmation_required'));
  assert.equal((await service.deleteSession(owner.actor, id, {confirmationToken: challenge.confirmationToken})).deleted, true);
  for (const table of ['shared_events','invitations','join_requests','session_participants','instruction_queue','deletion_challenges']) {
    assert.equal((await context.db.query(`SELECT 1 FROM ${table} WHERE session_id=$1`, [id])).rowCount, 0, table);
  }
  const record = await context.db.query('SELECT response FROM request_results WHERE user_id=$1 AND request_id=$2', [owner.actor.userId,payload.requestId]);
  assert.equal(record.rows[0]!.response, null);
  assert.equal((await context.db.query('SELECT title FROM sessions WHERE id=$1', [id])).rows[0]!.title, null);
  await assert.rejects(service.readEvents(owner.actor, id, 0), hasCode('session_deleted'));
  await assert.rejects(service.createSession(owner.actor, payload), hasCode('session_deleted'));
  await assert.rejects(service.getSession(stranger.actor, id), hasCode('session_not_found'));
  await assert.rejects(service.requestJoin(stranger.actor, {token: invitation.invitation.token}), hasCode('invitation_unavailable'));
  assert.equal((await service.getSession(owner.actor, other.session.id)).session.id, other.session.id);
  assert.equal((await context.db.query('SELECT * FROM sessions')).rowCount, 2);
});

test('API rejects invalid input and never exposes SQL errors or unchecked message fields', async (t) => {
  const context = await createTestContext(); t.after(context.close);
  const owner = await seedActor(context.db);
  const headers = {authorization: `Bearer ${owner.token}`};
  for (const message of [{kind: 'discussion',text: '\u0000'}, {kind: 'discussion',text: 'x'.repeat(16001)}, {kind: 'discussion',text: 'Hello',execute: true}]) {
    const response = await context.app.inject({method: 'POST',url: '/v1/sessions',headers,payload: {requestId: randomUUID(),message}});
    assert.equal(response.statusCode, 400, response.body);
  }
  assert.equal((await context.db.query('SELECT * FROM sessions')).rowCount, 0);
});
