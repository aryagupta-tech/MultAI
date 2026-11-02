import { describe, expect, test } from 'vitest';
import type { WireEvent, WireMe, WireSession } from '../bridge/wire';
import {contiguousEnd, mergeEvents, nextPendingInstruction, queuedInstructions, personFor, projectSession, projectSessionState, sessionTitle, titleFromMessage} from './projection';

const me: WireMe = { id: '11111111-1111-4111-8111-111111111111', displayName: 'Ada Lovelace', workspaceId: '22222222-2222-4222-8222-222222222222', deviceId: '33333333-3333-4333-8333-333333333333' };
const other = 'abcdef12-0000-4000-8000-000000000000';

const session = (over: Partial<WireSession> = {}): WireSession => ({
  id: '44444444-4444-4444-8444-444444444444', workspaceId: me.workspaceId, ownerId: me.id, title: null, mode: 'plan', status: 'inactive',
  runtimeGeneration: 3, lastSequence: 3, role: 'owner', createdAt: '2026-10-29T00:00:00.000Z', updatedAt: '2026-10-29T00:05:00.000Z',
  capabilities: { submit: true, manage: true, execute: false }, ...over,
});

const ev = (sequence: number, type: string, actorId: string | null, payload: unknown): WireEvent => ({
  id: `e${sequence}`, sessionId: session().id, sequence, type, actorId, payload, createdAt: `2026-10-29T00:0${sequence}:00.000Z`,
});

describe('projectSession', () => {
  const events = [
    ev(1, 'session.created', me.id, { mode: 'plan', inferenceEnabled: false }),
    ev(2, 'message.instruction', me.id, { messageId: 'm1', text: 'Add rate limiting', queueStatus: 'pending' }),
    ev(3, 'message.discussion', other, { messageId: 'm2', text: 'Key it by merchant' }),
    ev(4, 'participant.admitted', me.id, { userId: other, role: 'collaborator' }),
    ev(5, 'something.new', me.id, {}),
  ];
  const d = projectSession({ session: session(), participants: [{ userId: me.id, role: 'owner', admittedAt: '' }, { userId: other, role: 'collaborator', admittedAt: '' }], events, me });

  test('maps messages with authors, kinds and queue state', () => {
    const msgs = d.timeline.filter((t) => t.type === 'message');
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ kind: 'instruction', authorId: me.id, text: 'Add rate limiting', queue: 'pending' });
    expect(msgs[1]).toMatchObject({ kind: 'discussion', authorId: other });
  });

  test('turns lifecycle events into readable system lines and skips unknown types', () => {
    const systems = d.timeline.filter((t) => t.type === 'system').map((t) => t.type === 'system' && t.text);
    expect(systems).toEqual(['You started this session in Plan mode.', 'Teammate ABCD joined as collaborator.']);
    expect(d.timeline.map((t) => t.sequence)).toEqual([1, 2, 3, 4]);
  });

  test('derives capabilities from the service, never more', () => {
    expect(d.capabilities).toEqual({ submit: true, approve: true, configure: true, decide: false, delete: true });
    const viewer = projectSession({ session: session({ role: 'viewer', ownerId: other, capabilities: { submit: false, manage: false, execute: false } }), participants: [], events: [], me });
    expect(viewer.capabilities).toEqual({ submit: false, approve: false, configure: false, decide: false, delete: false });
    expect(viewer.hostName).toBe('Teammate ABCD’s computer');
  });

  test('titles come from the service, then the first message', () => {
    expect(d.title).toBe('Add rate limiting');
    expect(sessionTitle(session({ title: 'Named' }))).toBe('Named');
    expect(sessionTitle(session())).toBe('Untitled session');
    expect(titleFromMessage('  first line\nsecond')).toBe('first line');
  });

  test('never invents names for other people', () => {
    expect(personFor(me.id, me).name).toBe('Ada Lovelace');
    expect(personFor(me.id, me).initials).toBe('AL');
    expect(personFor(other, me).name).toBe('Teammate ABCD');
  });
});

