import { useEffect, useMemo, useState } from 'react';
import { Download, ExternalLink, Loader2, Settings2, ShieldAlert } from 'lucide-react';
import { create } from 'zustand';
import { useApp } from '../model/store';
import { getBridge } from '../bridge/client';
import { getConnections } from '../live/execution';
import { useAssist } from '../live/assist';
import type { UsageLimits } from '../bridge/execution';
import { IconButton, Menu, cx } from '../ui/primitives';

/** What the sidebar's status area shows; each person chooses, on this device. */
interface StatusPrefs { updates: boolean; approvals: boolean; running: boolean; usage: boolean; context: boolean }
const PREFS_KEY = 'multai.sidebar-status.v1';
const DEFAULTS: StatusPrefs = { updates: true, approvals: true, running: true, usage: true, context: true };
const LABELS: Record<keyof StatusPrefs, string> = { updates: 'App updates', approvals: 'Approvals waiting', running: 'Agents working', usage: 'Plan usage left', context: 'Context left in this chat' };
function readPrefs(): StatusPrefs {
  try { return { ...DEFAULTS, ...(JSON.parse(localStorage.getItem(PREFS_KEY) ?? '{}') as Partial<StatusPrefs>) }; } catch { return DEFAULTS; }
}
const usePrefs = create<StatusPrefs>()(() => readPrefs());
function toggle(key: keyof StatusPrefs): void {
  const next = { ...usePrefs.getState(), [key]: !usePrefs.getState()[key] };
  usePrefs.setState(next);
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch { /* a per-device convenience only */ }
}

/** Plan windows only (a ChatGPT plan's 5-hour and weekly limits); per-minute API budgets aren't "usage left". */
export function planWindows(limits: UsageLimits | null): UsageLimits['windows'] {
  return (limits?.windows ?? []).filter((window) => !/per minute/iu.test(window.label));
}

