import {renderToStaticMarkup} from 'react-dom/server';
import {beforeEach,describe,expect,it,vi} from 'vitest';
import type {WireEvent,WireMe,WireSession} from '../bridge/wire';
import type {TimelineItem} from '../model/types';
import {useApp} from '../model/store';
import {projectSession} from '../live/projection';
import {Conversation} from './Conversation';
import {activitySummary,groupActivity} from './activity';

vi.mock('../model/store',async(importOriginal)=>{
  const actual=await importOriginal<typeof import('../model/store')>();
  const current=<T,>(selector:(state:ReturnType<typeof actual.useApp.getState>)=>T)=>selector(actual.useApp.getState());
  return {...actual,useApp:Object.assign(current,actual.useApp)};
});

const me:WireMe={id:'host',displayName:'Host',workspaceId:'workspace',deviceId:'device'};
const session:WireSession={id:'session',workspaceId:me.workspaceId,ownerId:me.id,title:'Fix checkout',mode:'build',status:'running',runtimeGeneration:1,lastSequence:0,role:'owner',createdAt:'2026-11-02T10:00:00Z',updatedAt:'2026-11-02T10:00:00Z',capabilities:{submit:true,manage:true,execute:true}};
const event=(sequence:number,type:string,payload:unknown):WireEvent=>({id:`e${sequence}`,sessionId:session.id,sequence,type,actorId:me.id,payload,createdAt:'2026-11-02T10:00:00Z'});
const project=(events:WireEvent[])=>projectSession({session,me,participants:[{userId:me.id,role:'owner',admittedAt:session.createdAt}],events});
const events=[
  event(1,'run.started',{runId:'run',model:'Fixture',runtimeGeneration:1}),
  event(2,'activity.completed',{tool:'read_file',summary:'Read selected workspace file',path:'checkout.ts'}),
  event(3,'action.requested',{actionId:'command',kind:'shell',command:'npm test'}),
  event(4,'action.approved',{actionId:'command'}),
  event(5,'action.consumed',{actionId:'command'}),
  event(6,'action.completed',{actionId:'command'}),
  event(7,'activity.completed',{tool:'run_command',summary:'Host-approved command completed',result:{output:'All checkout tests passed\n',exitCode:0}}),
  event(8,'usage.reported',{usage:{inputTokens:200,outputTokens:30}}),
  event(9,'agent.completed',{runId:'run',text:'Checkout is fixed. The regression tests pass.'}),
  event(10,'run.completed',{runId:'run'}),
];
beforeEach(()=>useApp.setState({hostApprovals:[],prefs:{...useApp.getState().prefs,showToolDetails:false}}));

describe('compact agent activity',()=>{
  it('collapses a real action lifecycle into one summary and retains the full source timeline',()=>{
    const detail=project(events),original=JSON.stringify(detail.timeline),rows=groupActivity(detail.timeline);
    expect(rows.map(row=>row.type)).toEqual(['activity','agent']);
    const group=rows[0];if(group?.type!=='activity')throw new Error('Expected activity');
    expect(activitySummary(group.calls)).toBe('Read 1 file, ran 1 command');
    expect(group.items.filter(item=>item.eventType?.startsWith('action.'))).toHaveLength(4);
    expect(group.calls.find(call=>call.tool==='shell')).toMatchObject({detail:'All checkout tests passed\n',exitCode:0,status:'completed'});
    expect(JSON.stringify(detail.timeline)).toBe(original);
    const html=renderToStaticMarkup(<Conversation d={detail}/>);
    expect(html.match(/<details class="activity-group"[^>]*>/gu)).toEqual(['<details class="activity-group">']);
    expect(html).toContain('Read 1 file, ran 1 command');expect(html).toContain('Checkout is fixed.');
    expect(html).not.toContain('class="system-row');
    expect(html).toContain('You approved the reviewed action');
  });

  it('keeps actual pending host approvals outside the collapsed activity',()=>{
    const detail=project(events.slice(0,3));
    useApp.setState({hostApprovals:[{id:'pending-native',sessionId:session.id,kind:'shell',command:'npm test',reason:'Review this command.',expiresAt:new Date(Date.now()+60_000).toISOString()}]});
    const rows=groupActivity(detail.timeline);
    expect(rows.at(-1)).toMatchObject({type:'system',eventType:'action.requested',tone:'warn'});
    const html=renderToStaticMarkup(<Conversation d={detail}/>);
    expect(html).toContain('aria-label="Approval needed"');expect(html).toContain('Run a command?');
    expect(html).toContain('>Approve</span></button>');expect(html).toContain('>Reject</span></button>');
    expect(html.indexOf('aria-label="Approval needed"')).toBeGreaterThan(html.indexOf('</details>'));
  });

  it('keeps failed command output, cancellation and uncertainty visible',()=>{
    const detail=project([
      events[1]!,
      event(3,'activity.completed',{tool:'run_command',summary:'Checkout tests',result:{output:'Expected one order; received two\n',exitCode:1}}),
      event(4,'action.canceled',{actionId:'stopped'}),event(5,'action.uncertain',{actionId:'uncertain'}),event(6,'run.failed',{runId:'run'}),
    ]);
    expect(groupActivity(detail.timeline).map(row=>row.type)).toEqual(['activity','tools','system','system','system']);
    const html=renderToStaticMarkup(<Conversation d={detail}/>);
    expect(html).toContain('Expected one order; received two');expect(html).toContain('1 need review');
    expect(html).toContain('pending action was canceled');expect(html).toContain('outcome is uncertain');expect(html).toContain('agent run failed');
  });

  it('preserves messages, conflicts and questions as separate visible boundaries',()=>{
    const base={id:'boundary',sequence:1,at:session.createdAt};
    const boundary:TimelineItem[]=[{...base,type:'message',kind:'instruction',authorId:me.id,text:'Keep attribution'},
      {...base,id:'conflict',type:'conflict',instructionIds:['one','two'],resolved:false},
      {...base,id:'question',type:'question',prompt:'Which checkout?',options:['Shop','Admin']},
      {...base,id:'unrelated',type:'system',tone:'info',text:'The approved action completed.'}];
    expect(groupActivity(boundary)).toEqual(boundary);
  });

  it('keeps running tools collapsed by default without claiming they finished',()=>{
    const detail=project([]);
    detail.timeline=[{id:'running',sequence:1,at:session.createdAt,type:'tools',calls:[{id:'read',tool:'read',summary:'Read checkout.ts',status:'running'}]}];
    const html=renderToStaticMarkup(<Conversation d={detail}/>);
    expect(html).toContain('Reading 1 file');expect(html).toContain('aria-label="Working"');
    expect(html).toContain('<details class="activity-group">');
    useApp.setState({prefs:{...useApp.getState().prefs,showToolDetails:true}});
    expect(renderToStaticMarkup(<Conversation d={detail}/>)).toContain('<details class="activity-group" open="">');
  });
});
