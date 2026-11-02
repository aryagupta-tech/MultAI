import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {test, type TestContext} from 'node:test';
import {AcceptanceService, proposeAcceptanceCriterion, readAcceptance, reviewAcceptanceEvidence} from '../src/acceptance.js';
import {CollaborationService, type SessionRow} from '../src/collaboration.js';
import {transaction} from '../src/db.js';
import {createTestContext,seedActor} from './helpers.js';

const revision='a'.repeat(64), changed='b'.repeat(64);
async function setup(t:TestContext){
  const ctx=await createTestContext();t.after(()=>ctx.close());
  const host=await seedActor(ctx.db,'Host'),collaborator=await seedActor(ctx.db,'Collaborator'),viewer=await seedActor(ctx.db,'Viewer'),stranger=await seedActor(ctx.db,'Stranger');
  const collaboration=new CollaborationService(ctx.db),service=new AcceptanceService(ctx.db);
  const made=await collaboration.createSession(host.actor,{requestId:randomUUID(),message:{kind:'discussion',text:'Checkout'}}) as {session:{id:string}};
  const sessionId=made.session.id;
  for(const [user,role] of [[collaborator,'collaborator'],[viewer,'viewer']] as const){
    const invite=await collaboration.createInvitation(host.actor,sessionId,{}),join=await collaboration.requestJoin(user.actor,{token:invite.invitation.token});
    await collaboration.admit(host.actor,sessionId,join.requestId!,{role});
  }
  const propose=()=>service.propose(collaborator.actor,sessionId,{requestId:randomUUID(),text:'Never place two orders on double-click',checkCommand:'npm test -- checkout'});
  const approve=async()=>{const requirement=await propose();await service.approve(host.actor,sessionId,requirement.id,{requestId:randomUUID(),expectedVersion:requirement.version});await service.revision(host.actor,sessionId,{requestId:randomUUID(),revision});return requirement;};
  return {...ctx,host,collaborator,viewer,stranger,collaboration,service,sessionId,propose,approve};
}
function proof(id:string,overrides:Record<string,unknown>={}){return {requestId:randomUUID(),criterionId:id,criterionVersion:1,revision,kind:'command',command:'npm test -- checkout',exitCode:0,output:'1 passing',durationMs:21,...overrides};}

test('approved requirements bind evidence to exact command and revision; human decisions never rewrite failures',async t=>{
  const {service,host,collaborator,sessionId,approve}=await setup(t),requirement=await approve();
  const failed=await service.evidence(host.actor,sessionId,proof(requirement.id,{exitCode:1,output:'duplicate order'}));
  assert.equal(failed.status,'failed');
  await service.review(collaborator.actor,sessionId,{requestId:randomUUID(),criterionId:requirement.id,criterionVersion:1,evidenceId:failed.id,revision,decision:'accept',comment:'Reviewed the failure'});
  let snapshot=await service.list(host.actor,sessionId);
  assert.equal(snapshot.criteria[0]!.status,'failed');assert.equal(snapshot.criteria[0]!.evidence!.reviews[0]!.decision,'accept');
  const succeeded=await service.evidence(host.actor,sessionId,proof(requirement.id));
  assert.equal(succeeded.status,'passed');snapshot=await service.list(host.actor,sessionId);assert.equal(snapshot.criteria[0]!.status,'passed');
  assert.deepEqual(snapshot.criteria[0]!.evidence!.reviews,[],'a new proof needs a new human review');
  await assert.rejects(service.review(collaborator.actor,sessionId,{requestId:randomUUID(),criterionId:requirement.id,criterionVersion:1,evidenceId:failed.id,revision,decision:'accept'}),{code:'stale_evidence'});
  await service.revision(host.actor,sessionId,{requestId:randomUUID(),revision:changed});
  assert.equal((await service.list(host.actor,sessionId)).criteria[0]!.status,'stale');
  await assert.rejects(service.evidence(host.actor,sessionId,proof(requirement.id)),{code:'stale_evidence'});
  await assert.rejects(service.review(collaborator.actor,sessionId,{requestId:randomUUID(),criterionId:requirement.id,criterionVersion:1,evidenceId:succeeded.id,revision,decision:'accept'}),{code:'stale_evidence'});
});

