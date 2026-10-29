import { create } from 'zustand';
import type { AuthState, BuildInfo, LiveStatus, ServiceHealth } from '../bridge/contract';
import type { WireJoinRequest } from '../bridge/wire';
import * as live from '../live/controller';
import { getBridge } from '../bridge/client';
import type {
  Account, ConnectionState, Decision, InspectorTab, MessageKind, Project, SessionDetail, SessionMode, SessionSummary, TimelineItem,
} from './types';
import { DRAFT_LIMIT } from './composer';

export const IS_DEMO = import.meta.env.MODE === 'demo';

export type Theme = 'dark' | 'light' | 'system';
export type Density = 'comfortable' | 'compact';
export type TextSize = 'small' | 'default' | 'large';
export type MotionPref = 'system' | 'reduce';

export interface Preferences {
  theme: Theme;
  density: Density;
  textSize: TextSize;
  motion: MotionPref;
  defaultKind: MessageKind;
  showToolDetails: boolean;
}

export interface Draft {
  text: string;
  kind: MessageKind;
  /** Durable retry identity, kept with the draft until the service confirms the send. */
  requestId?: string;
  /** The exact text the requestId was issued for; edits after a failure get a new identity. */
  requestFor?: string;
}

export type Overlay = null | 'palette' | 'settings' | 'invite' | 'new-project' | 'shortcuts' | 'delete-session' | 'join';
export type OnboardingStep = 'signin' | 'connect' | 'done';

export interface Toast {
  id: number;
  text: string;
  tone: 'info' | 'success' | 'error';
}

interface State {
  dataMode: 'demo' | 'live';
  build: BuildInfo | null;
  account: Account | null;
  onboarding: OnboardingStep;
  connection: ConnectionState;
  sessions: SessionSummary[];
  projects: Project[];
  details: Record<string, SessionDetail>;
  activeId: string | null;
  draftTarget: { projectId: string | null };
  sidebarOpen: boolean;
  inspectorOpen: boolean;
  inspectorTab: InspectorTab;
  overlay: Overlay;
  settingsSection: string;
  showArchived: boolean;
  drafts: Record<string, Draft>;
  prefs: Preferences;
  toasts: Toast[];
  focusedApproval: string | null;
  /* Live service state (unused in demo mode). */
  auth: AuthState | null;
  health: ServiceHealth | null;
  liveStatus: Record<string, LiveStatus>;
  joinRequests: Record<string, WireJoinRequest[]>;
  /** Invitation token from a multai-dev://join link, awaiting the person's confirmation. */
  joinPrompt: string | null;
  sending: Record<string, boolean>;
  loading: Record<string, boolean>;
}

interface Actions {
  setBuild(build: BuildInfo): void;
  loadDemo(data: { account: Account; sessions: SessionSummary[]; projects: Project[]; details: Record<string, SessionDetail> }): void;
  completeOnboarding(step: OnboardingStep): void;
  signOut(): void;
  selectSession(id: string): void;
  newChat(projectId?: string | null): void;
  toggleSidebar(): void;
  setInspector(open: boolean, tab?: InspectorTab): void;
  openOverlay(o: Overlay, section?: string): void;
  closeOverlay(): void;
  setDraft(key: string, draft: Partial<Draft>): void;
  send(key: string, kind: MessageKind): boolean;
  decideApproval(sessionId: string, itemId: string, approve: boolean): void;
  answerQuestion(sessionId: string, itemId: string, answer: string): void;
  setMode(sessionId: string, mode: SessionMode): void;
  setReasoning(sessionId: string, level: string): void;
  stop(sessionId: string): void;
  resume(sessionId: string): void;
  saveDecision(sessionId: string, text: string, reason?: string, replaces?: string): void;
  togglePin(id: string): void;
  setArchived(id: string, archived: boolean): void;
  rename(id: string, title: string): void;
  deleteSession(id: string): void;
  toggleProject(id: string): void;
  addProject(p: { name: string; folderHint: string }): void;
  setPrefs(p: Partial<Preferences>): void;
  setShowArchived(v: boolean): void;
  toast(text: string, tone?: Toast['tone']): void;
  dismissToast(id: number): void;
}

