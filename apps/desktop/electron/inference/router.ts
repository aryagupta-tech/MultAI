import {z} from 'zod';
import {ProviderError,RuntimeError} from '@multai/runtime';
import type {Result} from '../../src/bridge/contract';
import {toError} from '../service/account';
import {ConnectionManager} from './connections';
import {ConnectionError} from './network';
import {HostCoordinator} from './coordinator';
import type {AddConnectionInput} from '../../src/bridge/inference';

const schemas={
  list:z.tuple([]),add:z.tuple([z.object({provider:z.enum(['openai','anthropic','kimi','compatible']),apiKey:z.string().min(1).max(8192),name:z.string().max(120).optional(),baseUrl:z.string().max(2048).optional()}).strict()]),
  remove:z.tuple([z.uuid()]),models:z.tuple([z.uuid()]),connectChatGPT:z.tuple([z.uuid().optional()]),cancelChatGPT:z.tuple([]),
  manageChatGPTUsage:z.tuple([]),acknowledgeChatGPTPlan:z.tuple([z.uuid()]),
  select:z.tuple([z.unknown()]),selection:z.tuple([]),run:z.tuple([z.unknown()]),stop:z.tuple([z.uuid()]),
};
export type InferenceOp=keyof typeof schemas;
export async function routeInference(manager:ConnectionManager,coordinator:HostCoordinator,op:unknown,args:unknown):Promise<Result<unknown>>{
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
    }
    return {ok:true,value};
  }catch(error){
    if(error instanceof ConnectionError||error instanceof ProviderError||error instanceof RuntimeError)return {ok:false,error:{code:error.code,message:error.message}};
    return {ok:false,error:toError(error)};
  }
}
