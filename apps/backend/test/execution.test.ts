import assert from 'node:assert/strict';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {buildApp} from '../src/app.js';
import {CollaborationService} from '../src/collaboration.js';
import {ExecutionService} from '../src/execution.js';
import {createTestContext, seedActor, testConfig} from './helpers.js';

// Exercise the actual independently enforced native fingerprint without pulling a
// sibling source tree into this service's production TypeScript compilation.
const {fingerprint: localFingerprint} = await import(new URL('../../../packages/runtime/src/policy.ts', import.meta.url).href) as {fingerprint: (value: unknown) => string};

type Context = Awaited<ReturnType<typeof createTestContext>>;
type Identity = Awaited<ReturnType<typeof seedActor>>;
const secret = () => randomBytes(32).toString('base64url');
const headers = (identity: Identity) => ({authorization: `Bearer ${identity.token}`});

async function session(ctx: Context, owner: Identity, mode: 'plan' | 'build' = 'build') {
  const create = await ctx.app.inject({method: 'POST', url: '/v1/sessions', headers: headers(owner), payload: {requestId: randomUUID(), message: {kind: 'instruction', text: 'Synthetic instruction: inspect the isolated fixture.'}}});
  assert.equal(create.statusCode, 201, create.body);
  const created = create.json();
  const id = created.session.id as string;
  let generation = created.session.runtimeGeneration as number;
  if (mode === 'build') {
    const changed = await ctx.app.inject({method: 'PATCH', url: `/v1/sessions/${id}/mode`, headers: headers(owner), payload: {mode, expectedGeneration: generation}});
    assert.equal(changed.statusCode, 200, changed.body);
    generation = changed.json().session.runtimeGeneration as number;
  }
  return {id, generation, instructionId: created.event.payload.messageId as string};
}

async function run(ctx: Context, owner: Identity, target: Awaited<ReturnType<typeof session>>) {
  const body = {requestId: randomUUID(), connectionId: randomUUID(), model: 'synthetic-fixture-model', instructionId: target.instructionId, leaseToken: secret(), expectedGeneration: target.generation};
  const response = await ctx.app.inject({method: 'POST', url: `/v1/sessions/${target.id}/runs`, headers: headers(owner), payload: body});
  assert.equal(response.statusCode, 200, response.body);
  return {body, context: response.json(), path: `/v1/sessions/${target.id}/runs/${response.json().run.id}`};
}

function action(owner: Identity, target: Awaited<ReturnType<typeof session>>, running: Awaited<ReturnType<typeof run>>) {
  return {version: 1, requestId: randomUUID(), sessionId: target.id, originalOwnerId: owner.actor.userId, originalDeviceId: owner.actor.deviceId, accountGeneration: 1, sessionGeneration: running.context.run.generation as number, runtimeGeneration: running.context.run.generation as number, connectionId: running.body.connectionId, payerId: owner.actor.userId, resourceIdentity: `workspace:${target.id}`, cwd: '/private/synthetic-workspace', expiresAt: Date.now() + 120_000, operation: {kind: 'shell', executable: '/bin/sh', argv: ['-c', 'printf synthetic'], commandText: 'printf synthetic'}};
}

async function admit(ctx: Context, owner: Identity, target: Awaited<ReturnType<typeof session>>, participant: Identity, role: 'collaborator' | 'viewer') {
  const collaboration = new CollaborationService(ctx.db);
  const invitation = await collaboration.createInvitation(owner.actor, target.id, {});
  const join = await collaboration.requestJoin(participant.actor, {token: invitation.invitation.token});
  assert.ok('requestId' in join);
  await collaboration.admit(owner.actor, target.id, join.requestId!, {role});
}

test('late scoped Stop cannot revoke a replacement run',async t=>{
  const ctx=await createTestContext();t.after(()=>ctx.close());
  const owner=await seedActor(ctx.db);
  const target=await session(ctx,owner);
  const first=await run(ctx,owner,target);
  const wrong=await ctx.app.inject({method:'POST',url:`/v1/sessions/${target.id}/stop`,headers:headers(owner),payload:{runId:first.context.run.id,leaseToken:secret()}});
  assert.equal(wrong.statusCode,403);
  const stopped=await ctx.app.inject({method:'POST',url:`/v1/sessions/${target.id}/stop`,headers:headers(owner),payload:{runId:first.context.run.id,leaseToken:first.body.leaseToken}});
  assert.equal(stopped.statusCode,200,stopped.body);
  const posted=await ctx.app.inject({method:'POST',url:`/v1/sessions/${target.id}/messages`,headers:headers(owner),payload:{requestId:randomUUID(),kind:'instruction',text:'A new explicit instruction'}});
  const replacement=await run(ctx,owner,{id:target.id,generation:stopped.json().runtimeGeneration,instructionId:posted.json().event.payload.messageId});
  const late=await ctx.app.inject({method:'POST',url:`/v1/sessions/${target.id}/stop`,headers:headers(owner),payload:{runId:first.context.run.id,leaseToken:first.body.leaseToken}});
  assert.equal(late.statusCode,409);
  const alive=await ctx.app.inject({method:'POST',url:`${replacement.path}/heartbeat`,headers:headers(owner),payload:{leaseToken:replacement.body.leaseToken}});
  assert.equal(alive.statusCode,200,alive.body);
});

