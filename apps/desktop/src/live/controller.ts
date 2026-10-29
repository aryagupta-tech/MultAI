// Connects the renderer store to the collaboration service through the preload bridge.
// Every function here is a no-op in demo mode or when the bridge is absent.

import { getBridge } from '../bridge/client';
import type { AuthState, LiveBatch, LiveStatusChange, Result, ServiceError } from '../bridge/contract';
import type { WireEvent, WireMe, WireParticipant, WireSession } from '../bridge/wire';
import { hueFor } from '../model/format';
import type { Draft } from '../model/store';
import { useApp } from '../model/store';
import type { MessageKind, Project, SessionMode } from '../model/types';
import { mergeEvents, projectSession, projectSummary, projectSessionState, titleFromMessage, type LocalSessionMeta } from './projection';
import * as execution from './execution';

interface Cached {
  session: WireSession;
  participants: WireParticipant[];
  events: WireEvent[];
  loaded: boolean;
}

interface LocalState {
  meta: Record<string, Partial<LocalSessionMeta> & { title?: string }>;
  projects: Project[];
  onboarded: boolean;
}

const cache = new Map<string, Cached>();
let me: WireMe | null = null;
let subscribed: string | null = null;
let started = false;
let pollTimer: ReturnType<typeof setInterval> | null = null;

const isLive = () => useApp.getState().dataMode === 'live' && getBridge() !== null;
const api = () => getBridge()!.service;

/* ------------------------------------------------------------ errors */

const FRIENDLY: Record<string, string> = {
  offline_unsent: 'Can’t reach the collaboration service. Check that it’s running, then try again.',
  network_uncertain: 'The connection dropped before the service confirmed. Send again to retry safely; it won’t be duplicated.',
  identity_unavailable: 'Google sign-in isn’t configured on this service yet. Add GOOGLE_CLIENT_ID and GOOGLE_CLIENT_SECRET to the backend’s .env and restart it.',
  read_only: 'Viewers can read this session but can’t send messages.',
  session_active: 'Stop the session before changing this.',
  original_host_required: 'Only the session owner, on the computer that started it, can do this.',
  idempotency_conflict: 'This message conflicts with an earlier attempt. Edit it slightly and send again.',
  session_deleted: 'This session was deleted by its owner.',
  membership_revoked: 'You no longer have access to this session.',
  membership_required: 'You no longer have access to this session.',
  stale_generation: 'Someone changed this session a moment ago. Try again.',
  session_expired: 'Your sign-in expired. Sign in again to continue.',
  rate_limited: 'Too many requests. Wait a moment and try again.',
  invalid_flow: 'That sign-in link expired or was already used. Start again.',
};

export function describe(error: ServiceError): string {
  return FRIENDLY[error.code] ?? error.message ?? 'Something went wrong.';
}

function fail(error: ServiceError): void {
  useApp.getState().toast(describe(error), 'error');
  if (error.code === 'offline_unsent') useApp.setState({ connection: 'offline' });
}

async function call<T>(p: Promise<Result<T>>): Promise<T | null> {
  const r = await p;
  if (r.ok) {
    if (useApp.getState().connection !== 'connected') useApp.setState({ connection: 'connected' });
    return r.value;
  }
  fail(r.error);
  return null;
}

/* ------------------------------------------------------------ local, per-account state */

const localKey = (userId: string) => `multai.local.v1:${userId}`;

function readLocal(userId: string): LocalState {
  try {
    const raw = localStorage.getItem(localKey(userId));
    if (raw) return { meta: {}, projects: [], onboarded: false, ...JSON.parse(raw) };
  } catch { /* fall through */ }
  return { meta: {}, projects: [], onboarded: false };
}

let local: LocalState = { meta: {}, projects: [], onboarded: false };

/** Saves pins, archive state, private renames and projects for the signed-in account. */
export function persistLocal(): void {
  if (!me || useApp.getState().dataMode !== 'live') return;
  const s = useApp.getState();
  for (const x of s.sessions) {
    const cachedTitle = cache.get(x.id) && projectSummary(cache.get(x.id)!.session, metaFor(x.id), cache.get(x.id)!.events).title;
    local.meta[x.id] = {
      ...local.meta[x.id],
      pinned: x.pinned,
      archived: x.archived,
      projectId: x.projectId,
      ...(cachedTitle && x.title !== cachedTitle ? { title: x.title } : {}),
    };
  }
  local.projects = s.projects;
  try {
    localStorage.setItem(localKey(me.id), JSON.stringify(local));
  } catch { /* storage unavailable */ }
}

