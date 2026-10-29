import type {Result} from './contract';
export interface InferenceSelection {connectionId:string;model:string;modelName?:string}
export interface StartInferenceInput extends InferenceSelection {sessionId:string;instructionId:string;resume?:boolean;resolution?:string}
export interface HostRunChange {sessionId:string;status:'running'|'completed'|'failed'|'stopped';error?:{code:string;message:string}}
export interface HostExecutionApi {
  select(input:InferenceSelection):Promise<Result<InferenceSelection>>;
  selection():Promise<Result<InferenceSelection|null>>;
  run(input:StartInferenceInput):Promise<Result<{runId:string}>>;
  stop(sessionId:string):Promise<Result<null>>;
  onRunChange(listener:(change:HostRunChange)=>void):()=>void;
}
export const INFERENCE_IPC={invoke:'multai:inference',connections:'multai:inference-connections',run:'multai:inference-run'} as const;
