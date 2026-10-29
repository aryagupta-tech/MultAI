import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle, ArrowDown, Bookmark, Check, ChevronRight, CircleAlert, CircleCheck, CircleDashed, CircleHelp, CircleX,
  FileText, FolderTree, GitMerge, Info, Loader2, PenLine, Search, ShieldCheck, Split, TerminalSquare, Users, Wrench,
} from 'lucide-react';
import { useApp } from '../model/store';
import { clockTime } from '../model/format';
import type { Decision, Participant, SessionDetail, TimelineItem, ToolCall } from '../model/types';
import { Avatar, Button, cx } from '../ui/primitives';
import { Markdown } from '../ui/Markdown';
import { Orb } from '../ui/Logo';

type Item<T extends TimelineItem['type']> = Extract<TimelineItem, { type: T }>;

export function Conversation({ d }: { d: SessionDetail }) {
  const scroller = useRef<HTMLDivElement>(null);
  const [atBottom, setAtBottom] = useState(true);
  const [unseen, setUnseen] = useState(0);
  const people = useMemo(() => new Map(d.participants.map((p) => [p.id, p])), [d.participants]);
  const decisions = useMemo(() => new Map(d.decisions.map((x) => [x.id, x])), [d.decisions]);
  const last = d.timeline.at(-1);
  const signature = `${d.timeline.length}:${last?.type === 'agent' ? last.text.length : ''}`;
  const lastCount = useRef(d.timeline.length);

  // Jump to the bottom when switching sessions.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
    setAtBottom(true);
    setUnseen(0);
    lastCount.current = d.timeline.length;
  }, [d.id]);

  // Follow new activity only while the reader is already at the bottom; otherwise preserve position.
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    if (atBottom) el.scrollTop = el.scrollHeight;
    else if (d.timeline.length > lastCount.current) setUnseen((n) => n + d.timeline.length - lastCount.current);
    lastCount.current = d.timeline.length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [signature]);

  const onScroll = () => {
    const el = scroller.current;
    if (!el) return;
    const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
    setAtBottom(bottom);
    if (bottom) setUnseen(0);
  };

  const jump = () => {
    scroller.current?.scrollTo({ top: scroller.current.scrollHeight, behavior: 'smooth' });
  };

  return (
    <div className="conversation-wrap">
      <div className="conversation" ref={scroller} onScroll={onScroll} role="log" aria-live="polite" aria-relevant="additions" aria-label="Session activity">
        <div className="conversation-inner">
          {d.objective && (
            <div className="objective">
              <span className="objective-label">Objective</span>
              <p>{d.objective}</p>
            </div>
          )}
          {d.timeline.length === 0 && <p className="timeline-empty">No activity yet.</p>}
          {d.timeline.map((item, i) => {
            const prev = d.timeline[i - 1];
            const grouped = item.type === 'message' && prev?.type === 'message' && prev.authorId === item.authorId && prev.kind === item.kind
              && new Date(item.at).getTime() - new Date(prev.at).getTime() < 5 * 60_000;
            return <TimelineRow key={item.id} item={item} d={d} people={people} decisions={decisions} grouped={grouped} />;
          })}
        </div>
      </div>
      {!atBottom && (
        <button type="button" className="latest-btn" onClick={jump}>
          <ArrowDown size={14} aria-hidden />
          {unseen > 0 ? `${unseen} new` : 'Latest activity'}
        </button>
      )}
    </div>
  );
}

function TimelineRow({ item, d, people, decisions, grouped }: {
  item: TimelineItem; d: SessionDetail; people: Map<string, Participant>; decisions: Map<string, Decision>; grouped: boolean;
}) {
  switch (item.type) {
    case 'message': return <MessageRow item={item} author={people.get(item.authorId)} grouped={grouped} />;
    case 'agent': return <AgentRow item={item} />;
    case 'tools': return <ToolGroup item={item} />;
    case 'approval': return <ApprovalCard item={item} d={d} people={people} />;
    case 'plan': return <PlanCard item={item} />;
    case 'decision': return <DecisionRow decision={decisions.get(item.decisionId)} people={people} />;
    case 'conflict': return <ConflictCard item={item} d={d} people={people} />;
    case 'question': return <QuestionCard item={item} d={d} />;
    case 'system': return <SystemRow item={item} />;
  }
}

/* ---------------------------------------------------------------- Human messages */