function metaFor(id: string): LocalSessionMeta {
  const m = local.meta[id] ?? {};
  return { pinned: m.pinned ?? false, archived: m.archived ?? false, projectId: m.projectId ?? null, unread: m.unread ?? false };
}

/* ------------------------------------------------------------ projection into the store */

function publish(id: string): void {
  const c = cache.get(id);
  if (!c || !me) return;
  const detail = projectSession({ session: c.session, participants: c.participants, events: c.events, me });
  const title = local.meta[id]?.title;
  if (title) detail.title = title;
  useApp.setState((s) => ({ details: { ...s.details, [id]: detail } }));
}

function publishSummaries(sessions: WireSession[]): void {
  const s = useApp.getState();
  const summaries = sessions.map((w) => {
    const summary = projectSummary(w, metaFor(w.id), cache.get(w.id)?.events);
    const title = local.meta[w.id]?.title;
    if (title) summary.title = title;
    // Keep the unread flag we already computed in this run.
    const prev = s.sessions.find((x) => x.id === w.id);
    if (prev && prev.updatedAt !== summary.updatedAt && s.activeId !== w.id) summary.unread = true;
    else if (prev) summary.unread = prev.unread;
    return summary;
  });
  useApp.setState({ sessions: summaries });
}

/* ------------------------------------------------------------ lifecycle */

function accountFrom(m: WireMe) {
  const name = m.displayName || 'You';
  const parts = name.split(/\s+/).filter(Boolean);
  const initials = ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts.at(-1)?.[0] ?? '' : parts[0]?.[1] ?? '')).toUpperCase() || 'Y';
  return { id: m.id, name, email: '', initials, hue: hueFor(m.id), workspace: 'Personal' };
}

async function applyAuth(state: AuthState): Promise<void> {
  const prevId = me?.id ?? null;
  useApp.setState({ auth: state });
  if (state.status !== 'signed-in') {
    execution.resetExecutionState();
    if (prevId) resetAccountState();
    return;
  }
  if (prevId === state.me.id) return;
  if (prevId) resetAccountState();
  me = state.me;
  local = readLocal(me.id);
  const drafts = readDrafts(me.id);
  useApp.setState({
    account: accountFrom(me),
    onboarding: local.onboarded ? 'done' : 'connect',
    projects: local.projects,
    drafts,
    connection: 'connected',
  });
  await refreshSessions();
  await execution.loadConnections();
}

function readDrafts(userId: string): Record<string, Draft> {
  try {
    return JSON.parse(localStorage.getItem(`multai.drafts.v1:${userId}`) ?? '{}') as Record<string, Draft>;
  } catch {
    return {};
  }
}

function resetAccountState(): void {
  if (subscribed) void api().unsubscribe(subscribed);
  subscribed = null;
  cache.clear();
  me = null;
  local = { meta: {}, projects: [], onboarded: false };
  useApp.setState({
    account: null, onboarding: 'signin', sessions: [], projects: [], details: {}, activeId: null, overlay: null,
    liveStatus: {}, joinRequests: {}, drafts: {}, sending: {}, loading: {},
  });
}

export async function start(): Promise<void> {
  if (started || !isLive()) return;
  started = true;
  const svc = api();
  svc.onAuthChange((state) => void applyAuth(state));
  svc.onLiveEvents(onLiveEvents);
  svc.onLiveStatus(onLiveStatus);
  svc.onJoinLink((token) => useApp.setState({ joinPrompt: token, overlay: 'join' }));
  void checkHealth();
  await applyAuth(await svc.authState());
  // Membership changes (admissions, new sessions from another device) arrive by polling.
  pollTimer = setInterval(() => {
    if (me && document.visibilityState === 'visible') void refreshSessions(true);
  }, 15_000);
  window.addEventListener('focus', () => { if (me) void refreshSessions(true); });
}

export async function checkHealth(): Promise<void> {
  if (!isLive()) return;
  const health = await api().health();
  useApp.setState({ health, ...(useApp.getState().account ? {} : { connection: health.reachable ? 'connected' : 'offline' }) });
}

export function completeOnboarding(): void {
  local.onboarded = true;
  persistLocal();
  useApp.setState({ onboarding: 'done' });
}

/* ------------------------------------------------------------ auth */

export async function signIn(): Promise<ServiceError | null> {
  const r = await api().signIn();
  return r.ok ? null : r.error;
}

export async function cancelSignIn(): Promise<void> {
  await api().cancelSignIn();
}

export async function signOut(): Promise<void> {
  await api().signOut();
}

/* ------------------------------------------------------------ sessions */

