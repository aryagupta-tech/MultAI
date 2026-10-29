// Explicit projections from collaboration-service wire data to renderer view models.

import type { WireEvent, WireMe, WireParticipant, WireSession } from '../bridge/wire';
import { hueFor } from '../model/format';
import type {Decision, Participant, Person, SessionDetail, SessionSummary, TimelineItem, ToolCall} from '../model/types';

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
      return { ...base, ...(kind === 'instruction' && m.messageId ? {id: m.messageId} : {}), type: 'message', kind, authorId: e.actorId, text: m.text, ...(kind === 'instruction' && m.queueStatus === 'pending' ? { queue: 'pending' as const } : {}) };
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
    case 'run.started':
      return {...base,type:'system',tone:'info',text:`${actor} started an agent run${typeof p.model === 'string' ? ` with ${p.model.slice(0,200)}` : ''}.`};
    case 'run.completed':
      return {...base,type:'system',tone:'info',text:'The agent run completed.'};
    case 'run.failed':
      return {...base,type:'system',tone:'error',text:'The agent run failed. Review its activity before continuing.'};
    case 'run.stopped':
      return {...base,type:'system',tone:'warn',text:`${actor} stopped the agent run.`};
    case 'action.requested': {
      const action = p.kind === 'shell' ? 'A shell command' : p.kind === 'file_write' ? 'A file change' : 'An external action';
      return {...base,type:'system',tone:'warn',text:`${action} is waiting for exact approval on the original host.`};
    }
    case 'action.approved': return {...base,type:'system',tone:'info',text:`${actor} approved the reviewed action on the original host.`};
    case 'action.rejected': return {...base,type:'system',tone:'warn',text:`${actor} rejected the requested action.`};
    case 'action.consumed': return {...base,type:'system',tone:'info',text:'The host reserved the approved action for one execution.'};
    case 'action.completed': return {...base,type:'system',tone:'info',text:'The approved action completed.'};
    case 'action.canceled': return {...base,type:'system',tone:'warn',text:'The pending action was canceled.'};
    case 'action.uncertain': return {...base,type:'system',tone:'warn',text:'The action outcome is uncertain and will not be repeated automatically.'};
    case 'decision.saved': return typeof p.id === 'string' && typeof p.text === 'string' ? {...base,type:'decision',decisionId:p.id} : null;
    case 'activity.completed':
    case 'activity.failed': {
      const kinds:Record<string,ToolCall['tool']>={read:'read',read_file:'read',search:'search',search_text:'search',list:'list',list_files:'list',list_directory:'list',write:'write',write_file:'write',shell:'shell',run_shell:'shell',diff:'diff'};
      const tool = typeof p.tool === 'string' ? kinds[p.tool] : undefined;
      const detail = typeof p.detail === 'string' ? p.detail.slice(0,32_000) : typeof p.output === 'string' ? p.output.slice(0,32_000) : undefined;
      const summary = typeof p.summary === 'string' ? p.summary.slice(0,1000) : `${tool ?? 'Tool'} ${e.type === 'activity.failed' ? 'failed' : 'completed'}`;
      if (!tool) return {...base,type:'system',tone:e.type === 'activity.failed' ? 'error' : 'info',text:summary};
      return {...base,type:'tools',calls:[{id:typeof p.callId === 'string' ? p.callId.slice(0,512) : e.id,tool,summary,status:e.type === 'activity.failed' ? 'failed' : 'completed',...(detail ? {detail} : {}),...(Number.isSafeInteger(p.exitCode) ? {exitCode:p.exitCode as number} : {}),...(typeof p.durationMs === 'number' && Number.isFinite(p.durationMs) && p.durationMs >= 0 ? {durationMs:p.durationMs} : {})}]};
    }
    case 'usage.reported': {
      const usage = p.usage && typeof p.usage === 'object' ? p.usage as Record<string,unknown> : p;
      const input = usage.inputTokens ?? usage.input_tokens;
      const output = usage.outputTokens ?? usage.output_tokens;
      const known = [(Number.isSafeInteger(input) && (input as number) >= 0) ? `${input} input tokens` : null,(Number.isSafeInteger(output) && (output as number) >= 0) ? `${output} output tokens` : null].filter(Boolean);
      return known.length ? {...base,type:'system',tone:'info',text:`Provider-reported usage: ${known.join(', ')}.`} : null;
    }
    default:
      // Unknown event types are skipped rather than guessed at.
      return null;
  }
}

/** Replays state transitions without allowing old run events to undo recovery fencing. */
export function projectSessionState(session: WireSession, events: readonly WireEvent[]): WireSession {
  let state = {...session};
  const generations = new Map<string,number>();
  const pending = new Map<string,string>();
  let activeRun: string | null = null;
  for (const event of events) {
    const p = (event.payload ?? {}) as Record<string,unknown>;
    if (event.type === 'run.started' && typeof p.runId === 'string' && typeof p.runtimeGeneration === 'number' && Number.isSafeInteger(p.runtimeGeneration)) {
      generations.set(p.runId,p.runtimeGeneration);
      activeRun = p.runId;
      if (p.runtimeGeneration >= state.runtimeGeneration) state = {...state,status:'running',runtimeGeneration:p.runtimeGeneration};
    } else if (event.type === 'session.mode_changed' && typeof p.runtimeGeneration === 'number' && p.runtimeGeneration >= state.runtimeGeneration && (p.mode === 'plan' || p.mode === 'build')) {
      state = {...state,mode:p.mode,runtimeGeneration:p.runtimeGeneration};
    } else if (event.type.startsWith('action.') && typeof p.actionId === 'string') {
      if (event.type === 'action.requested' || event.type === 'action.approved' || event.type === 'action.consumed' || event.type === 'action.uncertain') pending.set(p.actionId,typeof p.runId === 'string' ? p.runId : activeRun ?? '');
      else pending.delete(p.actionId);
    } else if ((event.type === 'run.completed' || event.type === 'run.failed') && typeof p.runId === 'string') {
      const generation = generations.get(p.runId);
      if (generation !== undefined && generation >= state.runtimeGeneration) {
        const unresolved = [...pending.values()].includes(p.runId);
        state = {...state,status:event.type === 'run.failed' && unresolved ? 'paused' : 'inactive'};
      }
    } else if (event.type === 'run.stopped' && typeof p.runtimeGeneration === 'number' && p.runtimeGeneration >= state.runtimeGeneration) {
      state = {...state,status:'inactive',runtimeGeneration:p.runtimeGeneration};
    }
  }
  return state;
}

