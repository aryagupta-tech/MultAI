// The host's view of a project session's worktree: where it came from, the live diff, the buttons
// that move work back to the project, and the host's own terminal. Everything here runs on the
// host's computer through the main process; teammates never see paths or terminal output.
import {create} from 'zustand';
import {getBridge} from '../bridge/client';
import type {ServiceError} from '../bridge/contract';
import type {TerminalEvent,WorkSummary} from '../bridge/execution';
import type {FileChange} from '../model/types';
import {useApp} from '../model/store';
import {describe} from './controller';
import {getSelection} from './execution';

const TERMINAL_LIMIT=200_000;
export interface TerminalState {output:string;running:boolean;command:string|null;exit:number|null}
interface WorkState {
  /** undefined: not loaded yet; null: a private-folder session with no project. */
  summary:Record<string,WorkSummary|null|undefined>;
  changes:Record<string,FileChange[]|undefined>;
  busy:Record<string,string|null|undefined>;
  terminal:Record<string,TerminalState|undefined>;
  /** New chat's "Start from" choice: include the host's uncommitted changes. */
  carry:boolean;
}
export const useWork=create<WorkState>()(()=>({summary:{},changes:{},busy:{},terminal:{},carry:true}));

const api=()=>getBridge()?.inference??null;
const failed=(error:ServiceError)=>{useApp.getState().toast(describe(error),'error');};
const patch=<K extends 'summary'|'changes'|'busy'|'terminal'>(key:K,sessionId:string,value:WorkState[K][string])=>
  useWork.setState(state=>({[key]:{...state[key],[sessionId]:value}}) as Partial<WorkState>);

let subscribed=false;
let accountEpoch=0;
const terminals=new Map<string,{epoch:number;id:string|null;events:TerminalEvent[]}>();
/** Clear account-private paths, diffs and terminal output before another account can render. */
export function resetWork():void {
  accountEpoch++;terminals.clear();refreshing.clear();
  useWork.setState({summary:{},changes:{},busy:{},terminal:{}});
}
function subscribe():void {
  const inference=api();
  if(subscribed||!inference)return;
  subscribed=true;
  useApp.subscribe((state,previous)=>{if(state.account?.id!==previous.account?.id)resetWork();});
  inference.onTerminal(onTerminal);
  // A finished run is when the agent's edits settle; refresh the review then.
  inference.onRunChange(change=>{if(change.status!=='running'&&useWork.getState().summary[change.sessionId])void refreshWork(change.sessionId);});
}

/** Creates the worktree for a new session in a project. Failures leave the session in a private folder. */
export async function startWork(sessionId:string,projectId:string,title:string):Promise<void>{
  const inference=api();if(!inference)return;subscribe();
  if(useWork.getState().busy[sessionId])return;
  const epoch=accountEpoch;
  refreshing.delete(sessionId);
  patch('busy',sessionId,'start');
  try{
    const result=await inference.startWork(sessionId,projectId,useWork.getState().carry,title);
    if(epoch!==accountEpoch)return;
    refreshing.delete(sessionId);
    if(!result.ok){failed(result.error);patch('summary',sessionId,null);patch('changes',sessionId,[]);return;}
    patch('summary',sessionId,result.value);
    patch('changes',sessionId,[]);
  }catch{if(epoch===accountEpoch)useApp.getState().toast('The worktree could not be prepared. Reconnect and try again.','error');}
  finally{if(epoch===accountEpoch)patch('busy',sessionId,null);}
}

const refreshing=new Map<string,{promise:Promise<void>}>();
/** Callers asking at the same moment share one refresh. */
export function refreshWork(sessionId:string):Promise<void>{
  const existing=refreshing.get(sessionId);if(existing)return existing.promise;
  const epoch=accountEpoch;
  const request={promise:Promise.resolve()};
  refreshing.set(sessionId,request);
  request.promise=loadWork(sessionId,()=>epoch===accountEpoch&&refreshing.get(sessionId)===request)
    .finally(()=>{if(refreshing.get(sessionId)===request)refreshing.delete(sessionId);});
  return request.promise;
}
async function loadWork(sessionId:string,isCurrent:()=>boolean):Promise<void>{
  const inference=api();if(!inference)return;subscribe();
  try{
    const summary=await inference.workSummary(sessionId);if(!isCurrent())return;
    if(!summary.ok){failed(summary.error);return;}
    patch('summary',sessionId,summary.value);
    if(!summary.value){patch('changes',sessionId,[]);return;}
    const diff=await inference.workDiff(sessionId);if(!isCurrent())return;
    if(diff.ok)patch('changes',sessionId,diff.value);else failed(diff.error);
  }catch{if(isCurrent())useApp.getState().toast('The worktree could not be refreshed. Reconnect and try again.','error');}
}

async function act<T>(sessionId:string,label:string,run:()=>Promise<{ok:true;value:T}|{ok:false;error:ServiceError}|undefined>|undefined):Promise<T|null>{
  subscribe();
  if(useWork.getState().busy[sessionId])return null;
  const epoch=accountEpoch;
  let value:T|null=null;
  patch('busy',sessionId,label);
  try{
    const result=await run();
    if(!result||epoch!==accountEpoch)return null;
    if(!result.ok){failed(result.error);return null;}
    value=result.value;
  }catch{if(epoch===accountEpoch)useApp.getState().toast('The operation could not be confirmed. Refresh before trying again.','error');return null;}
  finally{
    if(epoch===accountEpoch){
      // A refresh started before the mutation may still contain the old diff.
      refreshing.delete(sessionId);
      await refreshWork(sessionId);
      if(epoch===accountEpoch)patch('busy',sessionId,null);
    }
  }
  return epoch===accountEpoch?value:null;
}

