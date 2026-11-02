import {z} from 'zod';
import {ProviderError,RuntimeError} from '@multai/runtime';
import type {Result} from '../../src/bridge/contract';
import {toError} from '../service/account';
import {ConnectionManager} from './connections';
import {ConnectionError} from './network';
import {HostCoordinator} from './coordinator';
import type {ApprovalBroker} from './approvals';
import {ProjectError,type ProjectRegistry} from './projects';
import type {TerminalHost} from './terminal';
import {SkillError} from './skills';
import {McpError,type McpServer} from './mcp';
import type {AddConnectionInput} from '../../src/bridge/inference';
import {MAX_PCM_BYTES,VoiceError,chooseVoiceConnection,transcribeMeta,transcribeOpenAI} from './voice';
import {publicProviderFetch} from './network';
import {SegmentError,metaConnection,segmentPoint,type Point} from './segment';

/** Speech to text with the host's own Meta or OpenAI connection. */
async function transcribe(manager:ConnectionManager,coordinator:HostCoordinator,audio:string):Promise<{text:string;provider:'meta'|'openai'}>{
  const connection=chooseVoiceConnection(await manager.list(),(await coordinator.selection())?.connectionId??null);
  if(!connection)throw new VoiceError('VOICE_UNAVAILABLE','Voice needs a Meta (Muse Voice Transcribe) or OpenAI connection. Add one in Settings → Models.');
  const credentials=await manager.resolve(connection.id);
  const pcm=Buffer.from(audio,'base64');
  const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),60_000);timer.unref();
  try{
    const text=connection.provider==='meta'?await transcribeMeta(credentials,pcm,controller.signal):await transcribeOpenAI(credentials,pcm,publicProviderFetch,controller.signal);
    return {text,provider:connection.provider==='meta'?'meta':'openai'};
  }finally{clearTimeout(timer);}
}