export async function refreshSessions(quiet = false): Promise<void> {
  const r = await api().listSessions();
  if (!r.ok) {
    if (!quiet) fail(r.error);
    else if (r.error.code === 'offline_unsent') useApp.setState({ connection: 'offline' });
    return;
  }
  useApp.setState({ connection: 'connected' });
  const ids = new Set(r.value.sessions.map((x) => x.id));
  for (const w of r.value.sessions) {
    const c = cache.get(w.id);
    if (c) c.session = w;
  }
  // Drop sessions we lost access to (deleted or revoked) so stale content can't linger.
  for (const id of [...cache.keys()]) if (!ids.has(id)) forget(id);
  publishSummaries(r.value.sessions);
  const active = useApp.getState().activeId;
  if (active && cache.has(active)) publish(active);
}

function forget(id: string): void {
  cache.delete(id);
  if (subscribed === id) {
    void api().unsubscribe(id);
    subscribed = null;
  }
  useApp.setState((s) => {
    const details = { ...s.details };
    delete details[id];
    return { details, sessions: s.sessions.filter((x) => x.id !== id), activeId: s.activeId === id ? null : s.activeId };
  });
}

/** Opens a session: loads its snapshot and full event history, then follows it live. */
export async function open(id: string): Promise<void> {
  if (!isLive()) return;
  if (subscribed && subscribed !== id) {
    void api().unsubscribe(subscribed);
    subscribed = null;
  }
  useApp.setState((s) => ({ loading: { ...s.loading, [id]: true } }));
  try {
    const snap = await api().getSession(id);
    if (!snap.ok) {
      if (snap.error.status === 403 || snap.error.status === 404 || snap.error.status === 410) {
        useApp.getState().toast(describe(snap.error.status === 410 ? { code: 'session_deleted', message: '' } : { code: 'membership_revoked', message: '' }), 'info');
        forget(id);
      } else fail(snap.error);
      return;
    }
    const c: Cached = cache.get(id) ?? { session: snap.value.session, participants: [], events: [], loaded: false };
    c.session = snap.value.session;
    c.participants = snap.value.participants;
    cache.set(id, c);
    // Replay everything after what we already hold, a page at a time.
    for (let guard = 0; guard < 1000; guard++) {
      const after = c.events.at(-1)?.sequence ?? 0;
      const page = await api().readEvents(id, after);
      if (!page.ok) { fail(page.error); break; }
      c.events = mergeEvents(c.events, page.value.events);
      if (page.value.events.length < 100) break;
    }
    c.loaded = true;
    publish(id);
    if (useApp.getState().activeId === id) {
      subscribed = id;
      await api().subscribe(id, c.events.at(-1)?.sequence ?? 0);
      if (c.session.capabilities.manage) void loadJoinRequests(id);
    }
  } finally {
    useApp.setState((s) => ({ loading: { ...s.loading, [id]: false } }));
  }
}

function onLiveEvents(batch: LiveBatch): void {
  const c = cache.get(batch.sessionId);
  if (!c) return;
  c.events = mergeEvents(c.events, batch.events);
  const last = c.events.at(-1);
  if (last) c.session = { ...c.session, lastSequence: last.sequence, updatedAt: last.createdAt };
  c.session=projectSessionState(c.session,c.events);
  let membershipChanged = false;
  for (const e of batch.events) {
    if (e.type === 'session.mode_changed') {
      const p = e.payload as { mode?: SessionMode; runtimeGeneration?: number };
      if (p.mode) c.session = { ...c.session, mode: p.mode, ...(p.runtimeGeneration ? { runtimeGeneration: p.runtimeGeneration } : {}) };
    }
    if (e.type.startsWith('participant.')) membershipChanged = true;
  }
  publish(batch.sessionId);
  useApp.setState((s) => ({ sessions: s.sessions.map((x) => (x.id === batch.sessionId && last ? { ...x, updatedAt: last.createdAt } : x)) }));
  if (membershipChanged) {
    void api().getSession(batch.sessionId).then((r) => {
      if (!r.ok || !cache.has(batch.sessionId)) return;
      c.participants = r.value.participants;
      c.session = r.value.session;
      publish(batch.sessionId);
    });
    if (c.session.capabilities.manage) void loadJoinRequests(batch.sessionId);
  }
}

function onLiveStatus(change: LiveStatusChange): void {
  useApp.setState((s) => ({ liveStatus: { ...s.liveStatus, [change.sessionId]: change.status } }));
  if (change.status === 'ended') {
    useApp.getState().toast(describe({ code: change.reason ?? 'membership_revoked', message: 'This session is no longer available.' }), 'info');
    if (subscribed === change.sessionId) subscribed = null;
    forget(change.sessionId);
  }
}

/* ------------------------------------------------------------ sending */

/**
 * Sends a draft. The request id is saved with the draft before the request goes out, so an
 * uncertain failure retried later reuses it and the service returns the original result
 * instead of creating a duplicate session or message.
 */
