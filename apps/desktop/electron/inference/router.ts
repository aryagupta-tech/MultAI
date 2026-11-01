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
import type {AddConnectionInput} from '../../src/bridge/inference';

const schemas={
  list:z.tuple([]),add:z.tuple([z.object({provider:z.enum(['meta','openai','anthropic','kimi','compatible']),apiKey:z.string().min(1).max(8192),name:z.string().max(120).optional(),baseUrl:z.string().max(2048).optional()}).strict()]),
  remove:z.tuple([z.uuid()]),models:z.tuple([z.uuid()]),connectChatGPT:z.tuple([z.uuid().optional()]),cancelChatGPT:z.tuple([]),
  manageChatGPTUsage:z.tuple([]),acknowledgeChatGPTPlan:z.tuple([z.uuid()]),
  select:z.tuple([z.unknown()]),brief:z.tuple([z.unknown()]),decide:z.tuple([z.uuid(),z.boolean()]),setAccess:z.tuple([z.uuid(),z.enum(['ask','auto','full'])]),approvals:z.tuple([]),selection:z.tuple([]),
  startWork:z.tuple([z.uuid(),z.uuid(),z.boolean(),z.string().max(200)]),projectStatus:z.tuple([z.uuid()]),workSummary:z.tuple([z.uuid()]),workDiff:z.tuple([z.uuid()]),
  workRevert:z.tuple([z.uuid(),z.string().min(1).max(4096)]),workKeep:z.tuple([z.uuid(),z.string().max(2000)]),workApply:z.tuple([z.uuid()]),workDiscard:z.tuple([z.uuid()]),
  draftPullRequest:z.tuple([z.unknown()]),workPush:z.tuple([z.uuid(),z.object({title:z.string().trim().min(1).max(250),body:z.string().max(60_000)}).strict()]),
  terminalRun:z.tuple([z.uuid(),z.string().min(1).max(8000)]),terminalStop:z.tuple([z.uuid()]),run:z.tuple([z.unknown()]),stop:z.tuple([z.uuid()]),
};
export type InferenceOp=keyof typeof schemas;
export async function routeInference(manager:ConnectionManager,coordinator:HostCoordinator,approvals:ApprovalBroker,op:unknown,args:unknown,host:{projects:ProjectRegistry;terminal:TerminalHost}):Promise<Result<unknown>>{
  if(typeof op!=='string'||!Object.hasOwn(schemas,op))return {ok:false,error:{code:'invalid_request',message:'Unknown inference operation.'}};
  const key=op as InferenceOp;
  const parsed=schemas[key].safeParse(args);
  if(!parsed.success)return {ok:false,error:{code:'invalid_request',message:'Inference fields are invalid.'}};
  const values=parsed.data as unknown[];
  try{
    let value:unknown;
    switch(key){
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
      case 'terminalRun':value=host.terminal.run(values[0] as string,await coordinator.terminalRoot(values[0] as string),values[1] as string);break;
      case 'terminalStop':value=host.terminal.stop(values[0] as string);break;
    }
    return {ok:true,value};
  }catch(error){
    if(error instanceof ConnectionError||error instanceof ProviderError||error instanceof RuntimeError||error instanceof ProjectError)return {ok:false,error:{code:error.code,message:error.message}};
    return {ok:false,error:toError(error)};
  }
}
