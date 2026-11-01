// The composer's helpers on the host: the file list behind @, skills behind /, the context meter,
// compaction, undo and opening the worktree in an editor. Lists come from the main process and are
// cached briefly; paths never leave this computer.
import {create} from 'zustand';
import {getBridge} from '../bridge/client';
import type {ContextUsage,Editor,SkillInfo,UndoPreview} from '../bridge/execution';
import {useApp} from '../model/store';
import {describe,open,setMode} from './controller';
import {getSelection,runPending,writeBrief} from './execution';
import {refreshWork,runInTerminal,useWork} from './work';

export type AssistDialog={kind:'undo';sessionId:string;preview:UndoPreview}|{kind:'skills';sessionId:string|null;projectId:string|null}|{kind:'help'};
interface AssistState {
  files:Record<string,{files:string[];truncated:boolean;at:number}|undefined>;
  skills:Record<string,SkillInfo[]|undefined>;
  usage:Record<string,ContextUsage|null|undefined>;
  editors:Editor[]|null;
  compacting:Record<string,boolean|undefined>;
  dialog:AssistDialog|null;
}
export const useAssist=create<AssistState>()(()=>({files:{},skills:{},usage:{},editors:null,compacting:{},dialog:null}));

const api=()=>getBridge()?.inference??null;
const toast=(text:string,tone:'info'|'success'|'error'='info')=>useApp.getState().toast(text,tone);
const keyOf=(sessionId:string|null,projectId:string|null)=>sessionId??`project:${projectId??'none'}`;
const FILES_TTL=15_000;

const loadingFiles=new Map<string,Promise<void>>();
/** Files for @: refreshed at most every 15 seconds per session (or project, before its first chat). */
export function loadFiles(sessionId:string|null,projectId:string|null):Promise<void>{
  const key=keyOf(sessionId,projectId);
  const cached=useAssist.getState().files[key];
  if(cached&&Date.now()-cached.at<FILES_TTL)return Promise.resolve();
  const existing=loadingFiles.get(key);if(existing)return existing;
  const request=(async()=>{
    const result=await api()?.listFiles(sessionId,projectId);
    if(result?.ok)useAssist.setState(state=>({files:{...state.files,[key]:{...result.value,at:Date.now()}}}));
  })().finally(()=>loadingFiles.delete(key));
  loadingFiles.set(key,request);return request;
}
export const filesFor=(state:AssistState,sessionId:string|null,projectId:string|null)=>state.files[keyOf(sessionId,projectId)];

export async function loadSkills(sessionId:string|null,projectId:string|null):Promise<void>{
  const result=await api()?.skills(sessionId,projectId);
  if(result?.ok)useAssist.setState(state=>({skills:{...state.skills,[keyOf(sessionId,projectId)]:result.value}}));
}
export const skillsFor=(state:AssistState,sessionId:string|null,projectId:string|null)=>state.skills[keyOf(sessionId,projectId)];
export async function saveSkill(input:{name:string;description:string;body:string},scope:{sessionId:string|null;projectId:string|null}):Promise<boolean>{
  const result=await api()?.saveSkill(input);
  if(!result)return false;
  if(!result.ok){toast(describe(result.error),'error');return false;}
  toast(`Saved the “${result.value.name}” skill. Use it with /${result.value.name}.`,'success');
  await loadSkills(scope.sessionId,scope.projectId);return true;
}
export async function deleteSkill(name:string,scope:{sessionId:string|null;projectId:string|null}):Promise<void>{
  const result=await api()?.deleteSkill(name);
  if(result&&!result.ok){toast(describe(result.error),'error');return;}
  await loadSkills(scope.sessionId,scope.projectId);
}

export async function loadUsage(sessionId:string):Promise<void>{
  const result=await api()?.contextUsage(sessionId);
  if(result?.ok)useAssist.setState(state=>({usage:{...state.usage,[sessionId]:result.value}}));
}

let subscribed=false;
/** Usage changes when a run starts and ends; the file list when a run or a terminal command finishes. */
export function subscribeAssist():void {
  const inference=api();if(subscribed||!inference)return;subscribed=true;
  inference.onRunChange(change=>{
    void loadUsage(change.sessionId);
    if(change.status!=='running')useAssist.setState(state=>({files:{...state.files,[change.sessionId]:undefined}}));
  });
}

