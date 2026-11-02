import {useEffect, useRef} from 'react';
import type {TimelineItem} from '@multai/companion-core';
import {cx, relative} from './ui';

/** The shared conversation: who said what, briefs, the agent's plan and what the desktop reported. */
export function Timeline({items, onSteer, onRemove, canChangeQueued, label = 'Session activity'}: {
  items: TimelineItem[]; label?: string;
  canChangeQueued?: ((item: Extract<TimelineItem, {kind: 'message'}>) => boolean) | undefined;
  onSteer?: ((id: string) => void) | undefined; onRemove?: ((id: string) => void) | undefined;
}) {
  const end = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  useEffect(() => {if (pinned.current) end.current?.scrollIntoView({block: 'end'});}, [items.length]);
  if (!items.length) return <p className="c-muted c-pad">Nothing here yet.</p>;
  return (
    <section className="c-timeline" aria-label={label} onScroll={event => {const el = event.currentTarget; pinned.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;}}>
      <ol>
        {items.map(item => <li key={`${item.id}-${item.sequence}`} className={cx('c-item', `c-item-${item.kind}`, item.kind === 'system' && `c-tone-${item.tone}`)}>{render(item, canChangeQueued, onSteer, onRemove)}</li>)}
      </ol>
      <div ref={end} />
    </section>
  );
}

function render(item: TimelineItem, canChange?: (item: Extract<TimelineItem, {kind: 'message'}>) => boolean, onSteer?: (id: string) => void, onRemove?: (id: string) => void) {
  const time = <time dateTime={item.at} className="c-time">{relative(item.at)}</time>;
  switch (item.kind) {
    case 'message': return (
      <article>
        <div className="c-meta"><b>{item.who}</b><span className={cx('c-chip', item.style === 'instruction' && 'is-strong')}>{item.style === 'instruction' ? 'Instruction' : 'Discussion'}</span>{item.queued && <span className="c-chip">Queued</span>}{time}</div>
        <p className="c-text">{item.text}</p>
        {item.screenshot && <p className="c-muted">Included a screenshot for the agent.</p>}
        {item.queued && canChange?.(item) && (
          <div className="c-row">
            {onSteer && <button type="button" className="c-link" onClick={() => onSteer(item.id)}>Steer now</button>}
            {onRemove && <button type="button" className="c-link" onClick={() => onRemove(item.id)}>Remove</button>}
          </div>
        )}
      </article>
    );
    case 'agent': return <article><div className="c-meta"><b>Agent</b>{time}</div><p className="c-text">{item.text}</p></article>;
    case 'brief': return <article className="c-brief"><div className="c-meta"><b>Catch-up brief</b><span className="c-chip">{item.model}</span>{time}</div><p className="c-text">{item.text}</p></article>;
    case 'comment': return <article><div className="c-meta"><b>{item.who}</b><span className="c-chip">Feedback</span>{time}</div><p className="c-text">{item.text}</p>{item.screenshotId && <p className="c-muted">Marked a region on a shared screenshot.</p>}</article>;
    case 'decision': return <article className="c-decision"><div className="c-meta"><b>{item.who}</b><span className="c-chip is-strong">Decision</span>{time}</div><p className="c-text">{item.text}</p></article>;
    case 'plan': return (
      <article><div className="c-meta"><b>Agent plan</b>{time}</div>
        <ul className="c-plan">{item.steps.map((step, index) => <li key={index} className={`is-${step.state}`}><span aria-hidden>{step.state === 'done' ? '✓' : step.state === 'active' ? '→' : '○'}</span> <span className="c-sr">{step.state === 'done' ? 'Done: ' : step.state === 'active' ? 'Now: ' : 'Next: '}</span>{step.text}</li>)}</ul>
      </article>
    );
    case 'activity': return <p className={cx('c-activity', item.failed && 'is-failed')}>{item.failed ? '✕ ' : '· '}{item.text} {time}</p>;
    case 'system': return <p className="c-system">{item.text} {time}</p>;
  }
}