function resets(at: number | undefined, now: number): string {
  if (!at) return '';
  const minutes = Math.max(0, Math.round((at - now) / 60_000));
  if (minutes < 60) return `resets in ${Math.max(1, minutes)} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `resets in ${hours} h` : `resets in ${Math.round(hours / 24)} days`;
}
const left = (used: number) => Math.max(0, Math.round(100 - used));

/**
 * Bottom-left status: what needs you (approvals, running agents), how much of your plan is left, and a
 * newer MultAI when one is published. Every row can be turned off from the gear.
 */
export function SidebarStatus() {
  const prefs = usePrefs();
  const update = useUpdate();
  const plans = usePlanUsage();
  const approvals = useApp((s) => s.hostApprovals);
  const sessions = useApp((s) => s.sessions);
  const select = useApp((s) => s.selectSession);
  const activeId = useApp((s) => s.activeId);
  const context = useAssist((s) => (activeId ? s.usage[activeId] : undefined));
  const now = Date.now();
  const running = useMemo(() => sessions.filter((s) => s.status === 'running'), [sessions]);
  const waitingIn = useMemo(() => [...new Set(approvals.map((a) => a.sessionId))], [approvals]);
  const contextLeft = context ? left((context.used / context.limit) * 100) : null;

  const rows = [
    prefs.updates && update && (
      <button key="update" type="button" className="status-row is-update" onClick={() => window.open(update.url, '_blank')} title={`Download MultAI ${update.version}`}>
        <span className="status-icon update-dot"><Download size={13} strokeWidth={2.2} aria-hidden /></span>
        <span className="status-text">Update to {update.version}</span>
      </button>
    ),
    prefs.approvals && approvals.length > 0 && (
      <button key="approvals" type="button" className="status-row is-alert" onClick={() => waitingIn[0] && select(waitingIn[0])}>
        <span className="status-icon"><ShieldAlert size={14} aria-hidden /></span>
        <span className="status-text">{approvals.length} approval{approvals.length === 1 ? '' : 's'} waiting</span>
      </button>
    ),
    prefs.running && running.length > 0 && (
      <button key="running" type="button" className="status-row" onClick={() => running[0] && select(running[0].id)} title={running.map((s) => s.title).join('\n')}>
        <span className="status-icon"><Loader2 size={14} className="spin" aria-hidden /></span>
        <span className="status-text">{running.length === 1 ? `Agent working · ${running[0]!.title}` : `${running.length} agents working`}</span>
      </button>
    ),
    ...(prefs.usage ? plans.map(({ name, windows }) => {
      // The ChatGPT plan reports no numbers; its usage page does.
      if (!windows.length) return (
        <button key={`plan-${name}`} type="button" className="status-row" onClick={() => void getBridge()?.inference?.manageChatGPTUsage()} title="Opens your plan's usage page on chatgpt.com">
          <span className="status-icon"><ExternalLink size={13} aria-hidden /></span>
          <span className="status-text">{name} · check usage left</span>
        </button>
      );
      const tightest = windows.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a));
      const remaining = left(tightest.usedPercent);
      return (
        <div key={`plan-${name}`} className={cx('status-row is-static', remaining <= 10 ? 'is-danger' : remaining <= 30 ? 'is-warn' : '')}
          title={windows.map((w) => `${w.label}: ${left(w.usedPercent)}% left${w.resetsAt ? `, ${resets(w.resetsAt, now)}` : ''}`).join('\n')}>
          <Ring percent={remaining} />
          <span className="status-text">{name} · <b>{remaining}% left</b>{tightest.label !== 'Plan limit' && <span className="status-sub"> {tightest.label.toLowerCase()}{tightest.resetsAt ? `, ${resets(tightest.resetsAt, now)}` : ''}</span>}</span>
        </div>
      );
    }) : []),
    prefs.context && contextLeft !== null && (
      <div key="context" className={cx('status-row is-static', contextLeft <= 10 ? 'is-danger' : contextLeft <= 30 ? 'is-warn' : '')} title="Room left in this chat before older messages are summarized">
        <Ring percent={contextLeft} />
        <span className="status-text">Context · <b>{contextLeft}% left</b></span>
      </div>
    ),
  ].filter(Boolean);

  return (
    <div className="sidebar-status">
      <div className="status-rows">{rows}</div>
      <Menu
        label="Customize status"
        side="top"
        align="end"
        width={232}
        items={[
          { id: 'head', separator: true, label: 'Show in the sidebar' },
          ...(Object.keys(LABELS) as (keyof StatusPrefs)[]).map((key) => ({ id: key, label: LABELS[key], checked: prefs[key], onSelect: () => toggle(key) })),
        ]}
        trigger={(t) => <IconButton {...t} className="status-customize" icon={Settings2} label="Customize status" />}
      />
    </div>
  );
}

function Ring({ percent }: { percent: number }) {
  const radius = 6, circumference = 2 * Math.PI * radius;
  return (
    <span className="status-icon" aria-hidden>
      <svg width="16" height="16" viewBox="0 0 16 16">
        <circle cx="8" cy="8" r={radius} className="usage-ring-track" />
        <circle cx="8" cy="8" r={radius} className="usage-ring-fill" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - percent / 100)} transform="rotate(-90 8 8)" />
      </svg>
    </span>
  );
}

function useUpdate(): { version: string; url: string } | null {
  const [update, setUpdate] = useState<{ version: string; url: string } | null>(null);
  useEffect(() => {
    let stopped = false;
    const check = () => void getBridge()?.checkForUpdate?.().then((value) => { if (!stopped) setUpdate(value); }).catch(() => undefined);
    check();
    const timer = setInterval(check, 60 * 60 * 1000);
    return () => { stopped = true; clearInterval(timer); };
  }, []);
  return update;
}

/** Every ready connection whose provider reported plan windows, e.g. a ChatGPT plan, whichever model is selected. */
function usePlanUsage(): { name: string; windows: UsageLimits['windows'] }[] {
  const [plans, setPlans] = useState<{ name: string; windows: UsageLimits['windows'] }[]>([]);
  useEffect(() => {
    let stopped = false;
    const refresh = async () => {
      const found: { name: string; windows: UsageLimits['windows'] }[] = [];
      for (const connection of getConnections()) {
        const result = await getBridge()?.inference?.usageLimits(connection.id).catch(() => null);
        const windows = result?.ok ? planWindows(result.value) : [];
        // A ChatGPT plan is always listed: its numbers when a limit was reached, otherwise a link to its usage page.
        if (windows.length || connection.provider === 'chatgpt') found.push({ name: connection.name, windows });
      }
      if (!stopped) setPlans(found);
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 20_000);
    // Connections load after the window opens; show them as soon as they do.
    const changed = () => void refresh();
    window.addEventListener('multai:selection-changed', changed);
    return () => { stopped = true; clearInterval(timer); window.removeEventListener('multai:selection-changed', changed); };
  }, []);
  return plans;
}
