import type {ProjectGit,Result} from './contract';
import type {FileChange} from '../model/types';
export interface InferenceSelection {connectionId:string;model:string;modelName?:string}
export interface StartInferenceInput extends InferenceSelection {sessionId:string;instructionId:string;resume?:boolean;resolution?:string;effort?:'low'|'medium'|'high'|'xhigh'|'max'}
export interface HostRunChange {sessionId:string;status:'running'|'completed'|'failed'|'stopped';error?:{code:string;message:string}}
export type AccessLevel='ask'|'auto'|'full';
/** An action waiting for the original host, shown as a card in that session's conversation. */
export type HostApproval={id:string;sessionId:string;reason:string;expiresAt:string}&(
  |{kind:'file_write';path:string;newFile:boolean;preview:string}
  |{kind:'shell'|'external';command:string});
/** Where a project session's worktree came from. Paths never reach the renderer. */
export interface WorkSummary {projectName:string;branch:string;baseBranch:string|null;baseCommit:string;fromCommit?:string;carried:boolean;kept:string|null;pushedTo:string|null;remote:string|null}
export interface SkillInfo {name:string;description:string;body:string;source:'project'|'personal'}
export interface ContextUsage {used:number;limit:number;compactedAt:string|null}
export interface Checkpoint {commit:string;at:string;instruction:string}
export interface UndoPreview {checkpoint:Checkpoint;files:{path:string;status:'added'|'modified'|'deleted'}[]}
export type Editor='vscode'|'cursor'|'zed'|'finder';
export type TerminalEvent={sessionId:string;id:string}&({kind:'output';text:string}|{kind:'exit';code:number|null;stopped:boolean});
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
  /** Creates the session's worktree in a registered project; `carry` starts from the host's uncommitted changes. */
  startWork(sessionId:string,projectId:string,carry:boolean,title:string):Promise<Result<WorkSummary|null>>;
  projectStatus(projectId:string):Promise<Result<ProjectGit>>;
  workSummary(sessionId:string):Promise<Result<WorkSummary|null>>;
  workDiff(sessionId:string):Promise<Result<FileChange[]>>;
  workRevert(sessionId:string,path:string):Promise<Result<null>>;
  workKeep(sessionId:string,message:string):Promise<Result<{commit:string;branch:string}>>;
  workApply(sessionId:string):Promise<Result<{files:string[]}>>;
  workDiscard(sessionId:string):Promise<Result<null>>;
  draftPullRequest(input:{sessionId:string;connectionId:string;model:string}):Promise<Result<{title:string;body:string}>>;
  workPush(sessionId:string,pr:{title:string;body:string}):Promise<Result<{url:string;created:boolean}>>;
  terminalRun(sessionId:string,command:string):Promise<Result<{id:string}>>;
  terminalStop(sessionId:string):Promise<Result<null>>;
  onTerminal(listener:(event:TerminalEvent)=>void):()=>void;
  /** Files for the composer's @ list: a session's worktree, or a project before its first chat. */
  listFiles(sessionId:string|null,projectId:string|null):Promise<Result<{files:string[];truncated:boolean}>>;
  skills(sessionId:string|null,projectId:string|null):Promise<Result<SkillInfo[]>>;
  saveSkill(input:{name:string;description:string;body:string}):Promise<Result<SkillInfo>>;
  deleteSkill(name:string):Promise<Result<null>>;
  /** Summarizes the conversation so later runs start from the summary; it's posted as a brief too. */
  compact(input:{sessionId:string;connectionId:string;model:string}):Promise<Result<{sequence:number;model:string}>>;
  contextUsage(sessionId:string):Promise<Result<ContextUsage|null>>;
  undoPreview(sessionId:string):Promise<Result<UndoPreview|null>>;
  undo(sessionId:string):Promise<Result<{checkpoint:Checkpoint;files:string[]}>>;
  editors():Promise<Result<Editor[]>>;
  openIn(sessionId:string,editor:Editor):Promise<Result<null>>;
  onRunChange(listener:(change:HostRunChange)=>void):()=>void;
}
export const INFERENCE_IPC={invoke:'multai:inference',connections:'multai:inference-connections',run:'multai:inference-run',approvals:'multai:inference-approvals',terminal:'multai:inference-terminal'} as const;