test('run claims are durably idempotent under PostgreSQL concurrency and bind connection/model/lease', async t => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const owner = await seedActor(ctx.db);
  const target = await session(ctx, owner);
  const body = {requestId: randomUUID(), connectionId: randomUUID(), model: 'synthetic-fixture-model', instructionId: target.instructionId, leaseToken: secret(), expectedGeneration: target.generation};
  const replies = await Promise.all(Array.from({length: 12}, () => ctx.app.inject({method: 'POST', url: `/v1/sessions/${target.id}/runs`, headers: headers(owner), payload: body})));
  replies.forEach(reply => assert.equal(reply.statusCode, 200, reply.body));
  assert.equal(new Set(replies.map(reply => reply.json().run.id)).size, 1);
  const persisted = await ctx.db.query('SELECT id,lease_hash,status FROM execution_runs WHERE session_id=$1', [target.id]);
  assert.equal(persisted.rowCount, 1);
  assert.equal(persisted.rows[0]?.lease_hash, createHash('sha256').update(body.leaseToken).digest('hex'));
  assert.equal(persisted.rows[0]?.status, 'running');
  const instruction = await ctx.db.query('SELECT status,revision FROM instruction_queue WHERE id=$1', [target.instructionId]);
  assert.deepEqual(instruction.rows[0], {status: 'applied', revision: 2});
  for (const changed of [{connectionId: randomUUID()}, {model: 'different-fixture-model'}, {leaseToken: secret()}]) {
    const conflict = await ctx.app.inject({method: 'POST', url: `/v1/sessions/${target.id}/runs`, headers: headers(owner), payload: {...body, ...changed}});
    assert.equal(conflict.statusCode, 409, conflict.body);
    assert.equal(conflict.json().error.code, 'idempotency_conflict');
  }
  const competing = await ctx.app.inject({method: 'POST', url: `/v1/sessions/${target.id}/runs`, headers: headers(owner), payload: {...body, requestId: randomUUID(), expectedGeneration: replies[0]!.json().run.generation}});
  assert.equal(competing.statusCode, 409);
  assert.equal(competing.json().error.code, 'session_active');
});

test('only the original owner/device and current lease can control execution', async t => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const owner = await seedActor(ctx.db, 'Original owner');
  const collaborator = await seedActor(ctx.db, 'Admitted collaborator');
  const target = await session(ctx, owner);
  await admit(ctx, owner, target, collaborator, 'collaborator');
  const running = await run(ctx, owner, target);
  const foreign = await ctx.app.inject({method: 'POST', url: `${running.path}/heartbeat`, headers: headers(collaborator), payload: {leaseToken: running.body.leaseToken}});
  assert.equal(foreign.statusCode, 403);
  assert.equal(foreign.json().error.code, 'original_host_required');
  const wrongLease = await ctx.app.inject({method: 'POST', url: `${running.path}/heartbeat`, headers: headers(owner), payload: {leaseToken: secret()}});
  assert.equal(wrongLease.statusCode, 403);
  const otherDevice = randomUUID();
  const otherSignIn = randomUUID();
  const otherToken = secret();
  await ctx.db.query('INSERT INTO devices(id,user_id,name) VALUES($1,$2,$3)', [otherDevice, owner.actor.userId, 'Another synthetic device']);
  await ctx.db.query("INSERT INTO auth_sessions(id,user_id,device_id,expires_at) VALUES($1,$2,$3,now()+interval '1 day')", [otherSignIn, owner.actor.userId, otherDevice]);
  await ctx.db.query("INSERT INTO access_tokens(token_hash,auth_session_id,expires_at) VALUES($1,$2,now()+interval '15 minutes')", [createHash('sha256').update(otherToken).digest('hex'), otherSignIn]);
  const sameUserDifferentDevice = await ctx.app.inject({method: 'POST', url: `${running.path}/heartbeat`, headers: {authorization: `Bearer ${otherToken}`}, payload: {leaseToken: running.body.leaseToken}});
  assert.equal(sameUserDifferentDevice.statusCode, 403);
  assert.equal(sameUserDifferentDevice.json().error.code, 'original_host_required');
  const current = await ctx.app.inject({method: 'POST', url: `${running.path}/heartbeat`, headers: headers(owner), payload: {leaseToken: running.body.leaseToken}});
  assert.equal(current.statusCode, 200, current.body);
  assert.ok(Date.parse(current.json().leaseExpiresAt) > Date.now());
  await ctx.db.query('UPDATE devices SET revoked_at=now() WHERE id=$1', [owner.actor.deviceId]);
  const revoked = await ctx.app.inject({method: 'POST', url: `${running.path}/heartbeat`, headers: headers(owner), payload: {leaseToken: running.body.leaseToken}});
  assert.equal(revoked.statusCode, 401);
});

