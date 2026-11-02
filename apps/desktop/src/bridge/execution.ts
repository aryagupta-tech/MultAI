import type {ProjectGit,Result} from './contract';
import type {FileChange} from '../model/types';
import type {ConflictContext,ConflictReview} from './conflicts';
export interface InferenceSelection {connectionId:string;model:string;modelName?:string}
export interface StartInferenceInput extends InferenceSelection {sessionId:string;instructionId:string;resume?:boolean;resolution?:string;resolutionFingerprint?:string;verification?:boolean;effort?:'low'|'medium'|'high'|'xhigh'|'max';webSearch?:boolean}
export interface HostRunChange {sessionId:string;status:'running'|'completed'|'failed'|'stopped';error?:{code:string;message:string}}
export type AccessLevel='ask'|'auto'|'full';
/** An action waiting for the original host, shown as a card in that session's conversation. */
export type HostApproval={id:string;sessionId:string;reason:string;expiresAt:string}&(
  |{kind:'file_write';path:string;newFile:boolean;preview:string}
  |{kind:'shell'|'external';command:string});
/** Where a project session's worktree came from. Paths never reach the renderer. */
export interface WorkSummary {projectName:string;branch:string;baseBranch:string|null;baseCommit:string;fromCommit?:string;carried:boolean;kept:string|null;pushedTo:string|null;remote:string|null}
export interface SkillInfo {name:string;description:string;body:string;source:'project'|'personal'}
export interface UsageLimits {windows:{label:string;usedPercent:number;resetsAt?:number}[];at:number}
export interface ContextUsage {used:number;limit:number;compactedAt:string|null}
export interface Checkpoint {commit:string;at:string;instruction:string}
export interface UndoPreview {checkpoint:Checkpoint;files:{path:string;status:'added'|'modified'|'deleted'}[]}
/** An MCP server the host added. Env values never come back from the main process, only their names. */
export interface McpServerInfo {id:string;name:string;command:string;args:string[];env:Record<string,string>;enabled:boolean}
export type Editor='vscode'|'cursor'|'zed'|'finder';
/** An action whose outcome is unknown; it blocks the chat's next actions until the host says what happened. */
export interface LockedAction {id:string;kind:'file_write'|'shell'|'external';label:string;hint:'happened'|'did_not_happen'|'unknown';at:string}
export type TerminalEvent={sessionId:string;id:string}&({kind:'output';text:string}|{kind:'exit';code:number|null;stopped:boolean});
export interface HostExecutionApi {
  conflictContext(sessionId:string):Promise<Result<ConflictContext>>;
  analyzeConflict(input:{sessionId:string;connectionId:string;model:string}):Promise<Result<ConflictReview>>;
  verify(input:{sessionId:string;connectionId:string;model:string}):Promise<Result<{runId:string}>>;
  syncVerification(sessionId:string):Promise<Result<{revision:string|null}>>;
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
  /** What the provider last reported about this connection's usage limits. */
  usageLimits(connectionId:string):Promise<Result<UsageLimits|null>>;
  /** Speech to text with the host's Meta (Muse Voice Transcribe) or OpenAI connection. `audio` is base64 24 kHz mono PCM16. */
  transcribe(audio:string):Promise<Result<{text:string;provider:'meta'|'openai'}>>;
  /** SAM 3.1 on the host's Meta connection: the bounds of the element at this pixel of a screenshot. */
  segment(image:string,point:{x:number;y:number;width:number;height:number}):Promise<Result<{x1:number;y1:number;x2:number;y2:number}|null>>;
  segmentAvailable():Promise<Result<boolean>>;
  undoPreview(sessionId:string):Promise<Result<UndoPreview|null>>;
  undo(sessionId:string):Promise<Result<{checkpoint:Checkpoint;files:string[]}>>;
  editors():Promise<Result<Editor[]>>;
  mcpServers():Promise<Result<McpServerInfo[]>>;
  /** An empty env value keeps the saved one for that name. */
  mcpSave(server:McpServerInfo):Promise<Result<McpServerInfo>>;
  mcpDelete(id:string):Promise<Result<null>>;
  mcpTest(id:string):Promise<Result<string[]>>;
  lockedActions(sessionId:string):Promise<Result<LockedAction[]>>;
  resolveLocked(sessionId:string,actionId:string,outcome:'happened'|'did_not_happen'):Promise<Result<null>>;
  openIn(sessionId:string,editor:Editor):Promise<Result<null>>;
  onRunChange(listener:(change:HostRunChange)=>void):()=>void;
}
export const INFERENCE_IPC={invoke:'multai:inference',connections:'multai:inference-connections',run:'multai:inference-run',approvals:'multai:inference-approvals',terminal:'multai:inference-terminal'} as const;
