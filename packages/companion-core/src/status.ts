// One plain answer to "what is the desktop doing?", from what the service and the host actually reported.
/** The parts of a host report the status needs; participants get only these. */
export interface HostSignal {state: {host: 'online' | 'asleep' | 'signing_out'; run: {status: string}; locked?: number}; ageMs: number}

/** The host reports every few seconds; after this long without one it is offline or asleep. */
export const HOST_STALE_MS = 30_000;
export type HostAvailability = 'online' | 'asleep' | 'offline' | 'unknown';
export type Phase = 'idle' | 'starting' | 'running' | 'blocked' | 'completed' | 'failed' | 'stopped';
export interface StatusView {availability: HostAvailability; phase: Phase; headline: string; detail: string; tone: 'ok' | 'info' | 'warn' | 'error'}

export function hostAvailability(report: HostSignal | undefined, staleMs = HOST_STALE_MS, connected?: boolean): HostAvailability {
  if (!report) return connected === undefined ? 'unknown' : connected ? 'online' : 'offline';
  if (report.state.host === 'asleep') return 'asleep';
  if (report.state.host === 'signing_out' || (report.ageMs > staleMs && !connected)) return 'offline';
  return 'online';
}

const ago = (ms: number) => ms < 90_000 ? `${Math.max(1, Math.round(ms / 1000))} s ago` : ms < 5_400_000 ? `${Math.round(ms / 60_000)} min ago` : `${Math.round(ms / 3_600_000)} h ago`;

export function describeStatus(input: {sessionStatus: 'inactive' | 'paused' | 'running'; report?: HostSignal | null; connected?: boolean; pendingAction?: boolean; conflict?: boolean; locked?: number}): StatusView {
  const report = input.report ?? undefined;
  const availability = hostAvailability(report, HOST_STALE_MS, input.connected);
  const reported = report?.state.run.status;
  const blocked = input.pendingAction || reported === 'blocked' || (input.locked ?? report?.state.locked ?? 0) > 0;
  const phase: Phase = input.sessionStatus === 'running' ? (blocked ? 'blocked' : reported === 'starting' ? 'starting' : 'running')
    : input.sessionStatus === 'paused' ? 'blocked'
    : reported === 'completed' || reported === 'failed' || reported === 'stopped' ? reported : 'idle';
  if (availability === 'asleep') return {availability, phase, tone: 'warn', headline: 'Desktop is asleep', detail: 'Nothing runs until the desktop wakes. Requests from this phone wait and expire after two minutes.'};
  if (availability === 'offline') return report
    ? {availability, phase, tone: 'warn', headline: 'Desktop is offline', detail: `Last heard from ${ago(report.ageMs)}. It may be asleep, closed or disconnected.`}
    : {availability, phase, tone: 'warn', headline: 'Host isn’t connected', detail: 'The host’s desktop isn’t in this session right now. It may be closed, asleep or on another session.'};
  const lead = availability === 'unknown' ? '' : 'Desktop online · ';
  switch (phase) {
    case 'running': return {availability, phase, tone: 'info', headline: `${lead}Agent working`, detail: 'The agent is running on the desktop.'};
    case 'starting': return {availability, phase, tone: 'info', headline: `${lead}Starting`, detail: 'The desktop is starting the run.'};
    case 'blocked': return {availability, phase, tone: 'warn', headline: `${lead}Waiting on the host`, detail: input.pendingAction ? 'An action is waiting for approval.' : input.sessionStatus === 'paused' ? 'Interrupted work needs the host’s review before resuming.' : 'The run is blocked until the host decides.'};
    case 'completed': return {availability, phase, tone: 'ok', headline: `${lead}Run completed`, detail: 'The desktop reported the last run completed.'};
    case 'failed': return {availability, phase, tone: 'error', headline: `${lead}Run failed`, detail: 'Review the activity before continuing.'};
    case 'stopped': return {availability, phase, tone: 'warn', headline: `${lead}Stopped`, detail: 'The last run was stopped.'};
    default: return {availability, phase, tone: input.conflict ? 'warn' : 'info', headline: `${lead}${input.conflict ? 'Conflicting directions' : 'Idle'}`, detail: input.conflict ? 'Several people have pending directions. The host decides which to follow.' : 'Nothing is running.'};
  }
}