function MessageRow({ item, author, grouped }: { item: Item<'message'>; author: Participant | undefined; grouped: boolean }) {
  const name = author?.name ?? 'Former participant';
  const instruction = item.kind === 'instruction';
  return (
    <article className={cx('msg', instruction ? 'msg-instruction' : 'msg-discussion', grouped && 'is-grouped')} aria-label={`${name}, ${instruction ? 'instruction to agent' : 'team discussion'}`}>
      <div className="msg-gutter">
        {!grouped && <Avatar name={name} initials={author?.initials ?? '?'} hue={author?.hue ?? 0} size={28} />}
      </div>
      <div className="msg-body">
        {!grouped && (
          <header className="msg-head">
            <span className="msg-author">{name}</span>
            {author?.role === 'owner' && <span className="role-tag">Host</span>}
            <span className={cx('kind-tag', instruction ? 'is-instruction' : 'is-discussion')}>
              {instruction ? <><TerminalSquare size={11} aria-hidden />To agent</> : <><Users size={11} aria-hidden />Team</>}
            </span>
            {item.queue === 'pending' && <span className="queue-tag">Queued</span>}
            <time className="msg-time" dateTime={item.at}>{clockTime(item.at)}</time>
          </header>
        )}
        <div className="msg-text"><Markdown text={item.text} /></div>
      </div>
    </article>
  );
}

/* ---------------------------------------------------------------- Agent */

function AgentRow({ item }: { item: Item<'agent'> }) {
  return (
    <article className="msg msg-agent" aria-label="Agent response" aria-busy={item.streaming}>
      <div className="msg-gutter"><span className="agent-avatar"><Orb size={26} still={!item.streaming} /></span></div>
      <div className="msg-body">
        <header className="msg-head">
          <span className="msg-author">Agent</span>
          <span className="msg-model">{item.model}</span>
          <time className="msg-time" dateTime={item.at}>{clockTime(item.at)}</time>
        </header>
        {item.text ? (
          <div className="msg-text"><Markdown text={item.text} streaming={item.streaming} /></div>
        ) : (
          <div className="thinking" role="status"><span /><span /><span /><span className="sr-only">Agent is thinking</span></div>
        )}
      </div>
    </article>
  );
}

/* ---------------------------------------------------------------- Tools */

const TOOL_ICON = { read: FileText, search: Search, list: FolderTree, write: PenLine, shell: TerminalSquare, diff: Split } as const;

function ToolStatusIcon({ status }: { status: ToolCall['status'] }) {
  switch (status) {
    case 'running': return <Loader2 size={13} className="spin tone-accent" aria-label="Running" />;
    case 'completed': return <CircleCheck size={13} className="tone-ok" aria-label="Completed" />;
    case 'failed': return <CircleX size={13} className="tone-danger" aria-label="Failed" />;
    case 'uncertain': return <CircleAlert size={13} className="tone-warn" aria-label="Uncertain: needs review" />;
    default: return <CircleDashed size={13} className="tone-muted" aria-label="Pending" />;
  }
}

function ToolGroup({ item }: { item: Item<'tools'> }) {
  const showDetails = useApp((s) => s.prefs.showToolDetails);
  const running = item.calls.some((c) => c.status === 'running');
  const failed = item.calls.filter((c) => c.status === 'failed' || c.status === 'uncertain').length;
  const [open, setOpen] = useState(showDetails || running);
  useEffect(() => { if (running) setOpen(true); }, [running]);

  const writes = item.calls.filter((c) => c.tool === 'write').length;
  const summary = running
    ? item.calls.find((c) => c.status === 'running')?.summary ?? 'Working…'
    : writes === item.calls.length ? `Edited ${writes} file${writes > 1 ? 's' : ''}` : `Used ${item.calls.length} tool${item.calls.length > 1 ? 's' : ''}`;

  return (
    <div className={cx('tools', open && 'is-open')}>
      <button type="button" className="tools-head" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="tools-icon">{running ? <Loader2 size={13} className="spin" aria-hidden /> : <Wrench size={13} aria-hidden />}</span>
        <span className={cx('tools-summary', running && 'shimmer')}>{summary}</span>
        {failed > 0 && <span className="tools-failed">{failed} need review</span>}
        <span className="tools-chips" aria-hidden>
          {!open && item.calls.slice(0, 4).map((c) => {
            const Icon = TOOL_ICON[c.tool];
            return <Icon key={c.id} size={12} />;
          })}
        </span>
        <ChevronRight size={14} className={cx('chev', open && 'is-open')} aria-hidden />
      </button>
      {open && (
        <ul className="tools-list">
          {item.calls.map((c) => <ToolRow key={c.id} c={c} />)}
        </ul>
      )}
    </div>
  );
}