test('Plan rejects all action requests and active sessions cannot switch mode', async t => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const owner = await seedActor(ctx.db);
  const target = await session(ctx, owner, 'plan');
  const running = await run(ctx, owner, target);
  for (const operation of [action(owner, target, running).operation, {kind: 'external', tool: 'synthetic', transport: 'https', arguments: {}}, {kind: 'file_write', relativePath: 'fixture.txt', expectedContentHash: null, contentHash: 'a'.repeat(64)}]) {
    const result = await ctx.app.inject({method: 'POST', url: `${running.path}/actions`, headers: headers(owner), payload: {leaseToken: running.body.leaseToken, descriptor: {...action(owner, target, running), operation}}});
    assert.equal(result.statusCode, 403, result.body);
    assert.equal(result.json().error.code, 'plan_mode');
  }
  const modeChange = await ctx.app.inject({method: 'PATCH', url: `/v1/sessions/${target.id}/mode`, headers: headers(owner), payload: {mode: 'build', expectedGeneration: running.context.run.generation}});
  assert.equal(modeChange.statusCode, 409);
  assert.equal(modeChange.json().error.code, 'session_active');
  assert.equal((await ctx.db.query('SELECT 1 FROM execution_actions')).rowCount, 0);
});

test('exact action fingerprints match the native gate and approvals can be consumed only once', async t => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const owner = await seedActor(ctx.db);
  const target = await session(ctx, owner);
  const running = await run(ctx, owner, target);
  const descriptor = action(owner, target, running);
  const request = await ctx.app.inject({method: 'POST', url: `${running.path}/actions`, headers: headers(owner), payload: {leaseToken: running.body.leaseToken, descriptor}});
  assert.equal(request.statusCode, 200, request.body);
  const approvedHash = request.json().fingerprint as string;
  assert.equal(approvedHash, localFingerprint(descriptor));
  const actionPath = `${running.path}/actions/${descriptor.requestId}`;
  const decide = (decision: string, fingerprint = approvedHash) => ctx.app.inject({method: 'POST', url: actionPath, headers: headers(owner), payload: {leaseToken: running.body.leaseToken, fingerprint, decision}});
  assert.equal((await decide('approve', '0'.repeat(64))).statusCode, 409);
  for (const changed of [{cwd: '/private/another-workspace'}, {connectionId: randomUUID()}, {runtimeGeneration: descriptor.runtimeGeneration + 1}, {operation: {...descriptor.operation, commandText: 'different command'}}]) {
    const result = await ctx.app.inject({method: 'POST', url: `${running.path}/actions`, headers: headers(owner), payload: {leaseToken: running.body.leaseToken, descriptor: {...descriptor, ...changed}}});
    assert.equal(result.statusCode, 409, result.body);
  }
  assert.equal((await decide('approve')).statusCode, 200);
  const consumed = await Promise.all([decide('consume'), decide('consume')]);
  assert.deepEqual(consumed.map(reply => reply.statusCode).sort(), [200, 409]);
  assert.equal((await decide('approve')).statusCode, 409);
  assert.equal((await decide('complete')).statusCode, 200);
  assert.equal((await decide('consume')).statusCode, 409);
  const finished = await ctx.app.inject({method: 'POST', url: `${running.path}/finish`, headers: headers(owner), payload: {leaseToken: running.body.leaseToken, status: 'completed'}});
  assert.equal(finished.statusCode, 200, finished.body);
  assert.equal((await decide('approve')).statusCode, 409);
});

