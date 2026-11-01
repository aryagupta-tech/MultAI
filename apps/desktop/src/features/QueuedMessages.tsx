// Messages the agent hasn't seen yet, above the composer. While the agent works, Steer hands one to it at
// its next step; otherwise they run after the current run, oldest first. Authors and the host can remove
// or edit them before the agent picks them up.
import { useMemo } from 'react';
import { Copy, CornerDownRight, MoreHorizontal, Pencil, Play, Trash2 } from 'lucide-react';
import { useApp } from '../model/store';
import type { SessionDetail } from '../model/types';
import { queuedInstructions } from '../live/projection';
import { copyQueued, editQueued, removeQueued, runQueued, steerQueued } from '../live/queue';
import { IconButton, Menu } from '../ui/primitives';

export function QueuedMessages({ d }: { d: SessionDetail }) {
  const me = useApp((s) => s.account?.id);
  const queued = useMemo(() => queuedInstructions(d.timeline), [d.timeline]);
  if (!queued.length) return null;
  const running = d.status === 'running';
  const host = d.capabilities.configure;
  const owner = d.role === 'owner';
  return (
    <section className="queue-strip" aria-label={`${queued.length} queued ${queued.length === 1 ? 'message' : 'messages'}`}>
      <ul>
        {queued.map((item, index) => {
          const mine = item.authorId === me;
          const canChange = mine || owner;
          const author = mine ? null : d.participants.find((p) => p.id === item.authorId)?.name ?? 'Former participant';
          return (
            <li key={item.id} className="queue-item">
              <CornerDownRight size={14} aria-hidden className="queue-icon" />
              <span className="queue-text" title={item.text}>
                {author && <span className="queue-author">{author}: </span>}
                {item.text.replace(/\s+/gu, ' ')}
              </span>
              {item.steer ? <span className="queue-state">Steering…</span>
                : running && canChange ? (
                  <button type="button" className="queue-action" onClick={() => void steerQueued(d.id, item.id)} title="The agent picks this up at its next step">
                    <CornerDownRight size={13} aria-hidden />Steer
                  </button>
                ) : !running && host && index === 0 ? (
                  <button type="button" className="queue-action" onClick={() => runQueued(d.id)}>
                    <Play size={12} aria-hidden />Run
                  </button>
                ) : null}
              {canChange && <IconButton size="sm" icon={Trash2} label="Remove from queue" onClick={() => void removeQueued(d.id, item.id)} />}
              <Menu
                label="Queued message actions"
                align="end"
                side="top"
                width={190}
                items={[
                  ...(mine ? [{ id: 'edit', label: 'Edit', icon: Pencil, onSelect: () => void editQueued(d.id, item.id, item.text) }] : []),
                  { id: 'copy', label: 'Copy text', icon: Copy, onSelect: () => void copyQueued(item.text) },
                ]}
                trigger={(props) => <IconButton {...props} size="sm" icon={MoreHorizontal} label="More actions" />}
              />
            </li>
          );
        })}
      </ul>
    </section>
  );
}