export async function compact(sessionId:string):Promise<void>{
  const inference=api(),selection=getSelection();
  if(!inference)return;
  if(!selection){toast('Choose a model first: compacting uses it to write the summary.','info');useApp.getState().openOverlay('settings','models');return;}
  if(useAssist.getState().compacting[sessionId])return;
  useAssist.setState(state=>({compacting:{...state.compacting,[sessionId]:true}}));
  toast('Summarizing the conversation…');
  try{
    const result=await inference.compact({sessionId,connectionId:selection.connectionId,model:selection.model});
    if(!result.ok){toast(describe(result.error),'error');return;}
    toast('Context compacted. The agent continues from the summary.','success');
    await Promise.all([open(sessionId),loadUsage(sessionId)]);
  }finally{useAssist.setState(state=>({compacting:{...state.compacting,[sessionId]:false}}));}
}

export async function askUndo(sessionId:string):Promise<void>{
  const result=await api()?.undoPreview(sessionId);
  if(!result)return;
  if(!result.ok){toast(describe(result.error),'error');return;}
  if(!result.value){toast('There is no earlier run to undo in this session.');return;}
  if(!result.value.files.length){toast('The files already match how they were before the last run.');return;}
  useAssist.setState({dialog:{kind:'undo',sessionId,preview:result.value}});
}
export async function undo(sessionId:string):Promise<boolean>{
  const result=await api()?.undo(sessionId);
  if(!result)return false;
  if(!result.ok){toast(describe(result.error),'error');return false;}
  toast(`Undid the last run: ${result.value.files.length} file${result.value.files.length===1?'':'s'} put back.`,'success');
  await refreshWork(sessionId);return true;
}

export async function loadEditors():Promise<void>{
  if(useAssist.getState().editors)return;
  const result=await api()?.editors();
  if(result?.ok)useAssist.setState({editors:result.value});
}
export async function openIn(sessionId:string,editor:Editor):Promise<void>{
  const result=await api()?.openIn(sessionId,editor);
  if(result&&!result.ok)toast(describe(result.error),'error');
}

/** Starts the agent on the host's own instruction when Run-on-send is on and nothing else is running. */
export function autoRun(sessionId:string):void {
  const app=useApp.getState();const detail=app.details[sessionId];
  if(!app.prefs.autoRun||!getSelection()||!detail||detail.source!=='live'||!detail.capabilities.configure||detail.status==='running')return;
  void runPending(sessionId);
}

/**
 * Runs a command that acts in MultAI. Returns false for names it doesn't handle, so the draft is sent
 * as an instruction instead (agent commands and skills are expanded by the host).
 */
export async function runAppCommand(name:string,args:string,context:{sessionId:string|null;projectId:string|null;draftKey:string}):Promise<boolean>{
  const app=useApp.getState();const {sessionId}=context;
  const needSession=()=>{if(!sessionId)toast('Start a chat first, then use this command.');return Boolean(sessionId);};
  switch(name){
    case 'plan':case 'build':{
      if(!needSession())return true;
      const detail=app.details[sessionId!];
      if(detail?.source!=='live')app.setMode(sessionId!,name);
      else if(detail.mode!==name)await setMode(sessionId!,name);
      app.setDraft(context.draftKey,{text:args});
      // The rest of the draft goes to the agent in the new mode.
      if(args)useApp.getState().send(context.draftKey,'instruction',sessionId!);
      else toast(name==='plan'?'Plan mode: the agent reads and plans, and won’t edit files or run commands.':'Build mode: the agent can edit files and run commands, with your approval.');
      return true;
    }
    case 'compact':if(needSession())await compact(sessionId!);break;
    case 'undo':if(needSession()){if(!useWork.getState().summary[sessionId!]){toast('Undo works in chats inside a project.');break;}await askUndo(sessionId!);}break;
    case 'diff':if(needSession())app.setInspector(true,'changes');break;
    case 'terminal':if(needSession())app.setInspector(true,'terminal');break;
    case 'pr':
      if(!needSession())break;
      app.setInspector(true,'changes');
      setTimeout(()=>window.dispatchEvent(new CustomEvent('multai:open-pr',{detail:sessionId})),50);break;
    case 'brief':if(needSession())await writeBrief(sessionId!);break;
    case 'skills':useAssist.setState({dialog:{kind:'skills',sessionId,projectId:context.projectId}});break;
    case 'new':app.newChat(context.projectId);break;
    case 'help':useAssist.setState({dialog:{kind:'help'}});break;
    default:return false;
  }
  app.setDraft(context.draftKey,{text:''});
  return true;
}

/** `!command`: runs in the session's terminal and opens it. */
export async function runShortcutCommand(sessionId:string|null,command:string,draftKey:string):Promise<void>{
  if(!sessionId){toast('Start a chat first: commands run in the chat’s own folder.');return;}
  useApp.getState().setInspector(true,'terminal');
  useApp.getState().setDraft(draftKey,{text:''});
  await runInTerminal(sessionId,command);
}