test('rejected, expired and mismatched actions never receive dispatch authority', async t => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const owner = await seedActor(ctx.db);
  const target = await session(ctx, owner);
  const running = await run(ctx, owner, target);
  const descriptor = action(owner, target, running);
  for (const changed of [{expiresAt: Date.now() - 1}, {expiresAt: Date.now() + 600_000}]) {
    const invalid = await ctx.app.inject({method: 'POST', url: `${running.path}/actions`, headers: headers(owner), payload: {leaseToken: running.body.leaseToken, descriptor: {...descriptor, ...changed}}});
    assert.equal(invalid.statusCode, 400, invalid.body);
  }
  for (const changed of [{payerId: randomUUID()}, {originalDeviceId: randomUUID()}, {sessionGeneration: descriptor.sessionGeneration + 1}]) {
    const invalid = await ctx.app.inject({method: 'POST', url: `${running.path}/actions`, headers: headers(owner), payload: {leaseToken: running.body.leaseToken, descriptor: {...descriptor, ...changed}}});
    assert.equal(invalid.statusCode, 409, invalid.body);
  }
  const accepted = await ctx.app.inject({method: 'POST', url: `${running.path}/actions`, headers: headers(owner), payload: {leaseToken: running.body.leaseToken, descriptor}});
  const actionPath = `${running.path}/actions/${descriptor.requestId}`;
  const payload = {leaseToken: running.body.leaseToken, fingerprint: accepted.json().fingerprint};
  assert.equal((await ctx.app.inject({method: 'POST', url: actionPath, headers: headers(owner), payload: {...payload, decision: 'reject'}})).statusCode, 200);
  const dispatch = await ctx.app.inject({method: 'POST', url: actionPath, headers: headers(owner), payload: {...payload, decision: 'consume'}});
  assert.equal(dispatch.statusCode, 409);
  assert.equal((await ctx.db.query('SELECT status FROM execution_actions WHERE id=$1', [descriptor.requestId])).rows[0]?.status, 'rejected');
});

test('central action validation independently denies lexical escapes, NUL bytes and a changed run workspace', async t => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const owner = await seedActor(ctx.db);
  const target = await session(ctx, owner);
  const running = await run(ctx, owner, target);
  const descriptor = action(owner, target, running);
  const submit = (value: unknown) => ctx.app.inject({method: 'POST', url: `${running.path}/actions`, headers: headers(owner), payload: {leaseToken: running.body.leaseToken, descriptor: value}});
  for (const changed of [
    {cwd: 'relative/workspace'},
    {cwd: '/private/../outside'},
    {operation: {...descriptor.operation, executable: 'sh'}},
    {operation: {...descriptor.operation, argv: ['bad\0argument']}},
    {operation: {...descriptor.operation, commandText: 'bad\0command'}},
    {operation: {...descriptor.operation, executable: 'C:\\Windows\\System32\\cmd.exe'}},
    {operation: {kind: 'file_write', relativePath: '../escape', expectedContentHash: null, contentHash: 'a'.repeat(64)}},
    {operation: {kind: 'file_write', relativePath: 'C:drive-relative', expectedContentHash: null, contentHash: 'a'.repeat(64)}},
  ]) {
    const denied = await submit({...descriptor, ...changed});
    assert.equal(denied.statusCode, 400, denied.body);
  }
  assert.equal((await submit({...descriptor, resourceIdentity: `workspace:${randomUUID()}`})).statusCode, 409);
  const first = await submit(descriptor);
  assert.equal(first.statusCode, 200, first.body);
  const rejected = await ctx.app.inject({method: 'POST', url: `${running.path}/actions/${descriptor.requestId}`, headers: headers(owner), payload: {leaseToken: running.body.leaseToken, fingerprint: first.json().fingerprint, decision: 'reject'}});
  assert.equal(rejected.statusCode, 200);
  const moved = await submit({...descriptor, requestId: randomUUID(), cwd: '/private/another-workspace'});
  assert.equal(moved.statusCode, 409, moved.body);
  assert.equal(moved.json().error.code, 'stale_action');
});

test('central lexical checks accept normalized Windows descriptors without reading host paths', async t => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const owner = await seedActor(ctx.db);
  const target = await session(ctx, owner);
  const running = await run(ctx, owner, target);
  const descriptor = {...action(owner, target, running), cwd: 'C:\\MultAI\\private-workspace', operation: {kind: 'shell', executable: 'C:\\Windows\\System32\\cmd.exe', argv: ['/d', '/s', '/c', 'echo synthetic'], commandText: 'echo synthetic'}};
  const accepted = await ctx.app.inject({method: 'POST', url: `${running.path}/actions`, headers: headers(owner), payload: {leaseToken: running.body.leaseToken, descriptor}});
  assert.equal(accepted.statusCode, 200, accepted.body);
  assert.equal(accepted.json().status, 'pending');
});

