// Explicit projections from collaboration-service wire data to renderer view models.

import type { WireEvent, WireMe, WireParticipant, WireSession } from '../bridge/wire';
import { hueFor } from '../model/format';
import type { Participant, Person, SessionDetail, SessionSummary, TimelineItem } from '../model/types';

export interface LocalSessionMeta {
  pinned: boolean;
  archived: boolean;
  projectId: string | null;
  unread: boolean;
}

const ROLE_LABEL = { owner: 'owner', collaborator: 'collaborator', viewer: 'viewer' } as const;

function initialsOf(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = parts.length > 1 ? (parts[0]?.[0] ?? '') + (parts.at(-1)?.[0] ?? '') : (parts[0] ?? '?').slice(0, 2);
  return letters.toUpperCase() || '?';
}

/**
 * The service only exposes your own display name. Other participants get a stable,
 * clearly generic label derived from their id rather than an invented name.
 */
export function personFor(userId: string, me: WireMe): Person {
  if (userId === me.id) {
    const name = me.displayName || 'You';
    return { id: userId, name, initials: initialsOf(name), hue: hueFor(userId) };
  }
  const short = userId.replace(/-/g, '').slice(0, 4).toUpperCase();
  return { id: userId, name: `Teammate ${short}`, initials: short.slice(0, 2), hue: hueFor(userId) };
}

export function sessionTitle(session: WireSession, events: readonly WireEvent[] = []): string {
  if (session.title) return session.title;
  const first = events.find((e) => e.type.startsWith('message.'));
  const text = first ? messagePayload(first)?.text : undefined;
  if (text) return text.length > 60 ? `${text.slice(0, 58).trimEnd()}…` : text;
  return 'Untitled session';
}

/** A first-message title for new sessions: one line, bounded to the service's 120 limit. */
export function titleFromMessage(text: string): string {
  const line = text.trim().split('\n')[0]?.trim() ?? '';
  return line.length > 80 ? `${line.slice(0, 78).trimEnd()}…` : line;
}

function messagePayload(e: WireEvent): { messageId?: string; text: string; queueStatus?: string } | null {
  const p = e.payload as { messageId?: unknown; text?: unknown; queueStatus?: unknown } | null;
  if (!p || typeof p.text !== 'string') return null;
  return {
    text: p.text,
    ...(typeof p.messageId === 'string' ? { messageId: p.messageId } : {}),
    ...(typeof p.queueStatus === 'string' ? { queueStatus: p.queueStatus } : {}),
  };
}

export function projectEvent(e: WireEvent, nameOf: (userId: string | null) => string): TimelineItem | null {
  const base = { id: e.id, sequence: e.sequence, at: e.createdAt };
  const p = (e.payload ?? {}) as Record<string, unknown>;
  const actor = nameOf(e.actorId);
  switch (e.type) {
    case 'message.discussion':
    case 'message.instruction': {
      const m = messagePayload(e);
      if (!m || !e.actorId) return null;
      const kind = e.type === 'message.instruction' ? 'instruction' : 'discussion';
      return { ...base, type: 'message', kind, authorId: e.actorId, text: m.text, ...(kind === 'instruction' && m.queueStatus === 'pending' ? { queue: 'pending' as const } : {}) };
    }
    case 'session.created':
      return { ...base, type: 'system', tone: 'info', text: `${actor} started this session in Plan mode.` };
    case 'session.mode_changed':
      return { ...base, type: 'system', tone: 'info', text: `${actor} switched to ${p.mode === 'build' ? 'Build' : 'Plan'} mode.` };
    case 'invitation.created':
      return { ...base, type: 'system', tone: 'info', text: `${actor} created an invitation link.` };
    case 'invitation.revoked':
      return { ...base, type: 'system', tone: 'info', text: `${actor} revoked an invitation link.` };
    case 'participant.join_requested':
      return { ...base, type: 'system', tone: 'info', text: `${nameOf(typeof p.userId === 'string' ? p.userId : e.actorId)} asked to join.` };
    case 'participant.admitted': {
      const role = typeof p.role === 'string' && p.role in ROLE_LABEL ? ROLE_LABEL[p.role as keyof typeof ROLE_LABEL] : 'participant';
      return { ...base, type: 'system', tone: 'info', text: `${nameOf(typeof p.userId === 'string' ? p.userId : null)} joined as ${role}.` };
    }
    case 'participant.revoked':
      return { ...base, type: 'system', tone: 'warn', text: `${nameOf(typeof p.userId === 'string' ? p.userId : null)} was removed from the session.` };
    default:
      // Unknown event types are skipped rather than guessed at.
      return null;
  }
}

