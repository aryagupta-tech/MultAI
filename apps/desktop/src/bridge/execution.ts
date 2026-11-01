import type {Result} from './contract';
export interface InferenceSelection {connectionId:string;model:string;modelName?:string}
export interface StartInferenceInput extends InferenceSelection {sessionId:string;instructionId:string;resume?:boolean;resolution?:string}
export interface HostRunChange {sessionId:string;status:'running'|'completed'|'failed'|'stopped';error?:{code:string;message:string}}
export type AccessLevel='ask'|'auto'|'full';
/** An action waiting for the original host, shown as a card in that session's conversation. */
export type HostApproval={id:string;sessionId:string;reason:string;expiresAt:string}&(
  |{kind:'file_write';path:string;newFile:boolean;preview:string}
  |{kind:'shell'|'external';command:string});
export interface HostExecutionApi {
  select(input:InferenceSelection):Promise<Result<InferenceSelection>>;
  selection():Promise<Result<InferenceSelection|null>>;
  run(input:StartInferenceInput):Promise<Result<{runId:string}>>;
  /** The host's connection writes a catch-up brief into the shared session. */
  brief(input:{sessionId:string;connectionId:string;model:string}):Promise<Result<{sequence:number;model:string}>>;
  stop(sessionId:string):Promise<Result<null>>;
  decide(approvalId:string,approved:boolean):Promise<Result<null>>;
  setAccess(sessionId:string,level:AccessLevel):Promise<Result<AccessLevel>>;
  approvals():Promise<Result<HostApproval[]>>;
  onApprovals(listener:(pending:HostApproval[])=>void):()=>void;
  onRunChange(listener:(change:HostRunChange)=>void):()=>void;
}
export const INFERENCE_IPC={invoke:'multai:inference',connections:'multai:inference-connections',run:'multai:inference-run',approvals:'multai:inference-approvals'} as const;