test('shared output is bounded, redacted, ordered and idempotent under retry', async t => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const owner = await seedActor(ctx.db);
  const target = await session(ctx, owner);
  const running = await run(ctx, owner, target);
  const credential = 'sk-syntheticSecret123456789012345';
  const aws = 'AKIA1234567890ABCDEF';
  const bearer = 'Bearer syntheticBearer1234567890';
  const body = {leaseToken: running.body.leaseToken, eventId: randomUUID(), type: 'agent.delta', payload: {text: `${credential} ${aws} ${bearer} visible output`}};
  const replies = await Promise.all(Array.from({length: 8}, () => ctx.app.inject({method: 'POST', url: `${running.path}/events`, headers: headers(owner), payload: body})));
  replies.forEach(reply => assert.equal(reply.statusCode, 200, reply.body));
  assert.equal(new Set(replies.map(reply => reply.json().sequence)).size, 1);
  const saved = await ctx.db.query("SELECT payload FROM shared_events WHERE session_id=$1 AND type='agent.delta'", [target.id]);
  assert.equal(saved.rowCount, 1);
  const encoded = JSON.stringify(saved.rows[0]?.payload);
  assert.ok(encoded.includes('[REDACTED]'));
  for (const value of [credential, aws, bearer]) assert.ok(!encoded.includes(value));
  const conflict = await ctx.app.inject({method: 'POST', url: `${running.path}/events`, headers: headers(owner), payload: {...body, payload: {text: 'Changed output'}}});
  assert.equal(conflict.statusCode, 409);
  const oversized = await ctx.app.inject({method: 'POST', url: `${running.path}/events`, headers: headers(owner), payload: {...body, eventId: randomUUID(), payload: {text: 'x'.repeat(21_000)}}});
  assert.equal(oversized.statusCode, 400);
});

test('Stop fences late callbacks and makes consumed effects uncertain', async t => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const owner = await seedActor(ctx.db);
  const target = await session(ctx, owner);
  const running = await run(ctx, owner, target);
  const descriptor = action(owner, target, running);
  const request = await ctx.app.inject({method: 'POST', url: `${running.path}/actions`, headers: headers(owner), payload: {leaseToken: running.body.leaseToken, descriptor}});
  for (const decision of ['approve', 'consume']) {
    const result = await ctx.app.inject({method: 'POST', url: `${running.path}/actions/${descriptor.requestId}`, headers: headers(owner), payload: {leaseToken: running.body.leaseToken, fingerprint: request.json().fingerprint, decision}});
    assert.equal(result.statusCode, 200, result.body);
  }
  const stopped = await ctx.app.inject({method: 'POST', url: `/v1/sessions/${target.id}/stop`, headers: headers(owner)});
  assert.equal(stopped.statusCode, 200, stopped.body);
  assert.ok(stopped.json().runtimeGeneration > running.context.run.generation);
  assert.equal((await ctx.db.query('SELECT status FROM sessions WHERE id=$1', [target.id])).rows[0]?.status, 'paused');
  for (const [suffix, body] of [['heartbeat', {}], ['events', {eventId: randomUUID(), type: 'agent.completed', payload: {text: 'Late callback'}}], ['finish', {status: 'completed'}]] as const) {
    const stale = await ctx.app.inject({method: 'POST', url: `${running.path}/${suffix}`, headers: headers(owner), payload: {leaseToken: running.body.leaseToken, ...body}});
    assert.equal(stale.statusCode, 409, stale.body);
    assert.equal(stale.json().error.code, 'stale_execution');
  }
  assert.equal((await ctx.db.query('SELECT status FROM execution_actions WHERE id=$1', [descriptor.requestId])).rows[0]?.status, 'uncertain');
  assert.equal((await ctx.db.query("SELECT 1 FROM shared_events WHERE type='agent.completed'")).rowCount, 0);
});