export async function send(key: string, kind: MessageKind, text: string): Promise<void> {
  const app = useApp.getState();
  const draft = app.drafts[key];
  const requestId = draft?.requestId && draft.requestFor === text ? draft.requestId : crypto.randomUUID();
  app.setDraft(key, { requestId, requestFor: text });
  useApp.setState((s) => ({ sending: { ...s.sending, [key]: true } }));
  try {
    if (key === 'new') {
      const title = titleFromMessage(text);
      const r = await api().createSession({ requestId, ...(title ? { title: title.slice(0, 120) } : {}), message: { kind, text } });
      if (!r.ok) return fail(r.error);
      const { session, event } = r.value;
      const projectId = useApp.getState().draftTarget.projectId;
      local.meta[session.id] = { ...local.meta[session.id], projectId };
      cache.set(session.id, { session, participants: [], events: [event], loaded: false });
      useApp.getState().setDraft('new', { text: '' });
      useApp.setState((s) => ({ sessions: [projectSummary(session, metaFor(session.id), [event]), ...s.sessions.filter((x) => x.id !== session.id)], activeId: session.id }));
      persistLocal();
      await open(session.id);
    } else {
      const r = await api().postMessage(key, { requestId, kind, text });
      if (!r.ok) return fail(r.error);
      const c = cache.get(key);
      if (c) {
        c.events = mergeEvents(c.events, [r.value.event]);
        publish(key);
      }
      useApp.getState().setDraft(key, { text: '' });
    }
  } finally {
    useApp.setState((s) => ({ sending: { ...s.sending, [key]: false } }));
  }
}

/* ------------------------------------------------------------ session controls */

export async function setMode(id: string, mode: SessionMode): Promise<void> {
  const c = cache.get(id);
  if (!c) return;
  const value = await call(api().setMode(id, { mode, expectedGeneration: c.session.runtimeGeneration }));
  if (!value) {
    // A stale generation means our snapshot is behind; reload it so the next try can succeed.
    void open(id);
    return;
  }
  c.session = value.session;
  publish(id);
}

export async function saveDecision(sessionId:string,text:string,reason?:string,replacesId?:string):Promise<void>{
  const result=await api().saveDecision(sessionId,{text,...(reason?{reason}:{}),...(replacesId?{replacesId}:{})});
  if(!result.ok)return fail(result.error);
  await open(sessionId);
}

export async function deleteSession(id: string): Promise<void> {
  const r = await api().deleteSession(id);
  if (!r.ok) return fail(r.error);
  delete local.meta[id];
  forget(id);
  persistLocal();
  useApp.setState({ overlay: null });
  useApp.getState().toast('Shared session deleted for everyone. Your project files weren’t touched.', 'success');
}

export async function createInvitation(id: string, expiresInSeconds: number): Promise<{ token: string; expiresAt: string } | null> {
  const value = await call(api().createInvitation(id, expiresInSeconds));
  return value ? { token: value.invitation.token, expiresAt: value.invitation.expiresAt } : null;
}

/** Extracts an invitation token from a pasted code or multai-dev://join link. */
export function parseInvite(input: string): string | null {
  const trimmed = input.trim();
  let token = trimmed;
  try {
    const url = new URL(trimmed);
    token = url.searchParams.get('token') ?? '';
  } catch { /* not a URL: treat as a bare code */ }
  return /^[A-Za-z0-9_-]{16,200}$/.test(token) ? token : null;
}

export async function join(token: string): Promise<'pending' | 'admitted' | null> {
  const value = await call(api().joinInvitation(token));
  if (!value) return null;
  if (value.status === 'admitted') {
    await refreshSessions();
    useApp.getState().selectSession(value.sessionId);
  }
  return value.status;
}

export async function loadJoinRequests(id: string): Promise<void> {
  const r = await api().listJoinRequests(id);
  if (r.ok) useApp.setState((s) => ({ joinRequests: { ...s.joinRequests, [id]: r.value.requests } }));
}

export async function admit(id: string, requestId: string, role: 'collaborator' | 'viewer'): Promise<boolean> {
  const value = await call(api().admit(id, requestId, role));
  if (!value) return false;
  await loadJoinRequests(id);
  useApp.getState().toast(`Admitted as ${role}.`, 'success');
  return true;
}

export async function revoke(id: string, userId: string): Promise<void> {
  const value = await call(api().revokeParticipant(id, userId));
  if (value) useApp.getState().toast('Removed from the session. Their access ends immediately.', 'success');
}

export function stopPolling(): void {
  if (pollTimer) clearInterval(pollTimer);
}
