import {getBridge} from '../bridge/client';
import type {InferenceSelection} from '../bridge/execution';
import type {ConnectionSummary} from '../bridge/inference';
import type {ServiceError} from '../bridge/contract';
import {useApp} from '../model/store';
import {lastPendingInstruction} from './projection';
import {describe,open} from './controller';

let selected:InferenceSelection|null=null;
let ownerId:string|null=null;
let accountEpoch=0;
let connections:ConnectionSummary[]=[];
const runIssues=new Map<string,{error:ServiceError;connectionId:string}>();
let unsubscribe:(()=>void)|null=null;
const dispatches=new Map<string,Promise<void>>();
const currentUser=()=>useApp.getState().account?.id??null;
const changed=()=>{if(typeof window!=='undefined')window.dispatchEvent(new CustomEvent('multai:selection-changed'));};
const showError=(error:ServiceError,sessionId?:string)=>{
  const selection=getSelection();
  if(sessionId&&selection){runIssues.set(sessionId,{error,connectionId:selection.connectionId});changed();}
  useApp.getState().toast(describe(error),'error');
};
const api=()=>getBridge()?.inference??null;

export function getSelection():InferenceSelection|null {
  return selected&&ownerId===currentUser()?{...selected}:null;
}

export function getSelectedConnection():ConnectionSummary|null {
  const selection=getSelection();
  const connection=selection?connections.find(item=>item.id===selection.connectionId):undefined;
  return connection?{...connection}:null;
}

export function getRunIssue(sessionId:string):ServiceError|null {
  const issue=runIssues.get(sessionId),selection=getSelection();
  return issue&&selection?.connectionId===issue.connectionId?{...issue.error}:null;
}

export function resetExecutionState():void {
  accountEpoch++;selected=null;ownerId=currentUser();connections=[];runIssues.clear();changed();
}
export const resetSelection=resetExecutionState;

/** Refreshes account-private native state; configuring it never starts a run. */
export async function loadConnections():Promise<ConnectionSummary[]> {
  const bridge=getBridge(),inference=bridge?.inference;
  if(!bridge||!inference||useApp.getState().dataMode!=='live')return [];
  if(!unsubscribe){
    const stops=[
      inference.onConnectionsChange(next=>{
        connections=next;
        if(selected&&!next.some(connection=>connection.id===selected!.connectionId&&connection.status==='ready'))selected=null;
        changed();
      }),
      inference.onRunChange(change=>{
        if(change.error)showError(change.error,change.sessionId);
        else if(change.status==='running'){runIssues.delete(change.sessionId);changed();}
        if(useApp.getState().details[change.sessionId])void open(change.sessionId);
      }),
      bridge.service.onAuthChange(state=>{
        if(state.status!=='signed-in'){resetExecutionState();return;}
        if(ownerId!==state.me.id){resetExecutionState();void loadConnections();}
      }),
    ];
    unsubscribe=()=>{for(const stop of stops)stop();};
  }
  const user=currentUser();
  if(!user){resetExecutionState();return [];}
  if(ownerId!==user){resetExecutionState();ownerId=user;}
  const epoch=accountEpoch;
  try{
    const [list,selection]=await Promise.all([inference.list(),inference.selection()]);
    if(epoch!==accountEpoch||user!==currentUser())return [];
    if(list.ok)connections=list.value;
    if(selection.ok)selected=selection.value;
    if(selected&&list.ok&&!connections.some(connection=>connection.id===selected!.connectionId&&connection.status==='ready'))selected=null;
    changed();
    return [...connections];
  }catch{return [];}
}

export async function selectConnection(connectionId:string,model:string,modelName?:string):Promise<void> {
  const inference=api(),user=currentUser();
  if(!inference||!user)return;
  const epoch=accountEpoch;
  try{
    const result=await inference.select({connectionId,model,...(modelName?{modelName}:{})});
    if(epoch!==accountEpoch||user!==currentUser())return;
    if(!result.ok){showError(result.error);return;}
    ownerId=user;selected=result.value;runIssues.clear();changed();
    useApp.getState().toast(`Selected ${modelName??model}. Choose Run instruction to start.`,'success');
  }catch{useApp.getState().toast('The app could not select this AI connection. Try again.','error');}
}

