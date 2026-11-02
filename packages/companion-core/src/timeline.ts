// Turns shared events into what a phone shows. Mirrors the desktop's wording; attribution always comes
// from the event (its actor or reviewer name), never from text inside a message.
import type {Region, WireEvent} from './wire.js';

export type Tone = 'info' | 'warn' | 'error' | 'ok';
export type TimelineItem =
  | {id: string; sequence: number; at: string; kind: 'message'; style: 'instruction' | 'discussion'; who: string; authorId: string; text: string; screenshot: boolean; queued: boolean}
  | {id: string; sequence: number; at: string; kind: 'agent'; text: string}
  | {id: string; sequence: number; at: string; kind: 'brief'; text: string; model: string}
  | {id: string; sequence: number; at: string; kind: 'comment'; who: string; text: string; screenshotId?: string; region?: Region}
  | {id: string; sequence: number; at: string; kind: 'decision'; who: string; text: string}
  | {id: string; sequence: number; at: string; kind: 'plan'; steps: {text: string; state: 'todo' | 'active' | 'done'}[]}
  | {id: string; sequence: number; at: string; kind: 'activity'; text: string; failed: boolean}
  | {id: string; sequence: number; at: string; kind: 'system'; text: string; tone: Tone};

/** Others show the name they gave when joining (or their account name), else the same generic label the desktop shows. */
export function personLabel(userId: string | null, me: {id: string; displayName?: string} | null, ownerId: string | null, names?: ReadonlyMap<string, string>): string {
  if (!userId) return 'MultAI';
  if (me && userId === me.id) return 'You';
  const name = names?.get(userId)?.trim();
  if (name) return ownerId && userId === ownerId ? `${name.slice(0, 60)} (host)` : name.slice(0, 60);
  if (ownerId && userId === ownerId) return 'Host';
  return `Teammate ${userId.replace(/-/gu, '').slice(0, 4).toUpperCase()}`;
}

const str = (value: unknown, max = 16_000) => typeof value === 'string' ? value.slice(0, max) : undefined;
const validRegion = (value: unknown): Region | undefined => {
  const r = value as Partial<Region> | undefined;
  return r && [r.x, r.y, r.width, r.height].every(n => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1) && r.width! > 0 && r.height! > 0 && r.x! + r.width! <= 1.000001 && r.y! + r.height! <= 1.000001 ? r as Region : undefined;
};

