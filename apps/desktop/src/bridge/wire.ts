// Collaboration service wire contracts, as documented in apps/backend/COLLABORATION.md and
// AUTH.md. The renderer never uses these directly for display; src/live/projection.ts maps
// them into view models.

export type WireRole = 'owner' | 'collaborator' | 'viewer';
export type WireMode = 'plan' | 'build';
export type WireStatus = 'inactive' | 'paused' | 'running';
export type WireMessageKind = 'discussion' | 'instruction';

export interface WireSession {
  id: string;
  workspaceId: string;
  ownerId: string;
  title: string | null;
  mode: WireMode;
  status: WireStatus;
  runtimeGeneration: number;
  lastSequence: number;
  role: WireRole;
  createdAt: string;
  updatedAt: string;
  capabilities: { submit: boolean; manage: boolean; execute: boolean };
}

export interface WireParticipant {
  userId: string;
  role: WireRole;
  admittedAt: string;
}

export interface WireEvent {
  id: string;
  sessionId: string;
  sequence: number;
  type: string;
  actorId: string | null;
  payload: unknown;
  createdAt: string;
}

export interface WireMe {
  id: string;
  displayName: string;
  workspaceId: string;
  deviceId: string;
}

export interface WireInvitation {
  id: string;
  sessionId: string;
  token: string;
  expiresAt: string;
}

export interface WireJoinRequest {
  id: string;
  userId: string;
  createdAt: string;
}

export type WireJoinResult =
  | { requestId: string; sessionId: string; status: 'pending' }
  | { sessionId: string; status: 'admitted' };
