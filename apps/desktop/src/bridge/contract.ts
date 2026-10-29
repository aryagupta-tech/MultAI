// The only surface the preload exposes to the renderer. Bearer, refresh and device secrets
// stay in the main process; nothing here returns them.

import type {
  WireEvent, WireInvitation, WireJoinRequest, WireJoinResult, WireMe, WireMessageKind, WireMode, WireParticipant, WireSession,
} from './wire';
import type {InferenceConnectionsApi} from './inference';
import type {HostExecutionApi} from './execution';

export type BuildChannel = 'development' | 'demo' | 'production';

export interface BuildInfo {
  version: string;
  commit: string;
  dirty: boolean;
  builtAt: string;
  channel: BuildChannel;
  platform: 'darwin' | 'win32' | 'linux' | 'web';
  serviceOrigin: string;
}

export type FolderPick =
  | { canceled: true }
  | { canceled: false; name: string; folderHint: string };

export interface ServiceError {
  code: string;
  message: string;
  status?: number;
}

export type Result<T> = { ok: true; value: T } | { ok: false; error: ServiceError };

export interface ServiceHealth {
  origin: string;
  reachable: boolean;
  database: 'ready' | 'unavailable' | 'unknown';
  identity: 'configured_unverified' | 'not_configured' | 'unknown';
}

export type AuthState =
  | { status: 'signed-out'; error?: ServiceError }
  | { status: 'signing-in'; expiresAt: string }
  | { status: 'signed-in'; me: WireMe; persisted: boolean };

export type LiveStatus = 'connecting' | 'live' | 'reconnecting' | 'ended';

export interface LiveBatch {
  sessionId: string;
  events: WireEvent[];
}

export interface LiveStatusChange {
  sessionId: string;
  status: LiveStatus;
  reason?: string;
}

export interface ServiceApi {
  health(): Promise<ServiceHealth>;
  authState(): Promise<AuthState>;
  signIn(): Promise<Result<null>>;
  cancelSignIn(): Promise<void>;
  signOut(): Promise<Result<null>>;
  listSessions(): Promise<Result<{ sessions: WireSession[] }>>;
  getSession(sessionId: string): Promise<Result<{ session: WireSession; participants: WireParticipant[] }>>;
  readEvents(sessionId: string, after: number): Promise<Result<{ events: WireEvent[]; cursor: number }>>;
  createSession(input: { requestId: string; title?: string; message: { kind: WireMessageKind; text: string } }): Promise<Result<{ session: WireSession; event: WireEvent }>>;
  postMessage(sessionId: string, input: { requestId: string; kind: WireMessageKind; text: string }): Promise<Result<{ event: WireEvent }>>;
  setMode(sessionId: string, input: { mode: WireMode; expectedGeneration: number }): Promise<Result<{ session: WireSession }>>;
  createInvitation(sessionId: string, expiresInSeconds: number): Promise<Result<{ invitation: WireInvitation }>>;
  joinInvitation(token: string): Promise<Result<WireJoinResult>>;
  listJoinRequests(sessionId: string): Promise<Result<{ requests: WireJoinRequest[] }>>;
  admit(sessionId: string, requestId: string, role: 'collaborator' | 'viewer'): Promise<Result<{ admitted: true; userId: string; role: string }>>;
  revokeParticipant(sessionId: string, userId: string): Promise<Result<{ revoked: true }>>;
  deleteSession(sessionId: string): Promise<Result<null>>;
  saveDecision(sessionId:string,input:{text:string;reason?:string;replacesId?:string}):Promise<Result<{id:string}>>;
  subscribe(sessionId: string, after: number): Promise<void>;
  unsubscribe(sessionId: string): Promise<void>;
  onAuthChange(listener: (state: AuthState) => void): () => void;
  onLiveEvents(listener: (batch: LiveBatch) => void): () => void;
  onLiveStatus(listener: (change: LiveStatusChange) => void): () => void;
  onJoinLink(listener: (token: string) => void): () => void;
}

export interface DesktopBridge {
  getBuildInfo(): Promise<BuildInfo>;
  pickProjectFolder(): Promise<FolderPick>;
  service: ServiceApi;
  inference: InferenceConnectionsApi & HostExecutionApi;
}

export const IPC = {
  buildInfo: 'multai:build-info',
  pickFolder: 'multai:pick-folder',
  invoke: 'multai:service',
  authChanged: 'multai:auth-changed',
  liveEvents: 'multai:live-events',
  liveStatus: 'multai:live-status',
  joinLink: 'multai:join-link',
} as const;

/** Service operations routed through the single validated `multai:service` channel. */
export type ServiceOp =
  | 'health' | 'authState' | 'signIn' | 'cancelSignIn' | 'signOut' | 'listSessions' | 'getSession' | 'readEvents'
  | 'createSession' | 'postMessage' | 'setMode' | 'createInvitation' | 'joinInvitation' | 'listJoinRequests' | 'admit'
  | 'revokeParticipant' | 'deleteSession' | 'saveDecision' | 'subscribe' | 'unsubscribe';
