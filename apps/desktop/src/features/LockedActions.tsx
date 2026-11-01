// An action whose outcome is unknown (the app quit mid-write, or a save failed after it was reserved)
// blocks the chat's next actions, so nothing is repeated by accident. The host says what happened here.
import { useEffect } from 'react';
import { CircleAlert, FileCode2, SquareTerminal } from 'lucide-react';
import type { LockedAction } from '../bridge/execution';
import { loadLocked, resolveLocked, useAssist } from '../live/assist';
import { Button } from '../ui/primitives';

const HINTS: Record<LockedAction['hint'], string> = {
  happened: 'The file has the new content, so the save went through.',
  did_not_happen: 'The file doesn’t have the new content, so the save didn’t happen.',
  unknown: 'MultAI can’t tell from here. Check the files or the terminal.',
};

export function LockedActions({ sessionId }: { sessionId: string }) {
  const locked = useAssist((s) => s.locked[sessionId]);
  useEffect(() => { void loadLocked(sessionId); }, [sessionId]);
  if (!locked?.length) return null;
  return (
    <section className="locked-actions" role="alert" aria-label="Actions to review">
      <header className="locked-head">
        <CircleAlert size={15} aria-hidden />
        <div>
          <strong>{locked.length === 1 ? 'One action needs your review' : `${locked.length} actions need your review`}</strong>
          <p className="field-help">MultAI couldn’t confirm whether {locked.length === 1 ? 'it' : 'they'} finished, so the agent won’t act in this chat until you say what happened. Nothing is retried automatically.</p>
        </div>
      </header>
      <ul>
        {locked.map((action) => {
          const Icon = action.kind === 'file_write' ? FileCode2 : SquareTerminal;
          const likely = action.hint === 'unknown' ? null : action.hint;
          return (
            <li key={action.id} className="locked-item">
              <Icon size={14} aria-hidden className="tone-muted" />
              <div className="locked-text">
                <span>{action.kind === 'file_write' ? 'Save ' : action.kind === 'shell' ? 'Run ' : 'Call '}<code className="truncate">{action.label}</code></span>
                <span className="field-help">{action.kind === 'file_write' ? HINTS[action.hint] : HINTS.unknown}</span>
              </div>
              <Button size="sm" variant={likely === 'did_not_happen' ? 'primary' : 'ghost'} onClick={() => void resolveLocked(sessionId, action.id, 'did_not_happen')}>It didn’t happen</Button>
              <Button size="sm" variant={likely === 'happened' ? 'primary' : 'ghost'} onClick={() => void resolveLocked(sessionId, action.id, 'happened')}>It happened</Button>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
