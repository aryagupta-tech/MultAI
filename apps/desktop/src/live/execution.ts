import {getBridge} from '../bridge/client';
import type {AccessLevel,InferenceSelection} from '../bridge/execution';
import type {ConnectionSummary} from '../bridge/inference';
import type {ServiceError} from '../bridge/contract';
import {useApp} from '../model/store';
import {nextPendingInstruction} from './projection';
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

/** Ready connections, for the composer's model picker. */
export function getConnections():ConnectionSummary[]{return connections.filter(connection=>connection.status==='ready').map(connection=>({...connection}));}

/** How much time and output the agent may spend per run; remembered per account on this device. */
export type Effort='low'|'medium'|'high'|'xhigh'|'max';
const effortKey=(user:string|null)=>`multai.effort.v1:${user??'signed-out'}`;
export function getEffort():Effort {
  try{const value=localStorage.getItem(effortKey(currentUser()));return value==='low'||value==='high'||value==='xhigh'||value==='max'?value:'medium';}catch{return 'medium';}
}
export function setEffort(effort:Effort):void {
  try{localStorage.setItem(effortKey(currentUser()),effort);}catch{/* per-device convenience only */}
  changed();
}

/**
 * Web search is the provider's own (GPT through OpenAI or the ChatGPT plan, and Claude); Muse and other
 * Chat Completions models don't offer it. Off unless the host turns it on for a chat; remembered per device.
 */
export function webSearchSupported():boolean {
  const connection=getSelectedConnection();
  return Boolean(connection&&['meta','openai','chatgpt','anthropic'].includes(connection.provider));
}
const webSearchKey=(user:string|null)=>`multai.web-search.v1:${user??'signed-out'}`;
function storedWebSearch():Record<string,boolean>{
  try{const raw=JSON.parse(localStorage.getItem(webSearchKey(currentUser()))??'{}') as Record<string,unknown>;return Object.fromEntries(Object.entries(raw).filter((entry):entry is [string,boolean]=>entry[1]===true));}catch{return {};}
}
export const getWebSearchChoices=():Record<string,boolean>=>storedWebSearch();
/** sessionId null is the New chat choice, moved to the session when it's created. */
export function getWebSearch(sessionId:string|null):boolean {return Boolean(storedWebSearch()[sessionId??'new']);}
export function setWebSearch(sessionId:string|null,on:boolean):void {
  const all=storedWebSearch();const key=sessionId??'new';
  if(on)all[key]=true;else delete all[key];
  try{localStorage.setItem(webSearchKey(currentUser()),JSON.stringify(all));}catch{/* per-device convenience only */}
  changed();
}

/** Access chosen on New chat, applied once the session exists. Full access is confirmed when chosen. */
let newChatAccess:AccessLevel='ask';
export function getNewChatAccess():AccessLevel {return newChatAccess;}
export async function chooseNewChatAccess(level:AccessLevel):Promise<void>{
  if(level==='full'&&!await confirmFullAccess())return;
  newChatAccess=level;changed();
}
export async function applyNewChatAccess(sessionId:string):Promise<void>{
  if(getWebSearch(null)){setWebSearch(null,false);setWebSearch(sessionId,true);}
  const level=newChatAccess;newChatAccess='ask';changed();
  if(level!=='ask')await setAccessLevel(sessionId,level,{confirmed:true});
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
      inference.onApprovals(pending=>useApp.setState({hostApprovals:pending})),
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
    await restoreAccess(user);
    const approvals=await inference.approvals();if(approvals.ok)useApp.setState({hostApprovals:approvals.value});
    if(selected&&list.ok&&!connections.some(connection=>connection.id===selected!.connectionId&&connection.status==='ready'))selected=null;
    changed();
    return [...connections];
  }catch{return [];}
}