/** Explicit human decision; no timeout, fallback answer or automatic submission. */
async function resolveDirections():Promise<string|null> {
  if(typeof document==='undefined')return null;
  const previous=document.activeElement;
  const openedEpoch=accountEpoch,openedSelection=getSelection();
  const dialog=document.createElement('dialog');
  const form=document.createElement('form');
  const title=document.createElement('h2');title.textContent='Resolve the pending directions';title.id=`owner-decision-${crypto.randomUUID()}`;
  const explanation=document.createElement('p');explanation.textContent='Several people have pending instructions. Write the agreed direction to save as an owner decision before this run starts.';explanation.id=`${title.id}-description`;
  dialog.setAttribute('aria-labelledby',title.id);dialog.setAttribute('aria-describedby',explanation.id);
  const input=document.createElement('textarea');input.required=true;input.maxLength=8000;input.rows=7;input.setAttribute('aria-label','Agreed owner decision');
  const controls=document.createElement('div'),cancel=document.createElement('button'),save=document.createElement('button');
  cancel.type='button';cancel.textContent='Cancel';cancel.className='btn btn-secondary';save.type='submit';save.textContent='Save decision and run';save.className='btn btn-primary';
  Object.assign(dialog.style,{background:'var(--surface-1)',color:'var(--text)',border:'1px solid var(--border-strong)',borderRadius:'14px',padding:'24px',width:'min(520px, 90vw)'});
  Object.assign(form.style,{display:'grid',gap:'14px'});Object.assign(input.style,{width:'100%',resize:'vertical'});Object.assign(controls.style,{display:'flex',justifyContent:'flex-end',gap:'12px'});
  controls.append(cancel,save);form.append(title,explanation,input,controls);dialog.append(form);document.body.append(dialog);
  return new Promise(resolve=>{
    let done=false;
    const canceled=()=>{const latest=getSelection();if(openedEpoch!==accountEpoch||latest?.connectionId!==openedSelection?.connectionId||latest?.model!==openedSelection?.model)finish(null);};
    const finish=(value:string|null)=>{if(done)return;done=true;window.removeEventListener('multai:selection-changed',canceled);dialog.close();dialog.remove();if(previous instanceof HTMLElement)previous.focus();resolve(value);};
    window.addEventListener('multai:selection-changed',canceled);
    cancel.onclick=()=>finish(null);dialog.oncancel=event=>{event.preventDefault();finish(null);};
    form.onsubmit=event=>{event.preventDefault();const value=input.value.trim();if(value)finish(value);else input.focus();};
    dialog.showModal();input.focus();
  });
}

export function runPending(sessionId:string):Promise<void> {
  const existing=dispatches.get(sessionId);if(existing)return existing;
  const request=run(sessionId).finally(()=>{if(dispatches.get(sessionId)===request)dispatches.delete(sessionId);});
  dispatches.set(sessionId,request);return request;
}

async function run(sessionId:string):Promise<void> {
  const state=useApp.getState(),detail=state.details[sessionId],inference=api(),selection=getSelection();
  if(!detail||detail.source!=='live'||!inference)return;
  if(!detail.capabilities.configure){state.toast('Only the original owner on the original host can run this task.','error');return;}
  if(detail.status==='running'){state.toast('This session already has a running agent. Stop it before starting another run.','info');return;}
  if(!selection){state.toast('Connect an AI provider and choose a model first.','info');state.openOverlay('settings','models');return;}
  const instruction=lastPendingInstruction(detail.timeline);
  if(!instruction){state.toast('Send a new agent instruction before running. Previously applied instructions are never repeated automatically.','info');return;}
  const user=currentUser(),epoch=accountEpoch;
  const input={sessionId,instructionId:instruction.id,...selection,...(detail.status==='paused'?{resume:true}:{})};
  try{
    let result=await inference.run(input);
    if(epoch!==accountEpoch||user!==currentUser())return;
    if(!result.ok&&result.error.code==='instruction_conflict'){
      const resolution=await resolveDirections();
      if(!resolution||epoch!==accountEpoch||user!==currentUser())return;
      result=await inference.run({...input,resolution});
    }
    if(epoch!==accountEpoch||user!==currentUser())return;
    if(!result.ok)showError(result.error,sessionId);
    // Use the service snapshot and ordered events rather than inventing local run state.
    await open(sessionId);
  }catch{useApp.getState().toast('The run could not be confirmed. Refresh this session before trying again.','error');}
}

export async function stopRun(sessionId:string):Promise<void> {
  const inference=api();if(!inference)return;
  try{
    const result=await inference.stop(sessionId);
    if(!result.ok)showError(result.error);
    await open(sessionId);
  }catch{useApp.getState().toast('Stop could not be confirmed. Check the host and reconnect before resuming.','error');}
}