const schemas={
  conflictContext:z.tuple([z.uuid()]),analyzeConflict:z.tuple([z.unknown()]),verify:z.tuple([z.unknown()]),syncVerification:z.tuple([z.uuid()]),
  list:z.tuple([]),add:z.tuple([z.object({provider:z.enum(['meta','openai','anthropic','kimi','compatible','local']),apiKey:z.string().min(1).max(8192).optional(),name:z.string().max(120).optional(),baseUrl:z.string().max(2048).optional()}).strict()]),
  remove:z.tuple([z.uuid()]),models:z.tuple([z.uuid()]),connectChatGPT:z.tuple([z.uuid().optional()]),cancelChatGPT:z.tuple([]),
  manageChatGPTUsage:z.tuple([]),acknowledgeChatGPTPlan:z.tuple([z.uuid()]),
  select:z.tuple([z.unknown()]),brief:z.tuple([z.unknown()]),decide:z.tuple([z.uuid(),z.boolean()]),setAccess:z.tuple([z.uuid(),z.enum(['ask','auto','full'])]),approvals:z.tuple([]),selection:z.tuple([]),
  startWork:z.tuple([z.uuid(),z.uuid(),z.boolean(),z.string().max(200)]),projectStatus:z.tuple([z.uuid()]),workSummary:z.tuple([z.uuid()]),workDiff:z.tuple([z.uuid()]),
  workRevert:z.tuple([z.uuid(),z.string().min(1).max(4096)]),workKeep:z.tuple([z.uuid(),z.string().max(2000)]),workApply:z.tuple([z.uuid()]),workDiscard:z.tuple([z.uuid()]),
  draftPullRequest:z.tuple([z.unknown()]),workPush:z.tuple([z.uuid(),z.object({title:z.string().trim().min(1).max(250),body:z.string().max(60_000)}).strict()]),
  terminalRun:z.tuple([z.uuid(),z.string().min(1).max(8000)]),terminalStop:z.tuple([z.uuid()]),run:z.tuple([z.unknown()]),stop:z.tuple([z.uuid()]),
  listFiles:z.tuple([z.uuid().nullable(),z.uuid().nullable()]),skills:z.tuple([z.uuid().nullable(),z.uuid().nullable()]),
  saveSkill:z.tuple([z.object({name:z.string().min(1).max(48),description:z.string().max(300),body:z.string().min(1).max(32_000)}).strict()]),deleteSkill:z.tuple([z.string().min(1).max(48)]),
  segment:z.tuple([z.string().min(1).max(12_000_000),z.object({x:z.number().int().min(0),y:z.number().int().min(0),width:z.number().int().min(1).max(20_000),height:z.number().int().min(1).max(20_000)}).strict()]),
  segmentAvailable:z.tuple([]),
  transcribe:z.tuple([z.string().min(1).max(Math.ceil(MAX_PCM_BYTES/3)*4).regex(/^[A-Za-z0-9+/]+={0,2}$/u)]),
  compact:z.tuple([z.unknown()]),contextUsage:z.tuple([z.uuid()]),usageLimits:z.tuple([z.uuid()]),undoPreview:z.tuple([z.uuid()]),undo:z.tuple([z.uuid()]),
  editors:z.tuple([]),mcpServers:z.tuple([]),mcpDelete:z.tuple([z.uuid()]),mcpTest:z.tuple([z.uuid()]),
  mcpSave:z.tuple([z.object({id:z.string().max(64),name:z.string().max(64),command:z.string().max(1024),args:z.array(z.string().max(4096)).max(64),env:z.record(z.string().max(128),z.string().max(8192)),enabled:z.boolean()}).strict()]),lockedActions:z.tuple([z.uuid()]),resolveLocked:z.tuple([z.uuid(),z.uuid(),z.enum(['happened','did_not_happen'])]),openIn:z.tuple([z.uuid(),z.enum(['vscode','cursor','zed','finder'])]),
};
export type InferenceOp=keyof typeof schemas;
export type Editor='vscode'|'cursor'|'zed'|'finder';
export async function routeInference(manager:ConnectionManager,coordinator:HostCoordinator,approvals:ApprovalBroker,op:unknown,args:unknown,host:{projects:ProjectRegistry;terminal:TerminalHost;editors:()=>Promise<Editor[]>;openIn:(folder:string,editor:Editor)=>Promise<void>;
  mcp:{list:()=>Promise<unknown>;save:(server:McpServer)=>Promise<unknown>;remove:(id:string)=>Promise<null>;test:(id:string)=>Promise<string[]>}}):Promise<Result<unknown>>{
  if(typeof op!=='string'||!Object.hasOwn(schemas,op))return {ok:false,error:{code:'invalid_request',message:'Unknown inference operation.'}};
  const key=op as InferenceOp;
  const parsed=schemas[key].safeParse(args);
  if(!parsed.success)return {ok:false,error:{code:'invalid_request',message:'Inference fields are invalid.'}};
  const values=parsed.data as unknown[];
  try{
    let value:unknown;
    switch(key){
      case 'conflictContext':value=await coordinator.conflictContext(values[0] as string);break;
      case 'analyzeConflict':value=await coordinator.analyzeConflict(values[0]);break;
      case 'verify':value=await coordinator.verify(values[0]);break;
      case 'syncVerification':value=await coordinator.syncVerification(values[0] as string);break;
      case 'list':value=await manager.list();break;
      case 'add':value=await manager.add(values[0] as AddConnectionInput);break;
      case 'remove':await coordinator.invalidate();await manager.remove(values[0] as string);value=null;break;
      case 'models':value=await manager.models(values[0] as string);break;
      case 'connectChatGPT':await coordinator.invalidate();value=await manager.connectChatGPT(values[0] as string|undefined);break;
      case 'cancelChatGPT':await manager.cancelChatGPT();value=null;break;
      case 'manageChatGPTUsage':await manager.manageChatGPTUsage();value=null;break;
      case 'acknowledgeChatGPTPlan':await manager.acknowledgeChatGPTPlan(values[0] as string);value=null;break;
      case 'select':value=await coordinator.select(values[0]);break;
      case 'selection':value=await coordinator.selection();break;
      case 'run':value=await coordinator.run(values[0]);break;
      case 'stop':value=await coordinator.stop(values[0] as string);break;
      case 'brief':value=await coordinator.brief(values[0]);break;
      case 'decide':value=approvals.decide(values[0] as string,values[1]);break;
      case 'setAccess':value=approvals.setAccess(values[0] as string,values[1]);break;
      case 'approvals':value=approvals.list();break;
      case 'startWork':await coordinator.prepareWorkspace(values[0] as string,{projectId:values[1] as string,carry:values[2] as boolean,title:values[3] as string});value=await coordinator.workSummary(values[0] as string);break;
      case 'projectStatus':value=await host.projects.status(values[0] as string);break;
      case 'workSummary':value=await coordinator.workSummary(values[0] as string);break;
      case 'workDiff':value=await coordinator.workDiff(values[0] as string);break;
      case 'workRevert':value=await coordinator.workRevert(values[0] as string,values[1] as string);break;
      case 'workKeep':value=await coordinator.workKeep(values[0] as string,values[1] as string);break;
      case 'workApply':value=await coordinator.workApply(values[0] as string);break;
      case 'workDiscard':value=await coordinator.workDiscard(values[0] as string);break;
      case 'draftPullRequest':value=await coordinator.draftPullRequest(values[0]);break;
      case 'workPush':value=await coordinator.workPush(values[0] as string,values[1] as {title:string;body:string});break;
      case 'terminalRun':{
        const sessionId=values[0] as string,generation=host.terminal.generation(sessionId);
        await coordinator.invalidateVerification(sessionId);
        const root=await coordinator.terminalRoot(sessionId);
        value=host.terminal.run(sessionId,root,values[1] as string,generation);break;
      }
      case 'terminalStop':value=host.terminal.stop(values[0] as string);break;
      case 'listFiles':value=await coordinator.listFiles(values[0] as string|null,values[1] as string|null);break;
      case 'skills':value=await coordinator.skills(values[0] as string|null,values[1] as string|null);break;
      case 'saveSkill':value=await coordinator.saveSkill(values[0] as {name:string;description:string;body:string});break;
      case 'deleteSkill':value=await coordinator.deleteSkill(values[0] as string);break;
      case 'compact':value=await coordinator.compact(values[0]);break;
      case 'contextUsage':value=await coordinator.contextUsage(values[0] as string);break;
      case 'usageLimits':value=await coordinator.usageLimits(values[0] as string);break;
      case 'transcribe':value=await transcribe(manager,coordinator,values[0] as string);break;
      case 'segmentAvailable':value=Boolean(metaConnection(await manager.list(),null));break;
      case 'segment':{
        const connection=metaConnection(await manager.list(),(await coordinator.selection())?.connectionId??null);
        if(!connection)throw new SegmentError('SEGMENT_UNAVAILABLE','Outlining with SAM 3.1 needs a Meta connection. Drag a box around the problem instead.');
        const controller=new AbortController();const timer=setTimeout(()=>controller.abort(),45_000);timer.unref();
        try{value=await segmentPoint(await manager.resolve(connection.id),values[0] as string,values[1] as Point,publicProviderFetch,controller.signal);}finally{clearTimeout(timer);}
        break;
      }
      case 'undoPreview':value=await coordinator.undoPreview(values[0] as string);break;
      case 'undo':value=await coordinator.undo(values[0] as string);break;
      case 'editors':value=await host.editors();break;
      case 'mcpServers':value=await host.mcp.list();break;
      case 'mcpSave':value=await host.mcp.save(values[0] as McpServer);break;
      case 'mcpDelete':value=await host.mcp.remove(values[0] as string);break;
      case 'mcpTest':value=await host.mcp.test(values[0] as string);break;
      case 'lockedActions':value=await coordinator.lockedActions(values[0] as string);break;
      case 'resolveLocked':value=await coordinator.resolveLocked(values[0] as string,values[1] as string,values[2] as 'happened'|'did_not_happen');break;
      case 'openIn':await host.openIn(await coordinator.terminalRoot(values[0] as string),values[1] as Editor);value=null;break;
    }
    return {ok:true,value};
  }catch(error){
    if(error instanceof ConnectionError||error instanceof ProviderError||error instanceof RuntimeError||error instanceof ProjectError||error instanceof SkillError||error instanceof McpError||error instanceof VoiceError||error instanceof SegmentError)return {ok:false,error:{code:error.code,message:error.message}};
    return {ok:false,error:toError(error)};
  }
}