export async function selectConnection(connectionId:string,model:string,modelName?:string,quiet=false):Promise<void> {
  const inference=api(),user=currentUser();
  if(!inference||!user)return;
  const epoch=accountEpoch;
  try{
    const result=await inference.select({connectionId,model,...(modelName?{modelName}:{})});
    if(epoch!==accountEpoch||user!==currentUser())return;
    if(!result.ok){showError(result.error);return;}
    ownerId=user;selected=result.value;runIssues.clear();changed();
    if(!quiet)useApp.getState().toast(`Selected ${modelName??model}. Choose Run instruction to start.`,'success');
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

async function run(sessionId:string,retried=false):Promise<void> {
  const state=useApp.getState(),detail=state.details[sessionId],inference=api(),selection=getSelection();
  if(!detail||detail.source!=='live'||!inference)return;
  if(!detail.capabilities.configure){state.toast('Only the original owner on the original host can run this task.','error');return;}
  if(detail.status==='running'){state.toast('This session already has a running agent. Stop it before starting another run.','info');return;}
  if(!selection){state.toast('Connect an AI provider and choose a model first.','info');state.openOverlay('settings','models');return;}
  const instruction=nextPendingInstruction(detail.timeline);
  if(!instruction){state.toast('Send a new agent instruction before running. Previously applied instructions are never repeated automatically.','info');return;}
  const user=currentUser(),epoch=accountEpoch;
  const input={sessionId,instructionId:instruction.id,...selection,effort:getEffort(),...(getWebSearch(sessionId)&&webSearchSupported()?{webSearch:true}:{}),...(detail.status==='paused'?{resume:true}:{})};
  try{
    let result=await inference.run(input);
    if(epoch!==accountEpoch||user!==currentUser())return;
    if(!result.ok&&result.error.code==='instruction_conflict'){
      const resolution=await resolveDirections();
      if(!resolution||epoch!==accountEpoch||user!==currentUser())return;
      result=await inference.run({...input,resolution});
    }
    if(epoch!==accountEpoch||user!==currentUser())return;
    // This view still listed a message the service already took out of the queue: catch up, then run
    // the next one that is really waiting.
    if(!result.ok&&result.error.code==='instruction_unavailable'&&!retried){await open(sessionId);return run(sessionId,true);}
    if(!result.ok)showError(result.error,sessionId);
    // Use the service snapshot and ordered events rather than inventing local run state.
    await open(sessionId);
  }catch{useApp.getState().toast('The run could not be confirmed. Refresh this session before trying again.','error');}
}

const briefing=new Set<string>();
/** The host writes a catch-up brief with its own connection; quiet=true for the automatic one on admit. */
export async function writeBrief(sessionId:string,quiet=false):Promise<void> {
  const inference=api(),selection=getSelection(),state=useApp.getState();
  if(!inference||briefing.has(sessionId))return;
  if(!selection){if(!quiet){state.toast('Connect an AI provider and choose a model first.','info');state.openOverlay('settings','models');}return;}
  briefing.add(sessionId);
  if(!quiet)state.toast('Writing a catch-up brief…','info');
  try{
    const result=await inference.brief({sessionId,connectionId:selection.connectionId,model:selection.model});
    if(!result.ok){if(!quiet||result.error.code!=='NOTHING_TO_BRIEF')useApp.getState().toast(describe(result.error),'error');return;}
    await open(sessionId);
  }catch{useApp.getState().toast('The catch-up brief could not be written. Try again.','error');}
  finally{briefing.delete(sessionId);}
}

const accessKey=(userId:string)=>`multai.access.v1:${userId}`;
function storedAccess(userId:string):Record<string,AccessLevel>{
  try{const raw=JSON.parse(localStorage.getItem(accessKey(userId))??'{}') as Record<string,unknown>;return Object.fromEntries(Object.entries(raw).filter((entry):entry is [string,AccessLevel]=>entry[1]==='auto'||entry[1]==='full'));}catch{return {};}
}
/** The main process forgets levels on restart; this host's saved choices are re-applied after sign-in. */
async function restoreAccess(userId:string):Promise<void>{
  const levels=storedAccess(userId),inference=api();
  useApp.setState({access:levels});
  if(inference)for(const [sessionId,level] of Object.entries(levels))await inference.setAccess(sessionId,level);
}

/** Host-only. Full access asks for explicit confirmation first. */
export async function setAccessLevel(sessionId:string,level:AccessLevel,options:{confirmed?:boolean}={}):Promise<void>{
  const inference=api(),user=currentUser();if(!inference||!user)return;
  if(level==='full'&&!options.confirmed&&!await confirmFullAccess())return;
  const result=await inference.setAccess(sessionId,level);
  if(!result.ok){useApp.getState().toast(describe(result.error),'error');return;}
  const levels={...storedAccess(user)};if(result.value==='ask')delete levels[sessionId];else levels[sessionId]=result.value;
  try{localStorage.setItem(accessKey(user),JSON.stringify(levels));}catch{/* per-device convenience only */}
  useApp.setState({access:levels});
}

/** Someone new can now send instructions, so Full access drops back to asking. */
export async function narrowAccessForNewcomer(sessionId:string):Promise<void>{
  if(useApp.getState().access[sessionId]!=='full')return;
  await setAccessLevel(sessionId,'ask');
  useApp.getState().toast('Full access is off because someone joined. Turn it on again if you trust everyone here.','info');
}

export async function decideApproval(approvalId:string,approved:boolean):Promise<void>{
  const result=await api()?.decide(approvalId,approved);
  if(result&&!result.ok)useApp.getState().toast(describe(result.error),'error');
}

async function confirmFullAccess():Promise<boolean>{
  if(typeof document==='undefined')return false;
  const previous=document.activeElement;
  const dialog=document.createElement('dialog'),form=document.createElement('form');
  const title=document.createElement('h2');title.textContent='Give the agent full access?';title.id=`full-access-${crypto.randomUUID()}`;
  const explanation=document.createElement('p');explanation.id=`${title.id}-description`;
  explanation.textContent='Every file change and command in this session will run without asking you, including ones teammates ask for. Commands run as your user on this computer and can reach the internet and files outside the workspace. It turns off when someone new joins.';
  dialog.setAttribute('aria-labelledby',title.id);dialog.setAttribute('aria-describedby',explanation.id);
  const controls=document.createElement('div'),cancel=document.createElement('button'),allow=document.createElement('button');
  cancel.type='button';cancel.textContent='Cancel';cancel.className='btn btn-secondary';allow.type='submit';allow.textContent='Allow full access';allow.className='btn btn-danger';
  Object.assign(dialog.style,{background:'var(--surface-1)',color:'var(--text)',border:'1px solid var(--border-strong)',borderRadius:'14px',padding:'24px',width:'min(480px, 90vw)'});
  Object.assign(form.style,{display:'grid',gap:'14px'});Object.assign(controls.style,{display:'flex',justifyContent:'flex-end',gap:'12px'});
  controls.append(cancel,allow);form.append(title,explanation,controls);dialog.append(form);document.body.append(dialog);
  return new Promise(resolve=>{
    const finish=(value:boolean)=>{dialog.close();dialog.remove();if(previous instanceof HTMLElement)previous.focus();resolve(value);};
    cancel.onclick=()=>finish(false);dialog.oncancel=event=>{event.preventDefault();finish(false);};
    form.onsubmit=event=>{event.preventDefault();finish(true);};
    dialog.showModal();cancel.focus();
  });
}

export async function stopRun(sessionId:string):Promise<void> {
  const inference=api();if(!inference)return;
  try{
    const result=await inference.stop(sessionId);
    if(!result.ok)showError(result.error);
    await open(sessionId);
  }catch{useApp.getState().toast('Stop could not be confirmed. Check the host and reconnect before resuming.','error');}
}