test('conversation capacity cannot prevent Stop from revoking a live execution lease', async t => {
  for (const capacity of [99744, 100000]) {
    const ctx = await createTestContext();
    t.after(() => ctx.close());
    const owner = await seedActor(ctx.db);
    const target = await session(ctx, owner);
    const running = await run(ctx, owner, target);
    // Synthetic retained-history boundary; no large output fixture is needed to
    // verify the transactional safety transition at an exhausted event counter.
    await ctx.db.query('UPDATE sessions SET event_sequence=$2 WHERE id=$1', [target.id, capacity]);
    const stopped = await ctx.app.inject({method: 'POST', url: `/v1/sessions/${target.id}/stop`, headers: headers(owner)});
    assert.equal(stopped.statusCode, 200, stopped.body);
    const heartbeat = await ctx.app.inject({method: 'POST', url: `${running.path}/heartbeat`, headers: headers(owner), payload: {leaseToken: running.body.leaseToken}});
    assert.equal(heartbeat.statusCode, 409, heartbeat.body);
    assert.equal(heartbeat.json().error.code, 'stale_execution');
  }
});

test('full conversation capacity cannot roll back rejection, known completion or final run status', async t => {
  for (const transition of ['reject', 'complete', 'completed', 'failed'] as const) {
    const ctx = await createTestContext();
    t.after(() => ctx.close());
    const owner = await seedActor(ctx.db);
    const target = await session(ctx, owner);
    const running = await run(ctx, owner, target);
    const descriptor = action(owner, target, running);
    let actionFingerprint = '';
    if (transition === 'reject' || transition === 'complete') {
      const request = await ctx.app.inject({method: 'POST', url: `${running.path}/actions`, headers: headers(owner), payload: {leaseToken: running.body.leaseToken, descriptor}});
      assert.equal(request.statusCode, 200, request.body);
      actionFingerprint = request.json().fingerprint as string;
      if (transition === 'complete') {
        for (const decision of ['approve', 'consume']) {
          assert.equal((await ctx.app.inject({method: 'POST', url: `${running.path}/actions/${descriptor.requestId}`, headers: headers(owner), payload: {leaseToken: running.body.leaseToken, fingerprint: actionFingerprint, decision}})).statusCode, 200);
        }
        // Expiry is a pre-dispatch gate. A known result still commits after
        // consumption when the run lease/generation remain fresh.
        await ctx.db.query("UPDATE execution_actions SET expires_at=now()-interval '1 second' WHERE id=$1", [descriptor.requestId]);
      }
    }
    await ctx.db.query('UPDATE sessions SET event_sequence=100000 WHERE id=$1', [target.id]);
    if (transition === 'reject' || transition === 'complete') {
      const result = await ctx.app.inject({method: 'POST', url: `${running.path}/actions/${descriptor.requestId}`, headers: headers(owner), payload: {leaseToken: running.body.leaseToken, fingerprint: actionFingerprint, decision: transition}});
      assert.equal(result.statusCode, 200, result.body);
      assert.equal((await ctx.db.query('SELECT status FROM execution_actions WHERE id=$1', [descriptor.requestId])).rows[0]?.status, transition === 'reject' ? 'rejected' : 'completed');
    } else {
      const result = await ctx.app.inject({method: 'POST', url: `${running.path}/finish`, headers: headers(owner), payload: {leaseToken: running.body.leaseToken, status: transition}});
      assert.equal(result.statusCode, 200, result.body);
      assert.equal((await ctx.db.query('SELECT status FROM execution_runs WHERE id=$1', [running.context.run.id])).rows[0]?.status, transition);
    }
  }
});

test('selected instruction is explicit, history keeps authorship and other pending instructions never become the current prompt', async t => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const owner = await seedActor(ctx.db);
  const target = await session(ctx, owner);
  const first = await run(ctx, owner, target);
  assert.equal(first.context.selectedInstruction.id, target.instructionId);
  assert.equal(first.context.selectedInstruction.authorId, owner.actor.userId);
  assert.equal(first.context.messages.some((message: {content: string}) => message.content.includes('inspect the isolated fixture')), false);
  await ctx.app.inject({method: 'POST', url: `${first.path}/finish`, headers: headers(owner), payload: {leaseToken: first.body.leaseToken, status: 'completed'}});
  const chosenText = 'Chosen current instruction';
  const chosen = await ctx.app.inject({method: 'POST', url: `/v1/sessions/${target.id}/messages`, headers: headers(owner), payload: {requestId: randomUUID(), kind: 'instruction', text: chosenText}});
  await ctx.app.inject({method: 'POST', url: `/v1/sessions/${target.id}/messages`, headers: headers(owner), payload: {requestId: randomUUID(), kind: 'instruction', text: 'Unselected pending instruction must stay queued'}});
  await ctx.app.inject({method: 'POST', url: `/v1/sessions/${target.id}/messages`, headers: headers(owner), payload: {requestId: randomUUID(), kind: 'discussion', text: 'Team context only'}});
  const next = await run(ctx, owner, {...target, generation: first.context.run.generation, instructionId: chosen.json().event.payload.messageId});
  assert.equal(next.context.selectedInstruction.text, chosenText);
  assert.equal(next.context.selectedInstruction.authorId, owner.actor.userId);
  assert.equal(next.context.messages.some((message: {content: string}) => message.content.includes(chosenText)), false);
  assert.equal(next.context.messages.some((message: {content: string}) => message.content.includes('Unselected pending')), false);
  assert.ok(next.context.messages.some((message: {content: string; authorId: string}) => message.content.includes('Previously applied instruction') && message.authorId === owner.actor.userId));
  assert.ok(next.context.messages.some((message: {content: string; authorId: string}) => message.content.includes('Team discussion') && message.authorId === owner.actor.userId));
});

