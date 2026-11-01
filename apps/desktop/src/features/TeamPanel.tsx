// Team chat: people talking to each other, beside the agent conversation. The agent reads these
// messages as context but never acts on them. Opens from the chat icon at the top right.
import { useEffect, useLayoutEffect, useMemo, useRef } from 'react';
import { MessageCircle, X } from 'lucide-react';
import { create } from 'zustand';
import { useApp } from '../model/store';
import { clockTime } from '../model/format';
import type { SessionDetail, TimelineItem } from '../model/types';
import { Avatar, IconButton, cx } from '../ui/primitives';
import { Markdown } from '../ui/Markdown';
import { Composer } from './Composer';

type TeamMessage = Extract<TimelineItem, { type: 'message' }>;
export const isTeamMessage = (item: TimelineItem): item is TeamMessage => item.type === 'message' && item.kind === 'discussion';

const seenKey = () => `multai.team-seen.v1:${useApp.getState().account?.id ?? 'signed-out'}`;
function readSeen(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(seenKey()) ?? '{}') as Record<string, number>; } catch { return {}; }
}
interface TeamState { open: boolean; seen: Record<string, number> }
export const useTeam = create<TeamState>()(() => ({ open: false, seen: readSeen() }));

/** One right-hand panel at a time: opening team chat closes the details panel, and the reverse. */
export function setTeamOpen(open: boolean): void {
  if (open) useApp.getState().setInspector(false);
  useTeam.setState({ open });
  if (open) requestAnimationFrame(() => window.dispatchEvent(new Event('multai:focus-team')));
}
useApp.subscribe((state, previous) => {
  if (state.inspectorOpen && !previous.inspectorOpen && useTeam.getState().open) useTeam.setState({ open: false });
  if (state.account?.id !== previous.account?.id) useTeam.setState({ open: false, seen: readSeen() });
});

function markSeen(sessionId: string, count: number): void {
  const seen = { ...useTeam.getState().seen, [sessionId]: count };
  useTeam.setState({ seen });
  try { localStorage.setItem(seenKey(), JSON.stringify(seen)); } catch { /* per-device convenience only */ }
}

/** Team messages from others that arrived since you last had the panel open. */
export function useUnreadTeam(d: SessionDetail | null): number {
  const me = useApp((s) => s.account?.id);
  const seen = useTeam((s) => (d ? s.seen[d.id] : undefined));
  return useMemo(() => {
    if (!d) return 0;
    const messages = d.timeline.filter(isTeamMessage);
    // First visit to a session: nothing counts as unread.
    if (seen === undefined) return 0;
    return messages.slice(seen).filter((m) => m.authorId !== me).length;
  }, [d, seen, me]);
}

export function TeamPanel({ d }: { d: SessionDetail }) {
  const messages = useMemo(() => d.timeline.filter(isTeamMessage), [d.timeline]);
  const people = useMemo(() => new Map(d.participants.map((p) => [p.id, p])), [d.participants]);
  const scroller = useRef<HTMLDivElement>(null);
  const others = d.participants.filter((p) => p.presence !== 'offline' && !p.isHost).length;

  useEffect(() => { markSeen(d.id, messages.length); }, [d.id, messages.length]);
  useLayoutEffect(() => { const el = scroller.current; if (el) el.scrollTop = el.scrollHeight; }, [d.id, messages.length]);

  return (
    <aside className="team-panel" aria-label="Team chat">
      <header className="team-head drag">
        <MessageCircle size={15} strokeWidth={1.8} aria-hidden />
        <div className="team-title">
          <strong>Team chat</strong>
          <span>{d.participants.length === 1 ? 'Only you so far. Invite a teammate to talk here.' : `${d.participants.length} people${others ? ` · ${others} online` : ''}`}</span>
        </div>
        <span className="spacer" />
        <IconButton className="no-drag" icon={X} label="Close team chat" onClick={() => setTeamOpen(false)} />
      </header>
      <div className="team-log" ref={scroller} role="log" aria-live="polite" aria-label="Team messages">
        {messages.length === 0 && (
          <p className="team-empty">Talk with your teammates here. The agent sees these messages as context but never acts on them.</p>
        )}
        {messages.map((m, i) => {
          const prev = messages[i - 1];
          const author = people.get(m.authorId);
          const name = author?.name ?? 'Former participant';
          const grouped = prev?.authorId === m.authorId && new Date(m.at).getTime() - new Date(prev.at).getTime() < 5 * 60_000;
          return (
            <article key={m.id} className={cx('team-msg', grouped && 'is-grouped')}>
              <div className="team-gutter">{!grouped && <Avatar name={name} initials={author?.initials ?? '?'} hue={author?.hue ?? 0} size={24} />}</div>
              <div className="team-body">
                {!grouped && (
                  <header className="team-msg-head">
                    <span className="msg-author">{name}</span>
                    <time className="msg-time" dateTime={m.at}>{clockTime(m.at)}</time>
                  </header>
                )}
                <div className="msg-text"><Markdown text={m.text} /></div>
                {m.image && <img className="msg-image" src={m.image} alt={`Screenshot from ${name}`} loading="lazy" />}
              </div>
            </article>
          );
        })}
      </div>
      <div className="team-composer">
        <Composer d={d} draftKey={`team:${d.id}`} team />
      </div>
    </aside>
  );
}