export function lastPendingInstruction(timeline: readonly TimelineItem[]): Extract<TimelineItem,{type:'message'}> | null {
  for (let index = timeline.length - 1; index >= 0; index--) {
    const item = timeline[index];
    if (item?.type === 'message' && item.kind === 'instruction' && item.queue === 'pending') return item;
  }
  return null;
}

function boundedAgentText(value:string):string {
  const maximum=131_072;
  const marker='\n\n[Output truncated in this view.]';
  return value.length>maximum?`${value.slice(0,maximum-marker.length)}${marker}`:value;
}

export function projectSession(input: {
  session: WireSession;
  participants: readonly WireParticipant[];
  events: readonly WireEvent[];
  me: WireMe;
}): SessionDetail {
  const {participants,events,me} = input;
  const session = projectSessionState(input.session,events);
  const people = new Map<string, Person>();
  const nameOf = (id: string | null) => {
    if (!id) return 'Someone';
    let p = people.get(id);
    if (!p) people.set(id, (p = personFor(id, me)));
    return id === me.id ? 'You' : p.name;
  };

  const timeline: TimelineItem[] = [];
  const agents = new Map<string,Extract<TimelineItem,{type:'agent'}>>();
  const models = new Map<string,string>();
  const decisions:Decision[]=[];
  let lastModel = '';
  for (const e of events) {
    const payload = (e.payload ?? {}) as Record<string,unknown>;
    if (e.type === 'run.started' && typeof payload.runId === 'string') {
      if (typeof payload.model === 'string') {models.set(payload.runId,payload.model.slice(0,200)); lastModel = payload.model.slice(0,200);}
      if (typeof payload.instructionId === 'string') for (const previous of timeline) if (previous.type === 'message' && previous.id === payload.instructionId && previous.kind === 'instruction') previous.queue = 'applied';
    }
    if (e.type === 'instruction.claimed' && typeof payload.instructionId === 'string') {
      for (const previous of timeline) if (previous.type === 'message' && previous.id === payload.instructionId && previous.kind === 'instruction') previous.queue = 'applied';
      continue;
    }
    if ((e.type === 'agent.delta' || e.type === 'agent.completed') && typeof payload.runId === 'string') {
      const text = typeof payload.text === 'string' ? payload.text : typeof payload.delta === 'string' ? payload.delta : '';
      let item = agents.get(payload.runId);
      if (!item) {
        item = {id:`agent:${payload.runId}`,sequence:e.sequence,at:e.createdAt,type:'agent',text:'',streaming:true,model:models.get(payload.runId) ?? 'Model unavailable'};
        agents.set(payload.runId,item); timeline.push(item);
      }
      const completed = payload.truncated === true
        ? (item.text.length > text.length ? item.text : `${text}\n\n[Provider output was truncated before sharing.]`)
        : text || item.text;
      item.text = boundedAgentText(e.type === 'agent.completed' ? completed : item.text + text);
      item.streaming = e.type !== 'agent.completed';
      continue;
    }
    if ((e.type === 'run.completed' || e.type === 'run.failed') && typeof payload.runId === 'string') {
      const agent = agents.get(payload.runId); if (agent) agent.streaming = false;
    }
    if (e.type === 'run.stopped') for (const agent of agents.values()) agent.streaming = false;
    if (e.type === 'decision.saved' && typeof payload.id === 'string' && typeof payload.text === 'string' && (typeof payload.authorId === 'string' || e.actorId)) {
      if (typeof payload.replacesId === 'string') {const previous=decisions.find(decision=>decision.id===payload.replacesId); if(previous)previous.status='replaced';}
      decisions.push({id:payload.id,text:payload.text.slice(0,8000),authorId:typeof payload.authorId === 'string' ? payload.authorId : e.actorId!,source:typeof payload.source === 'string' ? payload.source.slice(0,200) : 'Saved decision',status:'current',createdAt:e.createdAt,...(typeof payload.reason === 'string' ? {reason:payload.reason.slice(0,2000)} : {})});
    }
    const item = projectEvent(e, nameOf);
    if (item) timeline.push(item);
  }
  if (session.status !== 'running') for (const agent of agents.values()) agent.streaming = false;

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
    model: { id: lastModel || 'none', label: lastModel || 'No model selected', engine: lastModel ? 'Host inference connection' : 'Choose an inference connection', reasoning: [] },
    reasoning: '',
    participants: parts,
    timeline,
    decisions,
    changes: [],
  };
}

export function projectSummary(session: WireSession, meta: LocalSessionMeta, events?: readonly WireEvent[]): SessionSummary {
  const state = events ? projectSessionState(session,events) : session;
  return {
    id: session.id,
    title: sessionTitle(session, events),
    projectId: meta.projectId,
    status: state.status,
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