function ToolRow({ c }: { c: ToolCall }) {
  const [open, setOpen] = useState(false);
  const Icon = TOOL_ICON[c.tool];
  const multiline = c.detail?.includes('\n');
  return (
    <li className="tool-row">
      <button type="button" className="tool-line" onClick={() => multiline && setOpen(!open)} aria-expanded={multiline ? open : undefined} disabled={!multiline}>
        <Icon size={13} className="tone-muted" aria-hidden />
        <span className={cx('tool-summary', c.tool === 'shell' && 'mono')}>{c.summary}</span>
        {c.detail && !multiline && <span className="tool-detail">{c.detail}</span>}
        {c.exitCode !== undefined && <span className={cx('exit', c.exitCode === 0 ? 'tone-ok' : 'tone-danger')}>exit {c.exitCode}</span>}
        {c.durationMs !== undefined && <span className="tool-dur">{c.durationMs < 1000 ? `${c.durationMs}ms` : `${(c.durationMs / 1000).toFixed(1)}s`}</span>}
        <ToolStatusIcon status={c.status} />
      </button>
      {open && c.detail && <pre className="tool-output">{c.detail}</pre>}
    </li>
  );
}

/* ---------------------------------------------------------------- Approval */

function useCountdown(iso: string) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  const ms = new Date(iso).getTime() - now;
  if (ms <= 0) return null;
  const m = Math.floor(ms / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function ApprovalCard({ item, d, people }: { item: Item<'approval'>; d: SessionDetail; people: Map<string, Participant> }) {
  const app = useApp.getState();
  const focused = useApp((s) => s.focusedApproval === item.id);
  const remaining = useCountdown(item.descriptor.expiresAt);
  const pending = item.state === 'pending' && remaining !== null;
  const ref = useRef<HTMLDivElement>(null);
  const command = [item.descriptor.args.at(-1) ?? ''].join(' ');
  const decider = item.decidedBy ? people.get(item.decidedBy)?.name : undefined;

  useEffect(() => {
    if (focused) {
      ref.current?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      ref.current?.focus();
      useApp.setState({ focusedApproval: null });
    }
  }, [focused]);

  const state = item.state === 'pending' && remaining === null ? 'expired' : item.state;

  return (
    <div ref={ref} tabIndex={-1} className={cx('card approval', `is-${state}`)} role="group" aria-label={`Approval: ${item.title}`}>
      <header className="card-head">
        <span className="card-icon"><ShieldCheck size={15} aria-hidden /></span>
        <div className="card-titles">
          <span className="card-kicker">
            {state === 'pending' ? 'Approval needed' : state === 'approved' ? 'Approved' : state === 'rejected' ? 'Rejected' : 'Expired'}
            {decider && state !== 'pending' && state !== 'expired' && <> · by {decider}</>}
          </span>
          <h3 className="card-title">{item.title}</h3>
        </div>
        {pending && <span className="countdown" title="This request expires and cannot be approved after this">{remaining}</span>}
      </header>
      <p className="card-text">{item.reason}</p>

      <div className="cmd">
        <div className="cmd-line"><span className="cmd-prompt" aria-hidden>$</span><code>{command}</code></div>
        <dl className="cmd-meta">
          <div><dt>Shell</dt><dd className="mono">{item.descriptor.executable} {item.descriptor.args.slice(0, -1).join(' ')}</dd></div>
          <div><dt>Directory</dt><dd className="mono">{item.descriptor.cwd}</dd></div>
          <div><dt>Connection</dt><dd>{item.descriptor.connection}</dd></div>
          <div><dt>Fingerprint</dt><dd className="mono">{item.descriptor.hash} · gen {item.descriptor.generation}</dd></div>
        </dl>
      </div>

      {pending && (
        d.capabilities.approve ? (
          <footer className="card-actions">
            <p className="card-fine"><Info size={12} aria-hidden /> Runs once as your OS user on {d.hostName}. Approval isn’t a sandbox.</p>
            <div className="card-buttons">
              <Button size="sm" variant="ghost" onClick={() => app.decideApproval(d.id, item.id, false)}>Reject</Button>
              <Button size="sm" variant="primary" icon={Check} onClick={() => app.decideApproval(d.id, item.id, true)}>Approve and run</Button>
            </div>
          </footer>
        ) : (
          <footer className="card-actions"><p className="card-fine"><Loader2 size={12} className="spin" aria-hidden /> Waiting for the host to approve. Only the host can run commands.</p></footer>
        )
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- Plan */

function PlanCard({ item }: { item: Item<'plan'> }) {
  const done = item.steps.filter((s) => s.state === 'done').length;
  const pct = Math.round((done / Math.max(1, item.steps.length)) * 100);
  return (
    <div className="card plan" role="group" aria-label={`Plan: ${item.title}`}>
      <header className="card-head">
        <span className="card-icon"><GitMerge size={15} aria-hidden /></span>
        <div className="card-titles">
          <span className="card-kicker">Plan · {done} of {item.steps.length}</span>
          <h3 className="card-title">{item.title}</h3>
        </div>
      </header>
      <div className="progress" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}><span style={{ width: `${pct}%` }} /></div>
      <ol className="plan-steps">
        {item.steps.map((s, i) => (
          <li key={i} className={cx('plan-step', `is-${s.state}`)}>
            <span className="plan-mark" aria-hidden>
              {s.state === 'done' ? <Check size={11} strokeWidth={3} /> : s.state === 'active' ? <Loader2 size={11} className="spin" /> : null}
            </span>
            <span>{s.text}</span>
            <span className="sr-only">{s.state === 'done' ? '(done)' : s.state === 'active' ? '(in progress)' : ''}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

/* ---------------------------------------------------------------- Decision */

function DecisionRow({ decision, people }: { decision: Decision | undefined; people: Map<string, Participant> }) {
  if (!decision) return null;
  const author = people.get(decision.authorId)?.name ?? 'Someone';
  return (
    <div className={cx('decision-row', decision.status === 'replaced' && 'is-replaced')}>
      <span className="decision-icon"><Bookmark size={13} aria-hidden /></span>
      <div className="decision-body">
        <span className="decision-kicker">
          {author} saved a decision{decision.status === 'replaced' && <span className="replaced-tag">Replaced</span>}
        </span>
        <p className="decision-text">{decision.text}</p>
        {decision.reason && <p className="decision-reason">{decision.reason}</p>}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- Conflict */

function ConflictCard({ item, d, people }: { item: Item<'conflict'>; d: SessionDetail; people: Map<string, Participant> }) {
  const [a, b] = item.instructionIds.map((id) => d.timeline.find((t) => t.id === id)) as [TimelineItem | undefined, TimelineItem | undefined];
  const quote = (t: TimelineItem | undefined) =>
    t?.type === 'message' ? { who: people.get(t.authorId)?.name ?? 'Someone', text: t.text } : null;
  const qa = quote(a);
  const qb = quote(b);
  return (
    <div className={cx('card conflict', item.resolved && 'is-resolved')} role="group" aria-label="Conflicting instructions">
      <header className="card-head">
        <span className="card-icon"><AlertTriangle size={15} aria-hidden /></span>
        <div className="card-titles">
          <span className="card-kicker">{item.resolved ? 'Conflict resolved by host' : 'Paused for a decision'}</span>
          <h3 className="card-title">Two directions disagree</h3>
        </div>
      </header>
      <div className="conflict-pair">
        {[qa, qb].map((q, i) => q && (
          <blockquote key={i} className="conflict-quote">
            <span className="conflict-who">{q.who}</span>
            {q.text}
          </blockquote>
        ))}
      </div>
      {!item.resolved && d.role === 'owner' && <p className="card-fine">Save a decision to continue. The agent won’t pick a winner on its own.</p>}
    </div>
  );
}

/* ---------------------------------------------------------------- Question */

function QuestionCard({ item, d }: { item: Item<'question'>; d: SessionDetail }) {
  const app = useApp.getState();
  return (
    <div className="card question" role="group" aria-label="Question from the agent">
      <header className="card-head">
        <span className="card-icon"><CircleHelp size={15} aria-hidden /></span>
        <div className="card-titles">
          <span className="card-kicker">{item.answer ? 'Answered' : 'The agent is asking the host'}</span>
          <h3 className="card-title">{item.prompt}</h3>
        </div>
      </header>
      <div className="question-options">
        {item.options.map((o) => (
          <Button key={o} size="sm" variant={item.answer === o ? 'primary' : 'secondary'} disabled={Boolean(item.answer) || !d.capabilities.approve} onClick={() => app.answerQuestion(d.id, item.id, o)}>
            {o}
          </Button>
        ))}
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- System */

function SystemRow({ item }: { item: Item<'system'> }) {
  const Icon = item.tone === 'error' ? CircleX : item.tone === 'warn' ? AlertTriangle : Info;
  return (
    <div className={cx('system-row', `is-${item.tone}`)} role={item.tone === 'error' ? 'alert' : undefined}>
      <span className="system-line" aria-hidden />
      <span className="system-text"><Icon size={12} aria-hidden />{item.text}<time dateTime={item.at}>{clockTime(item.at)}</time></span>
      <span className="system-line" aria-hidden />
    </div>
  );
}