describe('mergeEvents', () => {
  test('appends in order, deduplicates by sequence, and sorts out-of-order batches', () => {
    const a = [ev(1, 'x', null, {}), ev(2, 'x', null, {})];
    expect(mergeEvents(a, [ev(3, 'x', null, {})]).map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(mergeEvents(a, [ev(2, 'x', null, {}), ev(4, 'x', null, {}), ev(3, 'x', null, {})]).map((e) => e.sequence)).toEqual([1, 2, 3, 4]);
    expect(mergeEvents(a, [])).toBe(a);
  });
  test('resumes from the last event with nothing missing before it', () => {
    expect(contiguousEnd([])).toBe(0);
    expect(contiguousEnd([ev(1, 'x', null, {}), ev(2, 'x', null, {}), ev(3, 'x', null, {})])).toBe(3);
    // A message just sent (4) arrived before the removal (3) the live stream still owes us.
    expect(contiguousEnd([ev(1, 'x', null, {}), ev(2, 'x', null, {}), ev(4, 'x', null, {})])).toBe(2);
  });
});

describe('execution event projection',()=>{
  const project=(events:WireEvent[],over:Partial<WireSession>={})=>projectSession({session:session(over),participants:[],events,me});
  test('uses the actual queued instruction ID rather than its event ID for dispatch',()=>{
    const d=project([ev(1,'message.instruction',me.id,{messageId:'instruction-one',text:'First',queueStatus:'pending'}),ev(2,'message.instruction',me.id,{messageId:'instruction-two',text:'Refinement',queueStatus:'pending'})]);
    expect(d.timeline[0]?.id).toBe('instruction-one');
    expect(nextPendingInstruction(d.timeline)?.id).toBe('instruction-one');
    const claimed=project([ev(1,'message.instruction',me.id,{messageId:'instruction-one',text:'First',queueStatus:'pending'}),ev(2,'run.started',me.id,{runId:'run-one',instructionId:'instruction-one',model:'provider-model',runtimeGeneration:4})]);
    expect(claimed.timeline[0]).toMatchObject({id:'instruction-one',queue:'applied'});
    expect(nextPendingInstruction(claimed.timeline)).toBeNull();
  });
  test('a queued message waits, can be steered or removed, and joins where the agent picked it up',()=>{
    const queued=(seq:number,id:string,text:string)=>ev(seq,'message.instruction',me.id,{messageId:id,text,queueStatus:'pending'});
    const events=[queued(1,'first','Start'),ev(2,'run.started',me.id,{runId:'run-one',instructionId:'first',model:'m',runtimeGeneration:4}),queued(3,'steered','Use cents'),queued(4,'later','Then add tests'),queued(5,'gone','Never mind'),
      ev(6,'instruction.steered',me.id,{instructionId:'steered'}),ev(7,'instruction.removed',me.id,{instructionId:'gone'}),ev(8,'agent.delta',me.id,{runId:'run-one',text:'Working'})];
    const before=project(events);
    expect(queuedInstructions(before.timeline).map(item=>[item.id,item.steer??false])).toEqual([['steered',true],['later',false]]);
    const after=project([...events,ev(9,'instruction.claimed',me.id,{instructionId:'steered',runId:'run-one'})]);
    expect(queuedInstructions(after.timeline).map(item=>item.id)).toEqual(['later']);
    expect(after.timeline.map(item=>item.id)).toEqual(['first','e2','later','agent:run-one','steered']);
    expect(after.timeline.find(item=>item.id==='steered')).toMatchObject({queue:'applied',sequence:9});
    expect(after.timeline.some(item=>item.id==='gone')).toBe(false);
  });
  test('parallel agents show as one card with a column per agent, updated by their events',()=>{
    const run='run-split';
    const events=[ev(1,'run.started',me.id,{runId:run,model:'m',runtimeGeneration:4}),
      ev(2,'activity.completed',me.id,{runId:run,tool:'split',summary:'Split into 2 agents',lanes:[{index:1,title:'API',files:['src/api.js']},{index:2,title:'Page',files:[]},{index:'x',title:7}]}),
      ev(3,'activity.completed',me.id,{runId:run,lane:1,tool:'write_file',summary:'Agent 1 · Updated src/api.js'}),
      ev(4,'activity.completed',me.id,{runId:run,lane:2,tool:'update_plan',summary:'Agent 2 · Plan: 1 of 3 done',plan:{steps:[{text:'a',state:'done'},{text:'b',state:'active'},{text:'c',state:'todo'}]}}),
      ev(5,'activity.completed',me.id,{runId:run,lane:1,tool:'lane',state:'done',summary:'Agent 1 · Finished: API'}),
      ev(6,'activity.failed',me.id,{runId:run,lane:2,tool:'lane',state:'failed',summary:'Agent 2 · Stopped: limit'})];
    const d=project(events);
    const card=d.timeline.find(item=>item.type==='lanes');
    expect(card).toMatchObject({type:'lanes',lanes:[{index:1,title:'API',files:['src/api.js'],state:'done',activity:'Finished: API',steps:1},{index:2,title:'Page',state:'failed',activity:'Stopped: limit',steps:1}]});
    // Agent events live in the card, not as rows, and an agent's checklist isn't the run's plan.
    expect(d.timeline.filter(item=>item.type==='tools'||item.type==='plan')).toEqual([]);
    const merged=project([...events,ev(7,'activity.completed',me.id,{runId:run,tool:'merge',summary:'Merged 1 agents’ work into this chat'})]);
    expect(merged.timeline.find(item=>item.type==='lanes')).toMatchObject({merge:'Merged 1 agents’ work into this chat'});
    const stopped=project([events[0]!,events[1]!,ev(3,'run.stopped',me.id,{runtimeGeneration:4})]);
    expect((stopped.timeline.find(item=>item.type==='lanes') as {lanes:{state:string}[]}).lanes.map(lane=>lane.state)).toEqual(['stopped','stopped']);
  });
  test('groups streamed chunks by run and replaces them with its final completed text',()=>{
    const events=[ev(1,'run.started',me.id,{runId:'run-one',model:'provider-model',runtimeGeneration:4}),ev(2,'agent.delta',me.id,{runId:'run-one',text:'Hello '}),ev(3,'agent.delta',me.id,{runId:'run-one',delta:'team'})];
    const streaming=project(events);
    expect(streaming.status).toBe('running');expect(streaming.generation).toBe(4);
    expect(streaming.timeline.filter(item=>item.type==='agent')).toEqual([expect.objectContaining({id:'agent:run-one',text:'Hello team',streaming:true,model:'provider-model',sequence:2})]);
    const complete=project([...events,ev(4,'agent.completed',me.id,{runId:'run-one',text:'Final answer'}),ev(5,'run.completed',me.id,{runId:'run-one'})]);
    expect(complete.status).toBe('inactive');
    expect(complete.timeline.filter(item=>item.type==='agent')).toEqual([expect.objectContaining({text:'Final answer',streaming:false})]);
  });
  test('fences historical run events behind a newer recovered session generation',()=>{
    const events=[ev(1,'run.started',me.id,{runId:'old-run',model:'provider-model',runtimeGeneration:4}),ev(2,'agent.delta',me.id,{runId:'old-run',text:'Partial work'})];
    const recovered=project(events,{status:'paused',runtimeGeneration:5});
    expect(recovered.status).toBe('paused');expect(recovered.generation).toBe(5);
    expect(recovered.timeline.filter(item=>item.type==='agent')[0]).toMatchObject({streaming:false,text:'Partial work'});
    expect(projectSessionState(session({status:'paused',runtimeGeneration:5}),[...events,ev(3,'run.completed',me.id,{runId:'old-run'})]).status).toBe('paused');
  });
  test('does not replace a complete streamed answer with an explicitly truncated completion preview',()=>{
    const events=[ev(1,'run.started',me.id,{runId:'run-one',model:'provider-model',runtimeGeneration:4}),ev(2,'agent.delta',me.id,{runId:'run-one',text:'The full streamed answer'}),ev(3,'agent.completed',me.id,{runId:'run-one',text:'The full',truncated:true})];
    const d=project(events);
    expect(d.timeline.find(item=>item.type==='agent')).toMatchObject({text:'The full streamed answer',streaming:false});
    const onlyPreview=project([events[0]!,events[2]!]);
    expect(onlyPreview.timeline.find(item=>item.type==='agent')).toMatchObject({text:'The full\n\n[Provider output was truncated before sharing.]'});
  });
  test('keeps unresolved action failures paused and completes resolved failures without invented execution',()=>{
    const started=ev(1,'run.started',me.id,{runId:'run-one',model:'provider-model',runtimeGeneration:4});
    const requested=ev(2,'action.requested',me.id,{actionId:'action-one',kind:'shell',descriptor:{cwd:'/private/host-only-path',argv:['secret command']}});
    const failed=ev(4,'run.failed',me.id,{runId:'run-one'});
    const unresolved=project([started,requested,failed]);
    expect(unresolved.status).toBe('paused');
    expect(JSON.stringify(unresolved.timeline)).not.toContain('/private/host-only-path');
    expect(JSON.stringify(unresolved.timeline)).not.toContain('secret command');
    expect(unresolved.timeline.some(item=>item.type==='approval')).toBe(false);
    const resolved=project([started,requested,ev(3,'action.completed',me.id,{actionId:'action-one'}),failed]);
    expect(resolved.status).toBe('inactive');
  });
  test('preserves decision history and marks explicitly replaced decisions',()=>{
    const d=project([ev(1,'decision.saved',me.id,{id:'decision-one',text:'Use transactions',source:'instruction_resolution'}),ev(2,'decision.saved',other,{id:'decision-two',text:'Use serializable transactions',authorId:other,replacesId:'decision-one',reason:'Concurrent updates'})]);
    expect(d.decisions).toEqual([expect.objectContaining({id:'decision-one',status:'replaced',authorId:me.id}),expect.objectContaining({id:'decision-two',status:'current',authorId:other,reason:'Concurrent updates'})]);
    expect(d.timeline.filter(item=>item.type==='decision')).toHaveLength(2);
  });
  test('keeps a message screenshot and drops anything that is not an inline image',()=>{
    const d=project([ev(1,'message.discussion',me.id,{messageId:'m1',text:'See this',image:'data:image/jpeg;base64,/9j/'}),ev(2,'message.discussion',me.id,{messageId:'m2',text:'And this',image:'https://example.com/x.png'})]);
    const messages=d.timeline.filter(item=>item.type==='message');
    expect(messages[0]).toMatchObject({text:'See this',image:'data:image/jpeg;base64,/9j/'});
    expect(messages[1]).not.toHaveProperty('image');
  });
  test('names the waiting file or command for everyone',()=>{
    const d=project([ev(1,'action.requested',me.id,{actionId:'a',kind:'shell',command:'python3 test_app.py'}),ev(2,'action.requested',me.id,{actionId:'b',kind:'file_write',path:'app.py'})]);
    expect(d.timeline.filter(item=>item.type==='system').map(item=>item.type==='system'?item.text:'')).toEqual(['Running “python3 test_app.py” is waiting for the host’s approval.','A change to app.py is waiting for the host’s approval.']);
  });
  test('shows a catch-up brief as its own card and skips a malformed one',()=>{
    const d=project([ev(1,'brief.created',me.id,{requestId:'r',text:'**Goal** Fix login',model:'muse-wonder-1.0',throughSequence:0}),ev(2,'brief.created',me.id,{model:'muse-wonder-1.0'})]);
    expect(d.timeline.filter(item=>item.type==='brief')).toEqual([expect.objectContaining({type:'brief',text:'**Goal** Fix login',model:'muse-wonder-1.0'})]);
  });
  test('uses only reported usage and bounded shared activity summaries',()=>{
    const d=project([ev(1,'usage.reported',me.id,{}),ev(2,'usage.reported',me.id,{usage:{inputTokens:12}}),ev(3,'activity.completed',me.id,{tool:'read_file',summary:'Read a selected file',output:'x'.repeat(40000),exitCode:0})]);
    expect(d.timeline[0]).toMatchObject({type:'system',text:'Provider-reported usage: 12 input tokens.'});
    expect(JSON.stringify(d.timeline)).not.toContain('0 output tokens');
    const tools=d.timeline.find(item=>item.type==='tools');
    expect(tools?.type==='tools'&&tools.calls[0]?.detail?.length).toBe(32000);
  });
});

describe('agent plan checklist', () => {
  test('one checklist per run, replaced by later updates and bounded', () => {
    const run = 'aaaaaaaa-0000-4000-8000-000000000001';
    const d = projectSession({ session: session(), participants: [], me, events: [
      ev(1, 'activity.completed', me.id, { runId: run, tool: 'update_plan', summary: 'Plan: 0 of 2 done', plan: { steps: [{ text: 'Read cart.js', state: 'active' }, { text: 'Fix total', state: 'todo' }] } }),
      ev(2, 'activity.completed', me.id, { runId: run, tool: 'read_file', summary: 'Read selected workspace file', path: 'cart.js' }),
      ev(3, 'activity.completed', me.id, { runId: run, tool: 'update_plan', summary: 'Plan: 1 of 2 done', plan: { steps: [{ text: 'Read cart.js', state: 'done' }, { text: 'Fix total', state: 'active' }, { text: 'bad', state: 'maybe' }] } }),
    ] });
    const plans = d.timeline.filter((item) => item.type === 'plan');
    expect(plans).toHaveLength(1);
    expect(plans[0]).toMatchObject({ sequence: 1, steps: [{ text: 'Read cart.js', state: 'done' }, { text: 'Fix total', state: 'active' }] });
    expect(d.timeline.map((item) => item.type)).toEqual(['plan', 'tools']);
  });
});