const PREFS_KEY = 'multai.prefs.v1';
// Drafts are scoped to the account that wrote them (MultAI.md §4): a signed-out
// or different account never sees them, and sign-out preserves each account's own.
export const draftStorageKey = (accountId: string | null): string =>
  `multai.drafts.v1:${accountId ?? 'signed-out'}`;

const defaultPrefs: Preferences = {
  theme: 'dark', density: 'comfortable', textSize: 'default', motion: 'system', defaultKind: 'instruction', showToolDetails: false,
};

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* storage unavailable: preferences simply don't persist */
  }
}

type NewItem = TimelineItem extends infer T ? (T extends TimelineItem ? Omit<T, 'sequence' | 'at'> & { at?: string } : never) : never;

let seq = 1000;
const nextId = (p: string) => `${p}-${++seq}`;
const now = () => new Date().toISOString();
let toastSeq = 0;

function nextSequence(d: SessionDetail): number {
  return (d.timeline.at(-1)?.sequence ?? 0) + 1;
}

export const useApp = create<State & Actions>()((set, get) => {
  const patchDetail = (id: string, fn: (d: SessionDetail) => SessionDetail) =>
    set((s) => {
      const d = s.details[id];
      return d ? { details: { ...s.details, [id]: fn(d) } } : {};
    });

  const append = (id: string, item: NewItem) =>
    patchDetail(id, (d) => ({ ...d, timeline: [...d.timeline, { at: now(), ...item, sequence: nextSequence(d) } as TimelineItem] }));

  const setStatus = (id: string, status: SessionSummary['status']) =>
    set((s) => ({
      sessions: s.sessions.map((x) => (x.id === id ? { ...x, status, updatedAt: now() } : x)),
      details: s.details[id] ? { ...s.details, [id]: { ...s.details[id], status } } : s.details,
    }));

  /** DEMO ONLY: simulates an agent turn so the interface can be explored without a service. */
  const simulateTurn = (id: string, prompt: string) => {
    if (get().dataMode !== 'demo') return;
    setStatus(id, 'running');
    const toolsId = nextId('t');
    append(id, { id: toolsId, type: 'tools', calls: [{ id: nextId('c'), tool: 'search', summary: 'Searched the worktree', status: 'running' }] });
    const agentId = nextId('t');
    const reply = demoReply(prompt);
    setTimeout(() => {
      patchDetail(id, (d) => ({
        ...d,
        timeline: d.timeline.map((t) => t.id === toolsId && t.type === 'tools'
          ? { ...t, calls: t.calls.map((c) => ({ ...c, status: 'completed', detail: '4 matches in 2 files', durationMs: 140 })) }
          : t),
      }));
      append(id, { id: agentId, type: 'agent', model: get().details[id]?.model.label ?? 'Model', text: '', streaming: true });
      let i = 0;
      const words = reply.split(/(?<=\s)/);
      const tick = () => {
        if (get().details[id]?.status !== 'running') return;
        i = Math.min(words.length, i + 3);
        const text = words.slice(0, i).join('');
        patchDetail(id, (d) => ({ ...d, timeline: d.timeline.map((t) => (t.id === agentId && t.type === 'agent' ? { ...t, text, streaming: i < words.length } : t)) }));
        if (i < words.length) setTimeout(tick, 45);
        else setStatus(id, 'inactive');
      };
      tick();
    }, 900);
  };

  return {
    dataMode: IS_DEMO ? 'demo' : 'live',
    build: null,
    account: null,
    onboarding: 'signin',
    connection: 'offline',
    sessions: [],
    projects: [],
    details: {},
    activeId: null,
    draftTarget: { projectId: null },
    sidebarOpen: true,
    inspectorOpen: true,
    inspectorTab: 'changes',
    overlay: null,
    settingsSection: 'general',
    showArchived: false,
    drafts: readJson<Record<string, Draft>>(draftStorageKey(null), {}),
    prefs: readJson(PREFS_KEY, defaultPrefs),
    toasts: [],
    focusedApproval: null,
    auth: null,
    health: null,
    liveStatus: {},
    joinRequests: {},
    joinPrompt: null,
    sending: {},
    loading: {},

    setBuild: (build) => set({ build }),
    loadDemo: ({ account, sessions, projects, details }) =>
      set({ account, sessions, projects, details, activeId: 's-rate', onboarding: 'done', connection: 'connected', drafts: readJson<Record<string, Draft>>(draftStorageKey(account.id), {}) }),
    completeOnboarding: (onboarding) => set({ onboarding }),
    signOut: () => {
      if (get().dataMode === 'live' && getBridge()) return void live.signOut();
      set({ account: null, onboarding: 'signin', sessions: [], projects: [], details: {}, activeId: null, overlay: null, connection: 'offline', drafts: readJson<Record<string, Draft>>(draftStorageKey(null), {}) });
    },

    selectSession: (id) => {
      set((s) => ({ activeId: id, sessions: s.sessions.map((x) => (x.id === id ? { ...x, unread: false } : x)) }));
      const s = get();
      if (!s.details[id]) {
        const summary = s.sessions.find((x) => x.id === id);
        if (summary && s.dataMode === 'demo') set({ details: { ...s.details, [id]: basicDetail(summary, s.account) } });
      }
      if (s.dataMode === 'live') void live.open(id);
    },
    newChat: (projectId = null) => set({ activeId: null, draftTarget: { projectId } }),
    toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
    setInspector: (open, tab) => set((s) => ({ inspectorOpen: open, inspectorTab: tab ?? s.inspectorTab })),
    openOverlay: (overlay, section) => set((s) => ({ overlay, settingsSection: section ?? s.settingsSection })),
    closeOverlay: () => set({ overlay: null }),

    setDraft: (key, draft) => {
      set((s) => {
        const prev = s.drafts[key] ?? { text: '', kind: s.prefs.defaultKind };
        const next: Draft = { ...prev, ...draft };
        if (draft.text === '') {
          // Cleared after a confirmed send: the retry identity is spent.
          delete next.requestId;
          delete next.requestFor;
        }
        const drafts = { ...s.drafts, [key]: next };
        writeJson(draftStorageKey(s.account?.id ?? null), drafts);
        return { drafts };
      });
    },

    send: (key, kind) => {
      const s = get();
      const draft = s.drafts[key];
      const text = draft?.text.trim() ?? '';
      if (!text || text.length > DRAFT_LIMIT || !s.account) return false;
      if (s.dataMode === 'live') {
        if (!getBridge()) {
          get().toast('Sending needs the MultAI desktop app. Your draft is saved.', 'error');
          return false;
        }
        if (s.sending[key]) return false;
        void live.send(key, kind, text);
        return true;
      }
      let id = key;
      if (key === 'new') {
        id = nextId('s');
        const title = text.length > 48 ? text.slice(0, 46).trimEnd() + '…' : text;
        const summary: SessionSummary = { id, title, projectId: s.draftTarget.projectId, status: 'inactive', unread: false, pinned: false, archived: false, pendingApprovals: 0, updatedAt: now() };
        set({ sessions: [summary, ...s.sessions], details: { ...s.details, [id]: { ...basicDetail(summary, s.account, true) } }, activeId: id });
      }
      // While the agent is working, instructions wait in the queue for the next safe boundary.
      const busy = get().details[id]?.status === 'running';
      const queue = kind === 'instruction' ? (busy ? 'pending' as const : 'applied' as const) : undefined;
      append(id, { id: nextId('t'), type: 'message', kind, authorId: s.account.id, text, ...(queue ? { queue } : {}) });
      get().setDraft(key, { text: '' });
      set((st) => ({ sessions: st.sessions.map((x) => (x.id === id ? { ...x, updatedAt: now() } : x)) }));
      if (queue === 'applied') simulateTurn(id, text);
      else if (queue === 'pending') get().toast('Queued. The agent will see it at the next safe point.');
      return true;
    },

    decideApproval: (sessionId, itemId, approve) => {
      const account = get().account;
      patchDetail(sessionId, (d) => ({
        ...d,
        timeline: d.timeline.map((t) => (t.id === itemId && t.type === 'approval' && t.state === 'pending'
          ? { ...t, state: approve ? 'approved' : 'rejected', ...(account ? { decidedBy: account.id } : {}) }
          : t)),
      }));
      set((s) => ({ sessions: s.sessions.map((x) => (x.id === sessionId ? { ...x, pendingApprovals: Math.max(0, x.pendingApprovals - 1) } : x)) }));
      if (get().dataMode !== 'demo') return;
      if (!approve) {
        append(sessionId, { id: nextId('t'), type: 'system', tone: 'info', text: 'Command rejected. Nothing was run.' });
        return;
      }
      const toolsId = nextId('t');
      setStatus(sessionId, 'running');
      append(sessionId, { id: toolsId, type: 'tools', calls: [{ id: nextId('c'), tool: 'shell', summary: 'npm test -- test/webhooks', status: 'running' }] });
      setTimeout(() => {
        patchDetail(sessionId, (d) => ({
          ...d,
          timeline: d.timeline.map((t) => (t.id === toolsId && t.type === 'tools'
            ? { ...t, calls: t.calls.map((c) => ({ ...c, status: 'completed', exitCode: 0, durationMs: 2410, detail: 'PASS  test/webhooks/handler.test.ts (6)\nPASS  test/webhooks/rate-limit.test.ts (3)\n\nTests: 9 passed, 9 total' })) }
            : t.type === 'plan' ? { ...t, steps: t.steps.map((st) => ({ ...st, state: 'done' as const })) } : t)),
        }));
        append(sessionId, { id: nextId('t'), type: 'agent', model: get().details[sessionId]?.model.label ?? 'Model', streaming: false, text: 'All **9 tests pass**, including the new empty-bucket case. Over-limit webhooks now get `429` with a `Retry-After` header, keyed by merchant ID.\n\nThe changes are ready for review in the **Changes** panel.' });
        setStatus(sessionId, 'inactive');
      }, 1600);
    },

    answerQuestion: (sessionId, itemId, answer) =>
      patchDetail(sessionId, (d) => ({ ...d, timeline: d.timeline.map((t) => (t.id === itemId && t.type === 'question' ? { ...t, answer } : t)) })),

    setMode: (sessionId, mode) => {
      if (get().dataMode === 'live') return void live.setMode(sessionId, mode);
      patchDetail(sessionId, (d) => ({ ...d, mode }));
      append(sessionId, { id: nextId('t'), type: 'system', tone: 'info', text: mode === 'build' ? 'Switched to Build. Every command still needs host approval.' : 'Switched to Plan. Writes, shell and external actions are blocked.' });
    },
    setReasoning: (sessionId, reasoning) => patchDetail(sessionId, (d) => ({ ...d, reasoning })),
    stop: (sessionId) => {
      if(get().dataMode==='live')return void import('../live/execution').then(module=>module.stopRun(sessionId));
      setStatus(sessionId, 'paused');
      patchDetail(sessionId, (d) => ({ ...d, timeline: d.timeline.map((t) => (t.type === 'agent' && t.streaming ? { ...t, streaming: false } : t)) }));
      append(sessionId, { id: nextId('t'), type: 'system', tone: 'warn', text: 'Stopped by host. Pending authority was revoked; nothing will resume automatically.' });
    },
    resume: (sessionId) => {
      if(get().dataMode==='live')return void import('../live/execution').then(module=>module.runPending(sessionId));
      setStatus(sessionId, 'inactive');
      append(sessionId, { id: nextId('t'), type: 'system', tone: 'info', text: 'Resumed. The agent will continue on the next instruction.' });
    },
    saveDecision: (sessionId, text, reason, replaces) => {
      if(get().dataMode==='live')return void live.saveDecision(sessionId,text,reason,replaces);
      const account = get().account;
      if (!account) return;
      const decision: Decision = { id: nextId('d'), text, ...(reason ? { reason } : {}), authorId: account.id, source: 'Saved manually', status: 'current', createdAt: now() };
      patchDetail(sessionId, (d) => ({
        ...d,
        decisions: [decision, ...d.decisions.map((x) => (x.id === replaces ? { ...x, status: 'replaced' as const } : x))],
      }));
      append(sessionId, { id: nextId('t'), type: 'decision', decisionId: decision.id });
      get().toast('Decision saved and shared with the team', 'success');
    },

    togglePin: (id) => {
      set((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? { ...x, pinned: !x.pinned } : x)) }));
      live.persistLocal();
    },
    setArchived: (id, archived) => {
      set((s) => ({ sessions: s.sessions.map((x) => (x.id === id ? { ...x, archived, pinned: archived ? false : x.pinned } : x)) }));
      live.persistLocal();
      get().toast(archived ? 'Chat archived' : 'Chat restored');
    },
    rename: (id, title) => {
      const clean = title.trim().slice(0, 120);
      if (!clean) return;
      set((s) => ({
        sessions: s.sessions.map((x) => (x.id === id ? { ...x, title: clean } : x)),
        details: s.details[id] ? { ...s.details, [id]: { ...s.details[id], title: clean } } : s.details,
      }));
      live.persistLocal();
    },
    deleteSession: (id) => {
      if (get().dataMode === 'live') return void live.deleteSession(id);
      set((s) => {
        const details = { ...s.details };
        delete details[id];
        return { sessions: s.sessions.filter((x) => x.id !== id), details, activeId: s.activeId === id ? null : s.activeId, overlay: null };
      });
      get().toast('Shared session deleted. Project files and worktrees were not touched.');
    },
    toggleProject: (id) => {
      set((s) => ({ projects: s.projects.map((p) => (p.id === id ? { ...p, expanded: !p.expanded } : p)) }));
      live.persistLocal();
    },
    addProject: ({ name, folderHint }) => {
      set((s) => ({ projects: [...s.projects, { id: `p-${crypto.randomUUID()}`, name, folderHint, expanded: true }], overlay: null }));
      live.persistLocal();
      get().toast(`Project “${name}” saved. No agent was started.`, 'success');
    },
    setPrefs: (p) => set((s) => {
      const prefs = { ...s.prefs, ...p };
      writeJson(PREFS_KEY, prefs);
      return { prefs };
    }),
    setShowArchived: (showArchived) => set({ showArchived }),
    toast: (text, tone = 'info') => {
      const id = ++toastSeq;
      set((s) => ({ toasts: [...s.toasts.slice(-2), { id, text, tone }] }));
      setTimeout(() => get().dismissToast(id), 4200);
    },
    dismissToast: (id) => set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })),
  };
});