export const revertFile=(sessionId:string,file:string)=>act(sessionId,'revert',()=>api()?.workRevert(sessionId,file));
export async function keepOnBranch(sessionId:string,message:string):Promise<boolean>{
  const kept=await act(sessionId,'keep',()=>api()?.workKeep(sessionId,message));
  if(kept)useApp.getState().toast(`Saved on ${kept.branch} (${kept.commit.slice(0,7)}). Your folder wasn’t touched.`,'success');
  return Boolean(kept);
}
export async function applyToFolder(sessionId:string):Promise<boolean>{
  const applied=await act(sessionId,'apply',()=>api()?.workApply(sessionId));
  if(applied)useApp.getState().toast(`Applied ${applied.files.length} file${applied.files.length===1?'':'s'} to your project folder as uncommitted changes.`,'success');
  return Boolean(applied);
}
export async function discardWork(sessionId:string):Promise<boolean>{
  const done=await act(sessionId,'discard',async()=>{const result=await api()?.workDiscard(sessionId);return result?.ok?{ok:true as const,value:true}:result;});
  if(!done)return false;
  useApp.getState().toast('The session’s worktree was removed. The conversation stays.','info');
  return true;
}
/** Muse Wonder (or the selected model) drafts the pull request; the host edits it before anything is sent. */
export async function draftPullRequest(sessionId:string):Promise<{title:string;body:string}|null>{
  const selection=getSelection();
  if(!selection){useApp.getState().toast('Choose a model in Settings to draft the pull request, or write it yourself.','info');return null;}
  return act(sessionId,'draft',()=>api()?.draftPullRequest({sessionId,connectionId:selection.connectionId,model:selection.model}));
}
export async function pushAndOpen(sessionId:string,pr:{title:string;body:string}):Promise<string|null>{
  const opened=await act(sessionId,'push',()=>api()?.workPush(sessionId,pr));
  if(!opened)return null;
  // Created by gh, or GitHub's compare page with the branch preselected; both open in the browser.
  window.open(opened.url,'_blank','noopener');
  useApp.getState().toast(opened.created?'Pull request opened.':'Branch pushed. Finish the pull request on GitHub.','success');
  return opened.url;
}

function onTerminal(event:TerminalEvent):void {
  const command=terminals.get(event.sessionId);
  if(!command||command.epoch!==accountEpoch||(command.id!==null&&command.id!==event.id))return;
  // Output can beat the invoke response. Wait for its ID before accepting those events.
  if(command.id===null){command.events.push(event);return;}
  const current=useWork.getState().terminal[event.sessionId]??{output:'',running:false,command:null,exit:null};
  if(event.kind==='output'){
    const output=(current.output+event.text).slice(-TERMINAL_LIMIT);
    patch('terminal',event.sessionId,{...current,output});
  }else{
    terminals.delete(event.sessionId);
    patch('terminal',event.sessionId,{...current,running:false,exit:event.code,output:`${current.output}${event.stopped?'\n[stopped]\n':event.code?`\n[exit ${event.code}]\n`:''}`.slice(-TERMINAL_LIMIT)});
    if(useWork.getState().summary[event.sessionId])void refreshWork(event.sessionId);
  }
}
export async function runInTerminal(sessionId:string,command:string):Promise<void>{
  const inference=api();if(!inference)return;subscribe();
  const current=useWork.getState().terminal[sessionId]??{output:'',running:false,command:null,exit:null};
  if(current.running)return;
  const operation={epoch:accountEpoch,id:null as string|null,events:[] as TerminalEvent[]};terminals.set(sessionId,operation);
  patch('terminal',sessionId,{...current,running:true,command,exit:null,output:`${current.output}$ ${command}\n`.slice(-TERMINAL_LIMIT)});
  try{
    const result=await inference.terminalRun(sessionId,command);
    if(operation.epoch!==accountEpoch||terminals.get(sessionId)!==operation)return;
    if(!result.ok){terminals.delete(sessionId);patch('terminal',sessionId,{...useWork.getState().terminal[sessionId]!,running:false});failed(result.error);}
    else{
      operation.id=result.value.id;
      const events=operation.events.splice(0);
      for(const event of events)onTerminal(event);
    }
  }catch{if(operation.epoch===accountEpoch&&terminals.get(sessionId)===operation){terminals.delete(sessionId);patch('terminal',sessionId,{...useWork.getState().terminal[sessionId]!,running:false});useApp.getState().toast('The terminal command could not be started. Reconnect and try again.','error');}}
}
export async function stopTerminal(sessionId:string):Promise<void>{
  subscribe();const epoch=accountEpoch;
  try{const result=await api()?.terminalStop(sessionId);if(epoch===accountEpoch&&result&&!result.ok)failed(result.error);}
  catch{if(epoch===accountEpoch)useApp.getState().toast('Stop could not be confirmed. Check the host connection.','error');}
}
export function clearTerminal(sessionId:string):void {
  const current=useWork.getState().terminal[sessionId];
  if(current)patch('terminal',sessionId,{...current,output:''});
}
