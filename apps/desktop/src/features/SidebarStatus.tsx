import { useEffect, useState } from 'react';
import { Download } from 'lucide-react';
import { useApp } from '../model/store';
import { getBridge } from '../bridge/client';
import { getSelectedConnection } from '../live/execution';
import { useAssist } from '../live/assist';
import type { UsageLimits } from '../bridge/execution';
import { Menu } from '../ui/primitives';

/** Bottom-left status: a blue download circle when a newer MultAI is published, and a usage ring. */
export function SidebarStatus() {
  const update = useUpdate();
  return (
    <div className="sidebar-status">
      {update && (
        <button type="button" className="update-dot no-drag" title={`MultAI ${update.version} is available`} aria-label={`Download MultAI ${update.version}`} onClick={() => window.open(update.url, '_blank')}>
          <Download size={15} strokeWidth={2} aria-hidden />
        </button>
      )}
      <UsageRing />
    </div>
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

const pct = (value: number) => `${Math.round(value)}%`;
function resets(at: number | undefined, now: number): string {
  if (!at) return '';
  const minutes = Math.max(0, Math.round((at - now) / 60_000));
  if (minutes < 1) return 'resets in under a minute';
  if (minutes < 60) return `resets in ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `resets in ${hours} h` : `resets in ${Math.round(hours / 24)} days`;
}

/**
 * The fullest limit the selected connection's provider reported, as a ring; the menu lists every window
 * and the open chat's context. Nothing is guessed: a provider that reports no limits shows only context.
 */
function UsageRing() {
  const activeId = useApp((s) => s.activeId);
  const context = useAssist((s) => (activeId ? s.usage[activeId] : undefined));
  const [limits, setLimits] = useState<UsageLimits | null>(null);
  const [connection, setConnection] = useState(() => getSelectedConnection());
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    let stopped = false;
    const refresh = () => {
      const selected = getSelectedConnection();
      setConnection(selected); setNow(Date.now());
      if (!selected) { setLimits(null); return; }
      void getBridge()?.inference?.usageLimits(selected.id).then((result) => { if (!stopped && result.ok) setLimits(result.value); }).catch(() => undefined);
    };
    refresh();
    const timer = setInterval(refresh, 20_000);
    window.addEventListener('multai:selection-changed', refresh);
    return () => { stopped = true; clearInterval(timer); window.removeEventListener('multai:selection-changed', refresh); };
  }, [activeId]);

  const contextPercent = context ? Math.min(100, (context.used / context.limit) * 100) : null;
  const fullest = limits?.windows.reduce((max, window) => Math.max(max, window.usedPercent), 0) ?? null;
  const shown = fullest ?? contextPercent ?? 0;
  const tone = shown >= 90 ? 'is-danger' : shown >= 70 ? 'is-warn' : '';
  const radius = 9, circumference = 2 * Math.PI * radius;
  const label = fullest !== null ? `Usage limits: ${pct(fullest)} of the fullest window used` : contextPercent !== null ? `Context: ${pct(contextPercent)} used` : 'Usage limits';

  return (
    <Menu
      label="Usage limits"
      side="top"
      width={260}
      items={[
        { id: 'conn', separator: true, label: connection ? `${connection.name}` : 'No AI connection selected' },
        ...(limits?.windows.length ? limits.windows.map((window, index) => ({
          id: `w${index}`, label: `${window.label}: ${pct(window.usedPercent)} used`, description: resets(window.resetsAt, now) || 'Reported by the provider', onSelect: () => undefined,
        })) : [{ id: 'none', label: 'No limits reported yet', description: connection ? 'They appear after the next request, if the provider reports them' : 'Choose a model in the composer', onSelect: () => undefined }]),
        ...(contextPercent !== null ? [{ id: 'ctx', label: `This chat’s context: ${pct(contextPercent)} used`, description: 'Compact it from the ring in the composer', onSelect: () => undefined }] : []),
      ]}
      trigger={(t) => (
        <button type="button" className={`usage-ring no-drag ${tone}`} aria-label={label} title={label} {...t}>
          <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden>
            <circle cx="12" cy="12" r={radius} className="usage-ring-track" />
            <circle cx="12" cy="12" r={radius} className="usage-ring-fill" strokeDasharray={circumference} strokeDashoffset={circumference * (1 - shown / 100)} transform="rotate(-90 12 12)" />
          </svg>
        </button>
      )}
    />
  );
}
