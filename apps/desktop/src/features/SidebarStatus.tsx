import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Download, Gauge, Loader2, ShieldAlert } from 'lucide-react';
import { useApp } from '../model/store';
import { getBridge } from '../bridge/client';
import { getConnections } from '../live/execution';
import { useAssist } from '../live/assist';
import type { UsageLimits } from '../bridge/execution';
import { Menu, cx } from '../ui/primitives';

/** Plan windows only (a plan's 5-hour, weekly or used-up limit); per-minute API budgets aren't "usage left". */
export function planWindows(limits: UsageLimits | null): UsageLimits['windows'] {
  return (limits?.windows ?? []).filter((window) => !/per minute/iu.test(window.label));
}

const left = (used: number) => Math.max(0, Math.round(100 - used));
function resets(at: number | undefined, now: number): string {
  if (!at) return '';
  const minutes = Math.max(0, Math.round((at - now) / 60_000));
  if (minutes < 60) return `resets in ${Math.max(1, minutes)} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `resets in ${hours} h` : `resets in ${Math.round(hours / 24)} days`;
}
const tone = (remaining: number) => (remaining <= 10 ? 'is-danger' : remaining <= 30 ? 'is-warn' : '');

/**
 * A row of small circles at the bottom of the sidebar: a newer MultAI, context left in this chat, plan usage
 * left, approvals waiting and agents working. Each shows only when it has something to say.
 */
export function SidebarStatus() {
  const update = useUpdate();
  const plans = usePlans();
  const approvals = useApp((s) => s.hostApprovals);
  const sessions = useApp((s) => s.sessions);
  const select = useApp((s) => s.selectSession);
  const activeId = useApp((s) => s.activeId);
  const context = useAssist((s) => (activeId ? s.usage[activeId] : undefined));
  const now = Date.now();
  const running = useMemo(() => sessions.filter((s) => s.status === 'running'), [sessions]);
  const waitingIn = useMemo(() => [...new Set(approvals.map((a) => a.sessionId))], [approvals]);
  const contextLeft = context ? left((context.used / context.limit) * 100) : null;

  return (
    <div className="sidebar-status" role="group" aria-label="Status">
      {update && (
        <button type="button" className="status-circle is-update" title={`MultAI ${update.version} is available. Click to download.`} aria-label={`Download MultAI ${update.version}`} onClick={() => window.open(update.url, '_blank')}>
          <Download size={14} strokeWidth={2.2} aria-hidden />
        </button>
      )}
      {contextLeft !== null && (
        <span className={cx('status-circle', tone(contextLeft))} role="img" title={`Context: ${contextLeft}% left in this chat. Older messages are summarized when it runs out.`} aria-label={`Context ${contextLeft}% left`}>
          <Ring percent={contextLeft} />
        </span>
      )}
      {plans.map((plan) => <PlanCircle key={plan.id} plan={plan} now={now} />)}
      {approvals.length > 0 && (
        <button type="button" className="status-circle is-alert" title={`${approvals.length} approval${approvals.length === 1 ? '' : 's'} waiting. Click to open.`} aria-label={`${approvals.length} approvals waiting`} onClick={() => waitingIn[0] && select(waitingIn[0])}>
          <ShieldAlert size={14} aria-hidden />
          <span className="status-count" aria-hidden>{approvals.length > 9 ? '9+' : approvals.length}</span>
        </button>
      )}
      {running.length > 0 && (
        <button type="button" className="status-circle" title={`${running.length === 1 ? 'Agent working' : `${running.length} agents working`}: ${running.map((s) => s.title).join(', ')}`} aria-label={`${running.length} agents working`} onClick={() => running[0] && select(running[0].id)}>
          <Loader2 size={14} className="spin" aria-hidden />
          {running.length > 1 && <span className="status-count" aria-hidden>{running.length}</span>}
        </button>
      )}
    </div>
  );
}

interface Plan { id: string; name: string; provider: string; windows: UsageLimits['windows'] }

/** One plan's usage left: the fullest window as a ring, every window in the menu. */
function PlanCircle({ plan, now }: { plan: Plan; now: number }) {
  const known = plan.windows.length > 0;
  const tightest = known ? plan.windows.reduce((a, b) => (b.usedPercent > a.usedPercent ? b : a)) : null;
  const remaining = tightest ? left(tightest.usedPercent) : null;
  const chatgpt = plan.provider === 'chatgpt';
  const items = [
    { id: 'head', separator: true, label: `${plan.name} plan` },
    ...(known ? plan.windows.map((w, i) => ({ id: `w${i}`, label: w.label === 'Plan limit' ? 'Used up for now' : `${w.label}: ${left(w.usedPercent)}% left`, description: resets(w.resetsAt, now) || 'Reported by the provider', onSelect: () => undefined }))
      : [{ id: 'none', label: 'Usage left isn’t shared with apps', description: chatgpt ? 'OpenAI shows it only on chatgpt.com' : 'Reported after the next request', onSelect: () => undefined }]),
    ...(chatgpt ? [{ id: 'open', label: 'See usage on chatgpt.com', onSelect: () => void getBridge()?.inference?.manageChatGPTUsage() }] : []),
  ];
  const label = remaining !== null ? `${plan.name} plan: ${remaining}% left` : `${plan.name} plan usage`;
  return (
    <Menu label={label} side="top" width={248} items={items}
      trigger={(t) => (
        <button type="button" {...t} className={cx('status-circle', remaining !== null && tone(remaining))} title={label} aria-label={label}>
          {remaining !== null ? <Ring percent={remaining} /> : <Gauge size={14} aria-hidden />}
        </button>
      )} />
  );
}

function Ring({ percent }: { percent: number }): ReactNode {
  const radius = 9, circumference = 2 * Math.PI * radius;
  return (
    <svg width="22" height="22" viewBox="0 0 22 22" aria-hidden>
      <circle cx="11" cy="11" r={radius} className="usage-ring-track" />
      <circle cx="11" cy="11" r={radius} className="usage-ring-fill" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - percent / 100)} transform="rotate(-90 11 11)" />
    </svg>
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

/** Plans with usage to show: any connection that reported plan windows, and a ChatGPT plan always. */
function usePlans(): Plan[] {
  const [plans, setPlans] = useState<Plan[]>([]);
  useEffect(() => {
    let stopped = false;
    const refresh = async () => {
      const found: Plan[] = [];
      for (const connection of getConnections()) {
        const result = await getBridge()?.inference?.usageLimits(connection.id).catch(() => null);
        const windows = result?.ok ? planWindows(result.value) : [];
        if (windows.length || connection.provider === 'chatgpt') found.push({ id: connection.id, name: connection.name, provider: connection.provider, windows });
      }
      if (!stopped) setPlans(found);
    };
    void refresh();
    const timer = setInterval(() => void refresh(), 20_000);
    const changed = () => void refresh();
    window.addEventListener('multai:selection-changed', changed);
    return () => { stopped = true; clearInterval(timer); window.removeEventListener('multai:selection-changed', changed); };
  }, []);
  return plans;
}