test('a context limit never silently drops current saved decisions or consumes the pending instruction', async t => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const owner = await seedActor(ctx.db);
  const target = await session(ctx, owner);
  await ctx.db.query("INSERT INTO decisions(id,session_id,author_id,text) SELECT gen_random_uuid(),$1,$2,'Synthetic current constraint '||n::text FROM generate_series(1,101) n", [target.id, owner.actor.userId]);
  const body = {requestId: randomUUID(), connectionId: randomUUID(), model: 'synthetic-fixture-model', instructionId: target.instructionId, leaseToken: secret(), expectedGeneration: target.generation};
  const blocked = await ctx.app.inject({method: 'POST', url: `/v1/sessions/${target.id}/runs`, headers: headers(owner), payload: body});
  assert.equal(blocked.statusCode, 409, blocked.body);
  assert.equal(blocked.json().error.code, 'context_capacity');
  assert.equal((await ctx.db.query('SELECT 1 FROM execution_runs WHERE session_id=$1', [target.id])).rowCount, 0);
  assert.equal((await ctx.db.query('SELECT status FROM instruction_queue WHERE id=$1', [target.instructionId])).rows[0]?.status, 'pending');
  assert.equal((await ctx.db.query('SELECT runtime_generation FROM sessions WHERE id=$1', [target.id])).rows[0]?.runtime_generation, target.generation);
});

test('expired leases require explicit reviewed Resume and never replay the applied instruction', async t => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const owner = await seedActor(ctx.db);
  const target = await session(ctx, owner);
  const running = await run(ctx, owner, target);
  await ctx.db.query("UPDATE execution_runs SET lease_expires_at=now()-interval '1 second' WHERE id=$1", [running.context.run.id]);
  const expired = await ctx.app.inject({method: 'POST', url: `${running.path}/heartbeat`, headers: headers(owner), payload: {leaseToken: running.body.leaseToken}});
  assert.equal(expired.statusCode, 409);
  assert.equal(expired.json().error.code, 'lease_expired');
  const next = await ctx.app.inject({method: 'POST', url: `/v1/sessions/${target.id}/messages`, headers: headers(owner), payload: {requestId: randomUUID(), kind: 'instruction', text: 'Synthetic explicit recovery instruction'}});
  const nextBody = {...running.body, requestId: randomUUID(), instructionId: next.json().event.payload.messageId, expectedGeneration: running.context.run.generation, leaseToken: secret()};
  const implicit = await ctx.app.inject({method: 'POST', url: `/v1/sessions/${target.id}/runs`, headers: headers(owner), payload: nextBody});
  assert.equal(implicit.statusCode, 409);
  const resumed = await ctx.app.inject({method: 'POST', url: `/v1/sessions/${target.id}/runs`, headers: headers(owner), payload: {...nextBody, resume: true}});
  assert.equal(resumed.statusCode, 200, resumed.body);
  assert.notEqual(resumed.json().run.id, running.context.run.id);
  assert.ok(resumed.json().run.generation > running.context.run.generation);
  assert.equal((await ctx.db.query('SELECT status FROM execution_runs WHERE id=$1', [running.context.run.id])).rows[0]?.status, 'uncertain');
  assert.equal((await ctx.db.query('SELECT revision FROM instruction_queue WHERE id=$1', [target.instructionId])).rows[0]?.revision, 2);
});