test('code invalidation, running sessions and requirement edits cannot retain a green verdict',async t=>{
  const {service,host,sessionId,approve,db}=await setup(t),requirement=await approve();
  await service.evidence(host.actor,sessionId,proof(requirement.id));
  await db.query("UPDATE sessions SET status='running' WHERE id=$1",[sessionId]);
  assert.equal((await service.list(host.actor,sessionId)).criteria[0]!.status,'stale');
  await assert.rejects(service.evidence(host.actor,sessionId,proof(requirement.id)),{code:'session_active'});
  await assert.rejects(service.revise(host.actor,sessionId,requirement.id,{requestId:randomUUID(),expectedVersion:1,text:'New condition'}),{code:'session_active'});
  await db.query("UPDATE sessions SET status='inactive' WHERE id=$1",[sessionId]);
  await service.revision(host.actor,sessionId,{requestId:randomUUID(),revision:null});
  assert.equal((await service.list(host.actor,sessionId)).criteria[0]!.status,'stale');
  await service.revision(host.actor,sessionId,{requestId:randomUUID(),revision});
  const revised=await service.revise(host.actor,sessionId,requirement.id,{requestId:randomUUID(),expectedVersion:1,text:'Also reject duplicate retries',checkCommand:'npm test -- idempotency'});
  assert.equal(revised.version,2);let row=(await service.list(host.actor,sessionId)).criteria[0]!;
  assert.equal(row.state,'proposed');assert.equal(row.status,'stale');assert.equal(row.checkCommand,'npm test -- idempotency');
  await assert.rejects(service.evidence(host.actor,sessionId,proof(requirement.id)),{code:'stale_criterion'});
  await assert.rejects(service.evidence(host.actor,sessionId,proof(requirement.id,{criterionVersion:2})),{code:'criterion_not_approved'});
  await service.approve(host.actor,sessionId,requirement.id,{requestId:randomUUID(),expectedVersion:2});
  await assert.rejects(service.evidence(host.actor,sessionId,proof(requirement.id,{criterionVersion:2})),{code:'check_command_mismatch'});
  await service.evidence(host.actor,sessionId,proof(requirement.id,{criterionVersion:2,command:'npm test -- idempotency'}));
  row=(await service.list(host.actor,sessionId)).criteria[0]!;assert.equal(row.status,'passed');
});

test('roles, original host device and revoked identity fence every acceptance operation and retry',async t=>{
  const {service,host,collaborator,viewer,stranger,sessionId,approve,db}=await setup(t),requirement=await approve();
  await assert.rejects(service.list(stranger.actor,sessionId),{code:'membership_required'});
  assert.equal((await service.list(viewer.actor,sessionId)).criteria.length,1);
  await assert.rejects(service.propose(viewer.actor,sessionId,{requestId:randomUUID(),text:'No'}),{code:'read_only'});
  for(const identity of [collaborator,viewer]){
    await assert.rejects(service.approve(identity.actor,sessionId,requirement.id,{requestId:randomUUID(),expectedVersion:1}));
    await assert.rejects(service.evidence(identity.actor,sessionId,proof(requirement.id)));
    await assert.rejects(service.revision(identity.actor,sessionId,{requestId:randomUUID(),revision}));
  }
  const deviceId=randomUUID(),authSessionId=randomUUID();
  await db.query('INSERT INTO devices(id,user_id,name) VALUES($1,$2,$3)',[deviceId,host.actor.userId,'Other device']);
  await db.query("INSERT INTO auth_sessions(id,user_id,device_id,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",[authSessionId,host.actor.userId,deviceId]);
  await assert.rejects(service.evidence({...host.actor,deviceId,authSessionId},sessionId,proof(requirement.id)),{code:'original_host_required'});
  const body={requestId:randomUUID(),text:'Retry once'};await service.propose(collaborator.actor,sessionId,body);
  await db.query('UPDATE session_participants SET revoked_at=now() WHERE session_id=$1 AND user_id=$2',[sessionId,collaborator.actor.userId]);
  await assert.rejects(service.propose(collaborator.actor,sessionId,body),{code:'membership_required'});
  await db.query('UPDATE auth_sessions SET revoked_at=now() WHERE id=$1',[host.actor.authSessionId]);
  await assert.rejects(service.list(host.actor,sessionId),{code:'unauthorized'});
  await assert.rejects(service.revision(host.actor,sessionId,{requestId:randomUUID(),revision}),{code:'unauthorized'});
});