export function projectSession(input: {
  session: WireSession;
  participants: readonly WireParticipant[];
  events: readonly WireEvent[];
  me: WireMe;
}): SessionDetail {
  const { session, participants, events, me } = input;
  const people = new Map<string, Person>();
  const nameOf = (id: string | null) => {
    if (!id) return 'Someone';
    let p = people.get(id);
    if (!p) people.set(id, (p = personFor(id, me)));
    return id === me.id ? 'You' : p.name;
  };

  const timeline: TimelineItem[] = [];
  for (const e of events) {
    const item = projectEvent(e, nameOf);
    if (item) timeline.push(item);
  }

  const parts: Participant[] = participants.map((wp) => ({
    ...personFor(wp.userId, me),
    role: wp.role,
    presence: wp.userId === me.id ? 'online' : 'unknown',
    isHost: wp.userId === session.ownerId,
    isLeader: wp.userId === session.ownerId,
  }));
  // Former participants still author past messages; make sure they render with a name.
  for (const t of timeline) if (t.type === 'message' && !parts.some((p) => p.id === t.authorId)) nameOf(t.authorId);

  const manage = session.capabilities.manage;
  const owner = personFor(session.ownerId, me);
  return {
    id: session.id,
    source: 'live',
    generation: session.runtimeGeneration,
    title: sessionTitle(session, events),
    objective: '',
    mode: session.mode,
    status: session.status,
    role: session.role,
    capabilities: { submit: session.capabilities.submit, approve: manage, configure: manage, decide: false, delete: manage },
    hostName: session.ownerId === me.id ? (manage ? 'This computer' : 'Your other computer') : `${owner.name}’s computer`,
    hostOnline: true,
    baseline: '',
    worktree: '',
    model: { id: 'none', label: 'No AI connected', engine: 'Inference is disabled on this service', reasoning: [] },
    reasoning: '',
    participants: parts,
    timeline,
    decisions: [],
    changes: [],
  };
}

export function projectSummary(session: WireSession, meta: LocalSessionMeta, events?: readonly WireEvent[]): SessionSummary {
  return {
    id: session.id,
    title: sessionTitle(session, events),
    projectId: meta.projectId,
    status: session.status,
    unread: meta.unread,
    pinned: meta.pinned,
    archived: meta.archived,
    pendingApprovals: 0,
    updatedAt: session.updatedAt,
  };
}

/** Merges new events into a sorted, sequence-deduplicated list. */
export function mergeEvents(existing: readonly WireEvent[], incoming: readonly WireEvent[]): WireEvent[] {
  if (incoming.length === 0) return existing as WireEvent[];
  const last = existing.at(-1)?.sequence ?? 0;
  // Fast path: strictly newer events in order.
  if (incoming.every((e, i) => e.sequence > (i === 0 ? last : (incoming[i - 1]?.sequence ?? 0)))) return [...existing, ...incoming];
  const bySeq = new Map<number, WireEvent>();
  for (const e of existing) bySeq.set(e.sequence, e);
  for (const e of incoming) if (!bySeq.has(e.sequence)) bySeq.set(e.sequence, e);
  return [...bySeq.values()].sort((a, b) => a.sequence - b.sequence);
}
