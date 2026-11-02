import type {TimelineItem,ToolCall} from '../model/types';

type ActivityItem=Extract<TimelineItem,{type:'tools'|'system'}>;
export interface ActivityGroup {
  type:'activity';
  id:string;
  items:ActivityItem[];
  calls:ToolCall[];
}
export type ConversationItem=TimelineItem|ActivityGroup;

const ROUTINE=new Set(['run.started','run.completed','action.approved','action.consumed','action.completed','usage.reported','activity.completed']);
const SETTLED=new Set(['action.approved','action.consumed','action.completed','action.rejected','action.canceled','action.uncertain']);
const BOOKKEEPING_ONLY=new Set(['run.started','run.completed','usage.reported']);

/** Compact only successful agent activity. Questions, failures and live approvals stay in place. */
export function groupActivity(timeline:readonly TimelineItem[]):ConversationItem[]{
  const settled=new Set(timeline.filter(item=>item.actionId&&SETTLED.has(item.eventType??'')).map(item=>item.actionId!));
  const rows:ConversationItem[]=[];
  let group:ActivityGroup|null=null;
  const flush=()=>{
    if(group&&!group.items.every(item=>BOOKKEEPING_ONLY.has(item.eventType??'')))rows.push(group);
    group=null;
  };
  for(const item of timeline){
    const compact=item.type==='tools'
      ? item.calls.every(call=>call.status!=='failed'&&call.status!=='uncertain')
      : item.type==='system'&&(item.tone==='info'&&ROUTINE.has(item.eventType??'')
        ||item.eventType==='action.requested'&&Boolean(item.actionId&&settled.has(item.actionId)));
    if(!compact){flush();rows.push(item);continue;}
    if(!group)group={type:'activity',id:`activity:${item.id}`,items:[],calls:[]};
    group.items.push(item as ActivityItem);
    if(item.type==='tools')group.calls.push(...item.calls);
  }
  flush();return rows;
}

export function activitySummary(calls:readonly ToolCall[]):string{
  const phrases:string[]=[];
  const labels:Record<ToolCall['tool'],[string,string,string]>={read:['read','reading','file'],search:['searched','searching','time'],list:['listed','listing','folder'],write:['edited','editing','file'],shell:['ran','running','command'],diff:['reviewed','reviewing','diff']};
  for(const tool of ['read','search','list','write','shell','diff'] as const){
    const selected=calls.filter(call=>call.tool===tool);if(!selected.length)continue;
    const [past,present,noun]=labels[tool];
    const verb=selected.some(call=>call.status==='running'||call.status==='pending')?present:past;
    phrases.push(`${verb} ${selected.length} ${noun}${selected.length===1?'':'s'}`);
  }
  const text=phrases.join(', ');
  return text?text[0]!.toUpperCase()+text.slice(1):'Agent activity';
}