export function projectEvent(event: WireEvent, nameOf: (userId: string | null) => string, removed: ReadonlySet<string> = new Set(), applied: ReadonlySet<string> = new Set()): TimelineItem | null {
  const base = {id: event.id, sequence: event.sequence, at: event.createdAt};
  const p = (event.payload && typeof event.payload === 'object' ? event.payload : {}) as Record<string, unknown>;
  const actor = nameOf(event.actorId);
  switch (event.type) {
    case 'message.instruction': case 'message.discussion': {
      const text = str(p.text);
      if (!text || !event.actorId) return null;
      const messageId = str(p.messageId, 64);
      if (messageId && removed.has(messageId)) return null;
      const instruction = event.type === 'message.instruction';
      return {...base, ...(messageId ? {id: messageId} : {}), kind: 'message', style: instruction ? 'instruction' : 'discussion', who: actor, authorId: event.actorId, text, screenshot: typeof p.image === 'string',
        queued: instruction && p.queueStatus === 'pending' && !(messageId && applied.has(messageId))};
    }
    case 'agent.completed': return str(p.text) ? {...base, kind: 'agent', text: str(p.text)!} : null;
    case 'brief.created': return str(p.text) ? {...base, kind: 'brief', text: str(p.text, 6000)!, model: str(p.model, 200) ?? 'Model'} : null;
    case 'decision.saved': return str(p.text) ? {...base, kind: 'decision', who: actor, text: str(p.text, 8000)!} : null;
    case 'reviewer.comment': {
      const text = str(p.text, 4000), name = str(p.reviewerName, 120);
      if (!text || !name) return null;
      const region = validRegion(p.region);
      return {...base, kind: 'comment', who: p.reviewerKind === 'participant' ? name : `${name} · Browser reviewer`, text, ...(typeof p.screenshotId === 'string' && region ? {screenshotId: p.screenshotId, region} : {})};
    }
    case 'activity.completed': case 'activity.failed': {
      if (p.tool === 'update_plan') {
        const raw = (p.plan as {steps?: unknown} | undefined)?.steps;
        const steps = Array.isArray(raw) ? raw.slice(0, 20).flatMap(step => {
          const s = step as {text?: unknown; state?: unknown};
          return typeof s.text === 'string' && (s.state === 'todo' || s.state === 'active' || s.state === 'done') ? [{text: s.text.slice(0, 200), state: s.state as 'todo' | 'active' | 'done'}] : [];
        }) : [];
        return steps.length ? {...base, kind: 'plan', steps} : null;
      }
      return {...base, kind: 'activity', text: str(p.summary, 300) ?? (event.type === 'activity.failed' ? 'An action failed' : 'Used a tool'), failed: event.type === 'activity.failed'};
    }
    case 'run.started': return {...base, kind: 'system', tone: 'info', text: `${actor} started the agent${str(p.model, 200) ? ` with ${str(p.model, 200)}` : ''}.`};
    case 'run.completed': return {...base, kind: 'system', tone: 'ok', text: 'The desktop reported the run completed.'};
    case 'run.failed': return {...base, kind: 'system', tone: 'error', text: 'The run failed. Review its activity before continuing.'};
    case 'run.stopped': return {...base, kind: 'system', tone: 'warn', text: `${actor} stopped the agent.`};
    case 'action.requested': {
      const what = p.kind === 'shell' ? (str(p.command, 200) ? `Running “${str(p.command, 200)}”` : 'A command') : p.kind === 'file_write' ? (str(p.path, 200) ? `A change to ${str(p.path, 200)}` : 'A file change') : 'An external action';
      return {...base, kind: 'system', tone: 'warn', text: `${what} is waiting for the host’s approval.`};
    }
    case 'action.approved': return {...base, kind: 'system', tone: 'info', text: `${actor} approved the reviewed action on the desktop.`};
    case 'action.rejected': return {...base, kind: 'system', tone: 'warn', text: `${actor} rejected the requested action.`};
    case 'action.completed': return {...base, kind: 'system', tone: 'info', text: 'The approved action completed on the desktop.'};
    case 'action.uncertain': return {...base, kind: 'system', tone: 'warn', text: 'An action’s outcome is uncertain and will not be repeated automatically.'};
    case 'instruction.claimed': return {...base, kind: 'system', tone: 'info', text: 'The agent picked up a new direction.'};
    case 'instruction.steered': return {...base, kind: 'system', tone: 'info', text: `${actor} asked the running agent to take a queued direction.`};
    case 'instruction.removed': return p.reason === 'host_resolution' ? {...base, kind: 'system', tone: 'info', text: 'A reviewed direction was replaced by the host’s decision.'} : null;
    case 'participant.admitted': return {...base, kind: 'system', tone: 'info', text: `${nameOf(str(p.userId, 64) ?? null)} joined as ${p.role === 'viewer' ? 'viewer' : 'collaborator'}.`};
    case 'participant.revoked': return {...base, kind: 'system', tone: 'warn', text: `${nameOf(str(p.userId, 64) ?? null)} was removed from the session.`};
    case 'participant.left': return {...base, kind: 'system', tone: 'info', text: `${nameOf(str(p.userId, 64) ?? null)} left the session.`};
    case 'session.mode_changed': return {...base, kind: 'system', tone: 'info', text: `${actor} switched to ${p.mode === 'build' ? 'Build' : 'Plan'} mode.`};
    case 'reviewer.requested': case 'reviewer.admitted': case 'reviewer.revoked':
      return {...base, kind: 'system', tone: 'info', text: `${str(p.reviewerName, 120) ?? 'A browser reviewer'} ${event.type === 'reviewer.requested' ? 'asked to review in a browser.' : event.type === 'reviewer.admitted' ? 'was admitted to review.' : 'lost review access.'}`};
    case 'reviewer.screenshot_shared': return {...base, kind: 'system', tone: 'info', text: `${actor} shared a screenshot for review${str(p.label, 120) ? `: ${str(p.label, 120)}` : ''}.`};
    case 'acceptance.proposed': case 'acceptance.approved': case 'acceptance.revised':
      return {...base, kind: 'system', tone: 'info', text: `${str(p.authorName, 120) ?? actor} ${event.type === 'acceptance.proposed' ? 'proposed' : event.type === 'acceptance.approved' ? 'approved' : 'revised'} a requirement: ${str(p.text, 400) ?? ''}`};
    case 'acceptance.evidence': return {...base, kind: 'system', tone: p.status === 'failed' ? 'warn' : p.status === 'passed' ? 'ok' : 'info', text: `Verification evidence: ${p.status === 'passed' ? 'check passed' : p.status === 'failed' ? 'check failed' : 'needs human review'}.`};
    case 'acceptance.reviewed': return {...base, kind: 'system', tone: 'info', text: `${str(p.authorName, 120) ?? actor} ${p.decision === 'accept' ? 'accepted the behavior' : 'requested changes'}${str(p.comment, 400) ? `: ${str(p.comment, 400)}` : '.'}`};
    case 'control.acknowledged': {
      const device = str(p.deviceName, 120) ?? 'a paired phone';
      const what: Record<string, string> = {start: 'start an instruction', resolve: 'resolve conflicting directions', stop: 'stop the agent', steer: 'steer the agent', approve: 'approve an action', reject: 'reject an action'};
      return {...base, kind: 'system', tone: p.outcome === 'accepted' ? 'info' : 'warn', text: `${actor} via ${device} asked to ${what[String(p.kind)] ?? 'control the agent'}: the desktop ${p.outcome === 'accepted' ? 'did it' : 'refused it'}.`};
    }
    default: return null;
  }
}

/** Projects a page of events, hiding removed instructions and marking ones the agent already took. */
export function projectTimeline(events: readonly WireEvent[], nameOf: (userId: string | null) => string): TimelineItem[] {
  const removed = new Set<string>(), applied = new Set<string>();
  for (const event of events) {
    const p = (event.payload ?? {}) as Record<string, unknown>;
    if (event.type === 'instruction.removed' && typeof p.instructionId === 'string') removed.add(p.instructionId);
    if ((event.type === 'run.started' || event.type === 'instruction.claimed') && typeof p.instructionId === 'string') applied.add(p.instructionId);
  }
  return events.map(event => projectEvent(event, nameOf, removed, applied)).filter((item): item is TimelineItem => item !== null);
}