test('decision roles preserve authorship/replacement history and cross-author instructions pause for a recorded owner resolution', async t => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  const owner = await seedActor(ctx.db, 'Owner');
  const collaborator = await seedActor(ctx.db, 'Collaborator');
  const viewer = await seedActor(ctx.db, 'Viewer');
  const target = await session(ctx, owner);
  await admit(ctx, owner, target, collaborator, 'collaborator');
  await admit(ctx, owner, target, viewer, 'viewer');
  const decide = (identity: Identity, body: {text: string; reason?: string; replacesId?: string}) => ctx.app.inject({method: 'POST', url: `/v1/sessions/${target.id}/decisions`, headers: headers(identity), payload: body});
  const original = await decide(owner, {text: 'Original explicit owner decision'});
  assert.equal(original.statusCode, 200, original.body);
  const prohibited = await decide(collaborator, {text: 'Replace another author', replacesId: original.json().id});
  assert.equal(prohibited.statusCode, 403);
  assert.equal((await decide(viewer, {text: 'Viewer cannot author a decision'})).statusCode, 403);
  const own = await decide(collaborator, {text: 'Collaborator authored this'});
  const replaced = await decide(collaborator, {text: 'Collaborator explicit replacement', replacesId: own.json().id, reason: 'Synthetic user-provided reason'});
  assert.equal(replaced.statusCode, 200, replaced.body);
  const history = await ctx.db.query('SELECT author_id,replaced_by FROM decisions WHERE id=$1', [own.json().id]);
  assert.equal(history.rows[0]?.author_id, collaborator.actor.userId);
  assert.equal(history.rows[0]?.replaced_by, replaced.json().id);
  const extra = await ctx.app.inject({method: 'POST', url: `/v1/sessions/${target.id}/messages`, headers: headers(collaborator), payload: {requestId: randomUUID(), kind: 'instruction', text: 'Different author pending direction'}});
  assert.equal(extra.statusCode, 201, extra.body);
  const body = {requestId: randomUUID(), connectionId: randomUUID(), model: 'synthetic-fixture-model', instructionId: target.instructionId, leaseToken: secret(), expectedGeneration: target.generation};
  const conflicting = await ctx.app.inject({method: 'POST', url: `/v1/sessions/${target.id}/runs`, headers: headers(owner), payload: body});
  assert.equal(conflicting.statusCode, 409);
  assert.equal(conflicting.json().error.code, 'instruction_conflict');
  const resolution = 'Explicit owner decision: follow the selected instruction and preserve the existing constraints.';
  const resolved = await ctx.app.inject({method: 'POST', url: `/v1/sessions/${target.id}/runs`, headers: headers(owner), payload: {...body, resolution}});
  assert.equal(resolved.statusCode, 200, resolved.body);
  assert.ok(resolved.json().decisions.some((decision: {text: string}) => decision.text === resolution));
  const duringRun = await decide(owner, {text: 'Cannot change active context'});
  assert.equal(duringRun.statusCode, 409);
});

test('service restart fences the prior epoch and only one service may own a database', async t => {
  const ctx = await createTestContext();
  let restarted: Awaited<ReturnType<typeof buildApp>> | undefined;
  t.after(async () => {await restarted?.close(); await ctx.close();});
  const owner = await seedActor(ctx.db);
  const target = await session(ctx, owner);
  const running = await run(ctx, owner, target);
  const descriptor = action(owner, target, running);
  const request = await ctx.app.inject({method: 'POST', url: `${running.path}/actions`, headers: headers(owner), payload: {leaseToken: running.body.leaseToken, descriptor}});
  for (const decision of ['approve', 'consume']) {
    assert.equal((await ctx.app.inject({method: 'POST', url: `${running.path}/actions/${descriptor.requestId}`, headers: headers(owner), payload: {leaseToken: running.body.leaseToken, fingerprint: request.json().fingerprint, decision}})).statusCode, 200);
  }
  const second = new ExecutionService(ctx.db);
  await assert.rejects(second.startup(), /already owns/);
  await second.close();
  await ctx.app.close();
  restarted = await buildApp({db: ctx.db, config: testConfig});
  const status = await ctx.db.query('SELECT status,runtime_generation FROM sessions WHERE id=$1', [target.id]);
  assert.equal(status.rows[0]?.status, 'paused');
  assert.ok(status.rows[0]?.runtime_generation > running.context.run.generation);
  assert.equal((await ctx.db.query('SELECT status FROM execution_runs WHERE id=$1', [running.context.run.id])).rows[0]?.status, 'uncertain');
  assert.equal((await ctx.db.query('SELECT status FROM execution_actions WHERE id=$1', [descriptor.requestId])).rows[0]?.status, 'uncertain');
  const late = await restarted.inject({method: 'POST', url: `${running.path}/heartbeat`, headers: headers(owner), payload: {leaseToken: running.body.leaseToken}});
  assert.equal(late.statusCode, 409);
  assert.equal(late.json().error.code, 'stale_execution');
});
