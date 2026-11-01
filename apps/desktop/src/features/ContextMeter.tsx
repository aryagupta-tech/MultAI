// How full the agent's input was at the start of the last run, as a small ring. Clicking it compacts.
import { useEffect } from 'react';
import { compact, loadUsage, useAssist } from '../live/assist';
import { cx } from '../ui/primitives';

export function ContextMeter({ sessionId }: { sessionId: string }) {
  const usage = useAssist((s) => s.usage[sessionId]);
  const busy = useAssist((s) => Boolean(s.compacting[sessionId]));
  useEffect(() => { void loadUsage(sessionId); }, [sessionId]);
  if (!usage) return null;
  const share = Math.min(1, usage.used / usage.limit);
  const percent = Math.round(share * 100);
  const radius = 6.5;
  const length = 2 * Math.PI * radius;
  const tone = share >= 0.7 ? 'is-high' : share >= 0.45 ? 'is-mid' : '';
  const tip = `${usage.used ? `Context ${percent}% full at the start of the last run.` : 'Context was compacted.'}${usage.compactedAt ? ` Compacted ${new Date(usage.compactedAt).toLocaleString()}.` : ''} Click to compact now.`;
  return (
    <button
      type="button"
      className={cx('context-meter', tone)}
      onClick={() => void compact(sessionId)}
      disabled={busy}
      aria-label={`Context ${percent}% full. Compact the conversation`}
      data-tip={tip}
      data-tip-side="top"
    >
      {busy ? <span className="spinner" style={{ width: 14, height: 14 }} aria-hidden /> : (
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden>
          <circle cx="8" cy="8" r={radius} className="context-meter-track" />
          <circle cx="8" cy="8" r={radius} className="context-meter-fill" strokeDasharray={`${share * length} ${length}`} transform="rotate(-90 8 8)" />
        </svg>
      )}
      <span className="context-meter-label">{percent}%</span>
    </button>
  );
}