test('retries are immutable and concurrent optimistic edits cannot silently overwrite requirements',async t=>{
  const {service,host,collaborator,sessionId}=await setup(t);
  const body={requestId:randomUUID(),text:'Keyboard checkout works',checkCommand:null};
  const [first,second]=await Promise.all([service.propose(collaborator.actor,sessionId,body),service.propose(collaborator.actor,sessionId,body)]);
  assert.equal(first.id,second.id);assert.equal((await service.list(host.actor,sessionId)).criteria.length,1);
  await assert.rejects(service.propose(collaborator.actor,sessionId,{...body,text:'Changed retry'}),{code:'idempotency_conflict'});
  const results=await Promise.allSettled(['Condition A','Condition B'].map(text=>service.revise(host.actor,sessionId,first.id,{requestId:randomUUID(),expectedVersion:1,text})));
  assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
  assert.equal((results.find(result=>result.status==='rejected') as PromiseRejectedResult).reason.code,'stale_criterion');
  const stored=(await service.list(host.actor,sessionId)).criteria[0]!;
  assert.equal(stored.version,2);assert.ok(['Condition A','Condition B'].includes(stored.text));
});

test('missing process status, manual status claims, command substitution, cancellation and timeouts cannot fabricate a pass',async t=>{
  const {service,host,sessionId,approve}=await setup(t),requirement=await approve();
  await assert.rejects(service.evidence(host.actor,sessionId,proof(requirement.id,{exitCode:undefined})));
  await assert.rejects(service.evidence(host.actor,sessionId,proof(requirement.id,{kind:'manual'})));
  await assert.rejects(service.evidence(host.actor,sessionId,proof(requirement.id,{status:'passed'})));
  await assert.rejects(service.evidence(host.actor,sessionId,proof(requirement.id,{command:'true'})),{code:'check_command_mismatch'});
  for(const overrides of [{timedOut:true},{canceled:true},{exitCode:null},{exitCode:127}]){
    assert.equal((await service.evidence(host.actor,sessionId,proof(requirement.id,overrides))).status,'failed');
    assert.equal((await service.list(host.actor,sessionId)).criteria[0]!.status,'failed');
  }
  const manual=await service.evidence(host.actor,sessionId,{requestId:randomUUID(),criterionId:requirement.id,criterionVersion:1,revision,kind:'manual',output:'Inspect keyboard focus'});
  assert.equal(manual.status,'needs_review');
  await service.review(host.actor,sessionId,{requestId:randomUUID(),criterionId:requirement.id,criterionVersion:1,evidenceId:manual.id,revision,decision:'accept'});
  assert.equal((await service.list(host.actor,sessionId)).criteria[0]!.status,'needs_review','human approval is distinct from an automated test pass');
});

test('browser helpers retain guest attribution and cannot approve requirements or publish automated evidence',async t=>{
  const {service,host,sessionId,db}=await setup(t),author={id:randomUUID(),name:'Browser reviewer',kind:'browser' as const};
  const locked=async<T>(operation:(client:import('pg').PoolClient,session:SessionRow)=>Promise<T>)=>transaction(db,async client=>{
    const session=(await client.query<SessionRow>('SELECT * FROM sessions WHERE id=$1 FOR UPDATE',[sessionId])).rows[0]!;
    return operation(client,session);
  });
  const requirement=await locked((client,session)=>proposeAcceptanceCriterion(client,session,author,{requestId:randomUUID(),text:'Button label is legible'}));
  await service.approve(host.actor,sessionId,requirement.id,{requestId:randomUUID(),expectedVersion:1});
  await service.revision(host.actor,sessionId,{requestId:randomUUID(),revision});
  const evidence=await service.evidence(host.actor,sessionId,{requestId:randomUUID(),criterionId:requirement.id,criterionVersion:1,revision,kind:'manual',output:'Shared screenshot inspected'});
  await locked((client,session)=>reviewAcceptanceEvidence(client,session,author,{requestId:randomUUID(),criterionId:requirement.id,criterionVersion:1,evidenceId:evidence.id,revision,decision:'reject',comment:'Too small'}));
  const snapshot=await locked((client,session)=>readAcceptance(client,session)),row=snapshot.criteria[0]!;
  assert.equal(row.authorKind,'browser');assert.equal(row.authorName,'Browser reviewer');assert.equal(row.evidence!.reviews[0]!.reviewerKind,'browser');assert.equal(row.evidence!.reviews[0]!.decision,'reject');
  const event=(await db.query<{actor_id:string|null;payload:{authorKind:string}}>("SELECT actor_id,payload FROM shared_events WHERE session_id=$1 AND type='acceptance.reviewed'",[sessionId])).rows[0]!;
  assert.equal(event.actor_id,null);assert.equal(event.payload.authorKind,'browser');
});

