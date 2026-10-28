// View models for the renderer. These are deliberately separate from the collaboration
// service's wire contracts; adapters project service snapshots into these shapes.

export type Role = 'owner' | 'collaborator' | 'viewer';
export type SessionMode = 'plan' | 'build';
export type SessionStatus = 'inactive' | 'paused' | 'running';
export type MessageKind = 'instruction' | 'discussion';
export type Presence = 'online' | 'idle' | 'offline';

export interface Person {
  id: string;
  name: string;
  initials: string;
  /** Hue (0-359) used to tint the avatar; derived from the id, never from the name. */
  hue: number;
}

export interface Participant extends Person {
  role: Role;
  presence: Presence;
  isHost: boolean;
  isLeader: boolean;
}

export interface ModelChoice {
  id: string;
  label: string;
  engine: string;
  reasoning: readonly string[];
}

export interface Capabilities {
  submit: boolean;
  approve: boolean;
  configure: boolean;
  decide: boolean;
  delete: boolean;
}

export interface SessionSummary {
  id: string;
  title: string;
  projectId: string | null;
  status: SessionStatus;
  unread: boolean;
  pinned: boolean;
  archived: boolean;
  pendingApprovals: number;
  updatedAt: string;
}

export interface Project {
  id: string;
  name: string;
  /** Display-only folder hint; the canonical path never leaves this device. */
  folderHint: string;
  expanded: boolean;
}

export type ToolStatus = 'pending' | 'running' | 'completed' | 'failed' | 'uncertain';

export interface ToolCall {
  id: string;
  tool: 'read' | 'search' | 'list' | 'write' | 'shell' | 'diff';
  summary: string;
  status: ToolStatus;
  detail?: string;
  exitCode?: number;
  durationMs?: number;
}

export interface ApprovalDescriptor {
  executable: string;
  args: readonly string[];
  cwd: string;
  connection: string;
  generation: number;
  hash: string;
  expiresAt: string;
}

export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'expired';

export interface PlanStep {
  text: string;
  state: 'todo' | 'active' | 'done';
}

export interface Decision {
  id: string;
  text: string;
  reason?: string;
  authorId: string;
  source: string;
  status: 'current' | 'replaced';
  createdAt: string;
}

interface TimelineBase {
  id: string;
  sequence: number;
  at: string;
}

export type TimelineItem =
  | (TimelineBase & { type: 'message'; kind: MessageKind; authorId: string; text: string; queue?: 'pending' | 'applied' })
  | (TimelineBase & { type: 'agent'; text: string; streaming: boolean; model: string })
  | (TimelineBase & { type: 'tools'; calls: ToolCall[] })
  | (TimelineBase & { type: 'approval'; title: string; reason: string; descriptor: ApprovalDescriptor; state: ApprovalState; decidedBy?: string })
  | (TimelineBase & { type: 'plan'; title: string; steps: PlanStep[] })
  | (TimelineBase & { type: 'decision'; decisionId: string })
  | (TimelineBase & { type: 'conflict'; instructionIds: [string, string]; resolved: boolean })
  | (TimelineBase & { type: 'question'; prompt: string; options: string[]; answer?: string })
  | (TimelineBase & { type: 'system'; tone: 'info' | 'warn' | 'error'; text: string });

export interface FileChange {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
}

export interface DiffHunk {
  header: string;
  lines: { kind: 'context' | 'add' | 'del'; text: string; oldNo?: number; newNo?: number }[];
}

export interface SessionDetail {
  id: string;
  title: string;
  objective: string;
  mode: SessionMode;
  status: SessionStatus;
  role: Role;
  capabilities: Capabilities;
  hostName: string;
  hostOnline: boolean;
  baseline: string;
  worktree: string;
  model: ModelChoice;
  reasoning: string;
  participants: Participant[];
  timeline: TimelineItem[];
  decisions: Decision[];
  changes: FileChange[];
}

export interface Account {
  id: string;
  name: string;
  email: string;
  initials: string;
  hue: number;
  workspace: string;
}

export type ConnectionState = 'connected' | 'connecting' | 'offline';

export type InspectorTab = 'changes' | 'activity' | 'approvals' | 'decisions' | 'people' | 'files';