function basicDetail(summary: SessionSummary, account: Account | null, fresh = false): SessionDetail {
  const owner = account ?? { id: 'unknown', name: 'You', initials: 'Y', hue: 200 };
  return {
    id: summary.id,
    source: 'demo',
    title: summary.title,
    objective: '',
    mode: 'plan',
    status: summary.status,
    role: 'owner',
    capabilities: { submit: true, approve: true, configure: true, decide: true, delete: true },
    hostName: 'This computer',
    hostOnline: true,
    baseline: summary.projectId ? 'main @ 4f2c9a1' : 'Empty workspace',
    worktree: `chat-${summary.id}`,
    model: { id: 'demo-large', label: 'Large model', engine: 'App coding loop', reasoning: ['Low', 'Medium', 'High'] },
    reasoning: 'Medium',
    participants: [{ id: owner.id, name: owner.name, initials: owner.initials, hue: owner.hue, role: 'owner', presence: 'online', isHost: true, isLeader: true }],
    decisions: [],
    changes: [],
    timeline: fresh ? [] : [
      { id: `${summary.id}-sys`, sequence: 1, at: summary.updatedAt, type: 'system', tone: 'info', text: summary.projectId ? 'Session started from main @ 4f2c9a1 in a private worktree.' : 'Session started in an empty private workspace.' },
    ],
  };
}

function demoReply(prompt: string): string {
  const topic = prompt.length > 60 ? prompt.slice(0, 57) + '…' : prompt;
  return `I looked through the worktree for context on “${topic}”.\n\nThis is a **demo response**: no model was contacted and no files were changed. In a connected session I’d propose a short plan here, then ask for host approval before running any command.\n\n- Read the relevant files\n- Propose the smallest change that satisfies the current decisions\n- Ask before running tests`;
}