test('bounded inputs, redaction and event-capacity failures preserve atomic state',async t=>{
  const {service,host,collaborator,sessionId,approve,db}=await setup(t),requirement=await approve();
  const secret='sk-abcdefghijklmnop';
  await assert.rejects(service.propose(collaborator.actor,sessionId,{requestId:randomUUID(),text:'Test',checkCommand:`echo ${secret}`}),{code:'secret_in_command'});
  await assert.rejects(service.propose(collaborator.actor,sessionId,{requestId:randomUUID(),text:'x'.repeat(2001)}));
  await assert.rejects(service.evidence(host.actor,sessionId,proof(requirement.id,{output:'x'.repeat(6001)})));
  await service.evidence(host.actor,sessionId,proof(requirement.id,{output:`Output ${secret}`}));
  assert.equal((await service.list(host.actor,sessionId)).criteria[0]!.evidence!.output,'Output [REDACTED]');
  await db.query('UPDATE sessions SET event_sequence=99744 WHERE id=$1',[sessionId]);
  await assert.rejects(service.revise(host.actor,sessionId,requirement.id,{requestId:randomUUID(),expectedVersion:1,text:'Not committed'}),{code:'session_capacity'});
  assert.equal((await service.list(host.actor,sessionId)).criteria[0]!.version,1);
  await assert.rejects(service.revision(host.actor,sessionId,{requestId:randomUUID(),revision:changed}),{code:'session_capacity'});
  assert.equal((await service.list(host.actor,sessionId)).revision,revision);
});

test('latest proof follows serialized event order, even if transaction timestamps disagree',async t=>{
  const {service,host,collaborator,sessionId,approve,db}=await setup(t),requirement=await approve();
  const first=await service.evidence(host.actor,sessionId,proof(requirement.id));
  // Simulate transactions beginning before they acquire the session lock (or a wall-clock change).
  await db.query("UPDATE acceptance_evidence SET created_at=now()+interval '1 hour' WHERE id=$1",[first.id]);
  const second=await service.evidence(host.actor,sessionId,proof(requirement.id,{exitCode:1,output:'Regression found'}));
  const row=(await service.list(host.actor,sessionId)).criteria[0]!;
  assert.equal(row.evidence!.id,second.id);assert.equal(row.status,'failed');
  await assert.rejects(service.review(collaborator.actor,sessionId,{requestId:randomUUID(),criterionId:requirement.id,criterionVersion:1,evidenceId:first.id,revision,decision:'accept'}),{code:'stale_evidence'});
});

test('a requirement or proof cannot be injected into another session',async t=>{
  const {service,host,sessionId,approve,collaboration}=await setup(t),requirement=await approve();
  const other=(await collaboration.createSession(host.actor,{requestId:randomUUID(),message:{kind:'discussion',text:'Different project'}}) as {session:{id:string}}).session.id;
  await service.revision(host.actor,other,{requestId:randomUUID(),revision});
  await assert.rejects(service.approve(host.actor,other,requirement.id,{requestId:randomUUID(),expectedVersion:1}),{code:'criterion_not_found'});
  await assert.rejects(service.evidence(host.actor,other,proof(requirement.id)),{code:'criterion_not_found'});
  const body={requestId:randomUUID(),text:'Immutable request scope'};
  await service.propose(host.actor,sessionId,body);
  await assert.rejects(service.propose(host.actor,other,body),{code:'idempotency_conflict'});
  assert.deepEqual((await service.list(host.actor,other)).criteria,[]);
});

test('deleted sessions fence proof retries and clear requirement, evidence and human review content',async t=>{
  const {service,host,sessionId,approve,collaboration,db}=await setup(t),requirement=await approve();
  const body=proof(requirement.id),evidence=await service.evidence(host.actor,sessionId,body);
  await service.review(host.actor,sessionId,{requestId:randomUUID(),criterionId:requirement.id,criterionVersion:1,evidenceId:evidence.id,revision,decision:'accept',comment:'Private review'});
  const challenge=await collaboration.deletionChallenge(host.actor,sessionId);
  await collaboration.deleteSession(host.actor,sessionId,{confirmationToken:challenge.confirmationToken});
  await assert.rejects(service.list(host.actor,sessionId),{code:'session_deleted'});
  await assert.rejects(service.evidence(host.actor,sessionId,body),{code:'session_deleted'});
  for(const table of ['acceptance_criteria','acceptance_evidence','acceptance_workspaces','acceptance_requests'])assert.equal((await db.query(`SELECT count(*)::int AS count FROM ${table} WHERE session_id=$1`,[sessionId])).rows[0].count,0,table);
  assert.equal((await db.query('SELECT count(*)::int AS count FROM acceptance_reviews WHERE evidence_id=$1',[evidence.id])).rows[0].count,0);
});
