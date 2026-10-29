import { useMemo, useState, type ReactNode } from 'react';
import {
  Activity, Bookmark, Check, ChevronRight, CircleAlert, CircleCheck, CircleX, Crown, FileCode2, FileDiff, FolderTree, Laptop,
  Loader2, Plus, ShieldCheck, UserCheck, UserMinus, Users, WrapText, X, Clock,
} from 'lucide-react';
import { useApp } from '../model/store';
import * as live from '../live/controller';
import { hueFor, relativeTime } from '../model/format';
import type { FileChange, InspectorTab, SessionDetail, ToolCall } from '../model/types';
import { Avatar, Button, EmptyState, IconButton, Menu, Segmented, cx } from '../ui/primitives';

const TABS: { id: InspectorTab; label: string; icon: typeof FileDiff }[] = [
  { id: 'changes', label: 'Changes', icon: FileDiff },
  { id: 'activity', label: 'Activity', icon: Activity },
  { id: 'approvals', label: 'Approvals', icon: ShieldCheck },
  { id: 'decisions', label: 'Decisions', icon: Bookmark },
  { id: 'people', label: 'People', icon: Users },
  { id: 'files', label: 'Files', icon: FolderTree },
];

export function Inspector({ d }: { d: SessionDetail }) {
  const tab = useApp((s) => s.inspectorTab);
  const app = useApp.getState();
  const pending = d.timeline.filter((t) => t.type === 'approval' && t.state === 'pending').length;
  const liveRequests = useApp((s) => s.joinRequests[d.id]?.length ?? 0);
  const counts: Partial<Record<InspectorTab, number>> = d.source === 'live' ? { people: d.participants.length } : {
    changes: d.changes.length,
    approvals: pending,
    decisions: d.decisions.filter((x) => x.status === 'current').length,
    people: d.participants.length,
  };

  return (
    <aside className="inspector" aria-label="Session details">
      <div className="inspector-tabs drag" role="tablist" aria-label="Panels">
        {TABS.map((t) => {
          const Icon = t.icon;
          const selected = t.id === tab;
          return (
            <button
              key={t.id}
              role="tab"
              type="button"
              id={`tab-${t.id}`}
              aria-selected={selected}
              aria-controls={`panel-${t.id}`}
              tabIndex={selected ? 0 : -1}
              className={cx('inspector-tab no-drag', selected && 'is-selected', ((t.id === 'approvals' && pending > 0) || (t.id === 'people' && liveRequests > 0)) && 'has-attention')}
              onClick={() => app.setInspector(true, t.id)}
              onKeyDown={(e) => {
                const i = TABS.findIndex((x) => x.id === tab);
                const delta = e.key === 'ArrowRight' ? 1 : e.key === 'ArrowLeft' ? -1 : 0;
                if (!delta) return;
                const next = TABS[(i + delta + TABS.length) % TABS.length];
                if (next) {
                  app.setInspector(true, next.id);
                  document.getElementById(`tab-${next.id}`)?.focus();
                }
              }}
              data-tip={t.label}
            >
              <Icon size={15} strokeWidth={1.8} aria-hidden />
              <span className="inspector-tab-label">{t.label}</span>
              {counts[t.id] ? <span className="tab-count">{counts[t.id]}</span> : null}
            </button>
          );
        })}
      </div>
      <div className="inspector-body" role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {d.source === 'live' && tab !== 'people' ? <LiveUnavailable tab={tab} /> : <>
        {tab === 'changes' && <ChangesPanel d={d} />}
        {tab === 'activity' && <ActivityPanel d={d} />}
        {tab === 'approvals' && <ApprovalsPanel d={d} />}
        {tab === 'decisions' && <DecisionsPanel d={d} />}
        {tab === 'people' && <PeoplePanel d={d} />}
        {tab === 'files' && (
          <EmptyState icon={FolderTree} title="File browser isn’t available yet">
            Browsing the worktree needs the local runtime’s safe file tools. Until then, review edits in Changes.
          </EmptyState>
        )}
        </>}
      </div>
    </aside>
  );
}

const LIVE_COPY: Record<Exclude<InspectorTab, 'people'>, { icon: typeof FileDiff; title: string; body: string }> = {
  changes: { icon: FileDiff, title: 'No changes to review yet', body: 'The agent runtime isn’t enabled on this service, so nothing edits files yet. Changes will appear here once it is.' },
  activity: { icon: Activity, title: 'No agent activity yet', body: 'Tool calls show up here once the service can run an agent. For now, plan and discuss together.' },
  approvals: { icon: ShieldCheck, title: 'Nothing to approve', body: 'Commands need the agent runtime, which isn’t enabled on this service. When it is, every command waits here for the host.' },
  decisions: { icon: Bookmark, title: 'Decisions aren’t available yet', body: 'This service doesn’t store shared decisions yet. Agree in Team discussion for now.' },
  files: { icon: FolderTree, title: 'File browser isn’t available yet', body: 'Browsing the worktree needs the local runtime’s safe file tools.' },
};

function LiveUnavailable({ tab }: { tab: InspectorTab }) {
  if (tab === 'people') return null;
  const c = LIVE_COPY[tab];
  return <EmptyState icon={c.icon} title={c.title}>{c.body}</EmptyState>;
}

function PanelHeader({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode }) {
  return (
    <div className="panel-header">
      <div>
        <h2 className="panel-title">{title}</h2>
        {sub && <p className="panel-sub">{sub}</p>}
      </div>
      <span className="spacer" />
      {children}
    </div>
  );
}

/* ---------------------------------------------------------------- Changes */

function ChangesPanel({ d }: { d: SessionDetail }) {
  const [layout, setLayout] = useState<'unified' | 'split'>('unified');
  const [wrap, setWrap] = useState(false);
  const [viewed, setViewed] = useState<Record<string, boolean>>({});
  const [open, setOpen] = useState<Record<string, boolean>>(() => Object.fromEntries(d.changes.map((c, i) => [c.path, i < 2])));
  const add = d.changes.reduce((n, c) => n + c.additions, 0);
  const del = d.changes.reduce((n, c) => n + c.deletions, 0);
  const viewedCount = d.changes.filter((c) => viewed[c.path]).length;

  if (d.changes.length === 0) {
    return <EmptyState icon={FileDiff} title="No changes yet">Edits the agent makes in this session’s worktree show up here for review.</EmptyState>;
  }

  return (
    <div className="panel">
      <PanelHeader
        title={`${d.changes.length} files changed`}
        sub={<><span className="tone-ok">+{add}</span> <span className="tone-danger">−{del}</span> · {viewedCount}/{d.changes.length} viewed by you</>}
      >
        <Segmented label="Diff layout" size="sm" value={layout} onChange={setLayout} options={[{ value: 'unified', label: 'Unified' }, { value: 'split', label: 'Split' }]} />
        <IconButton size="sm" icon={WrapText} label={wrap ? 'Don’t wrap lines' : 'Wrap lines'} active={wrap} onClick={() => setWrap(!wrap)} />
      </PanelHeader>
      <div className="files">
        {d.changes.map((c) => (
          <div key={c.path} className={cx('file', viewed[c.path] && 'is-viewed')}>
            <div className="file-head">
              <button type="button" className="file-toggle" aria-expanded={Boolean(open[c.path])} onClick={() => setOpen({ ...open, [c.path]: !open[c.path] })}>
                <ChevronRight size={13} className={cx('chev', open[c.path] && 'is-open')} aria-hidden />
                <FileCode2 size={14} aria-hidden className="tone-muted" />
                <span className="file-path">
                  <span className="file-dir">{c.path.split('/').slice(0, -1).join('/')}/</span>
                  <span className="file-name">{c.path.split('/').at(-1)}</span>
                </span>
                <span className={cx('file-status', `is-${c.status}`)}>{c.status === 'added' ? 'A' : c.status === 'deleted' ? 'D' : 'M'}</span>
                <span className="file-stat"><span className="tone-ok">+{c.additions}</span> <span className="tone-danger">−{c.deletions}</span></span>
              </button>
              <label className="viewed-toggle" title="Private to you. Not a shared review claim.">
                <input type="checkbox" checked={Boolean(viewed[c.path])} onChange={(e) => {
                  setViewed({ ...viewed, [c.path]: e.target.checked });
                  if (e.target.checked) setOpen({ ...open, [c.path]: false });
                }} />
                Viewed
              </label>
            </div>
            {open[c.path] && <Diff change={c} layout={layout} wrap={wrap} />}
          </div>
        ))}
      </div>
    </div>
  );
}

function Diff({ change, layout, wrap }: { change: FileChange; layout: 'unified' | 'split'; wrap: boolean }) {
  return (
    <div className={cx('diff', wrap && 'is-wrapped', `is-${layout}`)}>
      {change.hunks.map((h, hi) => (
        <div key={hi} className="hunk">
          <div className="hunk-head">{h.header}</div>
          {layout === 'unified' ? (
            h.lines.map((l, i) => (
              <div key={i} className={cx('dl', `dl-${l.kind}`)}>
                <span className="ln">{l.oldNo ?? ''}</span>
                <span className="ln">{l.newNo ?? ''}</span>
                <span className="dl-sign" aria-hidden>{l.kind === 'add' ? '+' : l.kind === 'del' ? '−' : ' '}</span>
                <code className="dl-text">{l.text || ' '}</code>
              </div>
            ))
          ) : (
            splitRows(h.lines).map((row, i) => (
              <div key={i} className="split-row">
                {[row.left, row.right].map((l, side) => (
                  <div key={side} className={cx('dl', l ? `dl-${l.kind}` : 'dl-empty')}>
                    <span className="ln">{l ? (side === 0 ? l.oldNo : l.newNo) ?? '' : ''}</span>
                    <code className="dl-text">{l?.text || ' '}</code>
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      ))}
    </div>
  );
}

type DiffLine = FileChange['hunks'][number]['lines'][number];
function splitRows(lines: DiffLine[]) {
  const rows: { left?: DiffLine; right?: DiffLine }[] = [];
  let dels: DiffLine[] = [];
  let adds: DiffLine[] = [];
  const flush = () => {
    for (let i = 0; i < Math.max(dels.length, adds.length); i++) {
      const left = dels[i];
      const right = adds[i];
      rows.push({ ...(left ? { left } : {}), ...(right ? { right } : {}) });
    }
    dels = [];
    adds = [];
  };
  for (const l of lines) {
    if (l.kind === 'del') dels.push(l);
    else if (l.kind === 'add') adds.push(l);
    else {
      flush();
      rows.push({ left: l, right: l });
    }
  }
  flush();
  return rows;
}

/* ---------------------------------------------------------------- Activity */

function ActivityPanel({ d }: { d: SessionDetail }) {
  const [filter, setFilter] = useState<'all' | 'running' | 'problems'>('all');
  const calls = useMemo(() => d.timeline.flatMap((t) => (t.type === 'tools' ? t.calls.map((c) => ({ ...c, at: t.at })) : [])).reverse(), [d.timeline]);
  const shown = calls.filter((c) => filter === 'all' || (filter === 'running' ? c.status === 'running' || c.status === 'pending' : c.status === 'failed' || c.status === 'uncertain'));
  return (
    <div className="panel">
      <PanelHeader title="Activity" sub="Every tool call, newest first">
        <Segmented label="Filter" size="sm" value={filter} onChange={setFilter} options={[{ value: 'all', label: 'All' }, { value: 'running', label: 'Running' }, { value: 'problems', label: 'Problems' }]} />
      </PanelHeader>
      {shown.length === 0 ? (
        <EmptyState icon={Activity} title={filter === 'all' ? 'No tool activity yet' : 'Nothing here'} />
      ) : (
        <ul className="activity-list">
          {shown.map((c) => (
            <li key={c.id} className="activity-row">
              <ActivityIcon status={c.status} />
              <div className="activity-main">
                <span className={cx('activity-summary', c.tool === 'shell' && 'mono')}>{c.summary}</span>
                <span className="activity-meta">{c.tool} · {relativeTime(c.at)}{c.exitCode !== undefined ? ` · exit ${c.exitCode}` : ''}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function ActivityIcon({ status }: { status: ToolCall['status'] }) {
  if (status === 'running') return <Loader2 size={14} className="spin tone-accent" aria-label="Running" />;
  if (status === 'completed') return <CircleCheck size={14} className="tone-ok" aria-label="Completed" />;
  if (status === 'failed') return <CircleX size={14} className="tone-danger" aria-label="Failed" />;
  if (status === 'uncertain') return <CircleAlert size={14} className="tone-warn" aria-label="Uncertain" />;
  return <Clock size={14} className="tone-muted" aria-label="Pending" />;
}

/* ---------------------------------------------------------------- Approvals */

function ApprovalsPanel({ d }: { d: SessionDetail }) {
  const approvals = d.timeline.filter((t) => t.type === 'approval').reverse();
  if (approvals.length === 0) {
    return <EmptyState icon={ShieldCheck} title="No approval requests">Every command the agent wants to run on the host appears here first.</EmptyState>;
  }
  return (
    <div className="panel">
      <PanelHeader title="Approvals" sub={d.capabilities.approve ? 'You approve every command that runs on this computer' : `Only the host on ${d.hostName} can approve`} />
      <ul className="approval-list">
        {approvals.map((a) => a.type === 'approval' && (
          <li key={a.id}>
            <button type="button" className="approval-item" onClick={() => useApp.setState({ focusedApproval: a.id })}>
              <span className={cx('pill', `pill-${a.state}`)}>{a.state}</span>
              <span className="approval-item-main">
                <span className="approval-item-title">{a.title}</span>
                <code className="approval-item-cmd">{a.descriptor.args.at(-1)}</code>
              </span>
              <ChevronRight size={14} className="tone-muted" aria-hidden />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

/* ---------------------------------------------------------------- Decisions */

function DecisionsPanel({ d }: { d: SessionDetail }) {
  const account = useApp((s) => s.account);
  const app = useApp.getState();
  const [composing, setComposing] = useState<null | { replaces?: string }>(null);
  const [text, setText] = useState('');
  const [reason, setReason] = useState('');
  const [showReplaced, setShowReplaced] = useState(false);
  const people = new Map(d.participants.map((p) => [p.id, p]));
  const current = d.decisions.filter((x) => x.status === 'current');
  const replaced = d.decisions.filter((x) => x.status === 'replaced');
  const running = d.status === 'running';
  const canDecide = d.capabilities.decide && !running;

  const save = () => {
    if (!text.trim()) return;
    app.saveDecision(d.id, text.trim(), reason.trim() || undefined, composing?.replaces);
    setComposing(null);
    setText('');
    setReason('');
  };

  return (
    <div className="panel">
      <PanelHeader title="Decisions" sub="Agreed constraints the agent applies to every instruction">
        <Button
          size="sm"
          icon={Plus}
          disabled={!canDecide}
          title={!d.capabilities.decide ? 'Viewers can’t save decisions' : running ? 'Stop the agent to save a decision' : undefined}
          onClick={() => setComposing({})}
        >
          New
        </Button>
      </PanelHeader>

      {composing && (
        <div className="decision-form">
          {composing.replaces && <p className="form-note">Replacing: “{d.decisions.find((x) => x.id === composing.replaces)?.text}”</p>}
          <label className="field">
            <span className="field-label">Decision</span>
            <textarea autoFocus rows={2} maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Keep the public API backwards compatible." />
          </label>
          <label className="field">
            <span className="field-label">Reason <span className="tone-muted">(optional)</span></span>
            <input maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          </label>
          <div className="form-actions">
            <Button size="sm" variant="ghost" onClick={() => setComposing(null)}>Cancel</Button>
            <Button size="sm" variant="primary" icon={Check} disabled={!text.trim()} onClick={save}>{composing.replaces ? 'Replace decision' : 'Save decision'}</Button>
          </div>
        </div>
      )}

      {current.length === 0 && !composing && (
        <EmptyState icon={Bookmark} title="No decisions yet">Save what the team agrees on so it survives summaries, reconnects and model changes.</EmptyState>
      )}

      <ul className="decision-list">
        {current.map((x) => {
          const author = people.get(x.authorId);
          const mayReplace = canDecide && (d.role === 'owner' || x.authorId === account?.id);
          return (
            <li key={x.id} className="decision-card">
              <p className="decision-text">{x.text}</p>
              {x.reason && <p className="decision-reason">{x.reason}</p>}
              <div className="decision-foot">
                {author && <Avatar name={author.name} initials={author.initials} hue={author.hue} size={16} />}
                <span>{author?.name ?? 'Someone'} · {x.source} · {relativeTime(x.createdAt)}</span>
                <span className="spacer" />
                {mayReplace && <button type="button" className="link-btn" onClick={() => { setComposing({ replaces: x.id }); setText(x.text); }}>Replace</button>}
              </div>
            </li>
          );
        })}
      </ul>

      {replaced.length > 0 && (
        <div className="replaced-section">
          <button type="button" className="disclosure" aria-expanded={showReplaced} onClick={() => setShowReplaced(!showReplaced)}>
            <ChevronRight size={13} className={cx('chev', showReplaced && 'is-open')} aria-hidden /> {replaced.length} replaced
          </button>
          {showReplaced && (
            <ul className="decision-list">
              {replaced.map((x) => (
                <li key={x.id} className="decision-card is-replaced">
                  <p className="decision-text">{x.text}</p>
                  <div className="decision-foot"><span>{people.get(x.authorId)?.name ?? 'Someone'} · {relativeTime(x.createdAt)}</span></div>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/* ---------------------------------------------------------------- People */

function PeoplePanel({ d }: { d: SessionDetail }) {
  const app = useApp.getState();
  const dataMode = useApp((s) => s.dataMode);
  const liveRequests = useApp((s) => s.joinRequests[d.id]);
  const [demoRequests, setRequests] = useState(dataMode === 'demo' && d.id === 's-rate' ? [{ id: 'jr1', name: 'Alex Chen', initials: 'AC', hue: 32, at: new Date(Date.now() - 4 * 60_000).toISOString() }] : []);
  const isLive = d.source === 'live';
  const requests = isLive
    ? (liveRequests ?? []).map((r) => {
        const short = r.userId.replace(/-/g, '').slice(0, 4).toUpperCase();
        return { id: r.id, name: `Teammate ${short}`, initials: short.slice(0, 2), hue: hueFor(r.userId), at: r.createdAt };
      })
    : demoRequests;
  const [busy, setBusy] = useState<string | null>(null);
  const owner = d.role === 'owner';
  const roleLabel = { owner: 'Owner', collaborator: 'Collaborator', viewer: 'Viewer' } as const;
  const resolve = async (id: string, name: string, role: 'collaborator' | 'viewer' | null) => {
    if (isLive) {
      if (!role) return;
      setBusy(id);
      await live.admit(d.id, id, role);
      setBusy(null);
      return;
    }
    setRequests((r) => r.filter((x) => x.id !== id));
    app.toast(role ? `${name} admitted as ${role}` : `Declined ${name}’s request`, role ? 'success' : 'info');
  };

  return (
    <div className="panel">
      <PanelHeader title="People" sub={`${d.participants.filter((p) => p.presence === 'online').length} online · ${d.participants.length} in session`}>
        {owner && <Button size="sm" icon={Plus} onClick={() => app.openOverlay('invite')}>Invite</Button>}
      </PanelHeader>

      {owner && requests.length > 0 && (
        <div className="join-requests">
          <h3 className="sub-label">Waiting to join</h3>
          {isLive && <p className="person-sub join-note">Names appear after you admit someone. Only admit people you invited.</p>}
          {requests.map((r) => (
            <div key={r.id} className="join-row">
              <Avatar name={r.name} initials={r.initials} hue={r.hue} size={28} />
              <div className="person-main">
                <span className="person-name">{r.name}</span>
                <span className="person-sub">Requested {relativeTime(r.at)} via invite link</span>
              </div>
              <div className="join-actions">
                {!isLive && <IconButton size="sm" icon={X} label="Decline" onClick={() => void resolve(r.id, r.name, null)} />}
                <Button size="sm" variant="secondary" disabled={busy === r.id} onClick={() => void resolve(r.id, r.name, 'viewer')}>Viewer</Button>
                <Button size="sm" variant="primary" icon={UserCheck} disabled={busy === r.id} onClick={() => void resolve(r.id, r.name, 'collaborator')}>Admit</Button>
              </div>
            </div>
          ))}
        </div>
      )}

      <ul className="people-list">
        {d.participants.map((p) => (
          <li key={p.id} className="person-row">
            <Avatar name={p.name} initials={p.initials} hue={p.hue} size={30} presence={p.presence} />
            <div className="person-main">
              <span className="person-name">
                {p.name}
                {p.isHost && <span className="tag" title="Runs the agent and holds approval authority"><Laptop size={10} aria-hidden /> Host</span>}
                {p.isLeader && <span className="tag" title="Currently leading the task"><Crown size={10} aria-hidden /> Lead</span>}
              </span>
              <span className="person-sub">{roleLabel[p.role]}{p.presence === 'unknown' ? '' : ` · ${p.presence === 'online' ? 'Online' : p.presence === 'idle' ? 'Idle' : 'Offline'}`}</span>
            </div>
            {isLive && owner && p.role !== 'owner' && (
              <Menu
                label={`Actions for ${p.name}`}
                align="end"
                width={220}
                items={[{ id: 'revoke', label: 'Remove from session', icon: UserMinus, danger: true, description: 'Their access ends immediately', onSelect: () => void live.revoke(d.id, p.id) }]}
                trigger={(t) => <IconButton {...t} size="sm" icon={X} label={`Remove ${p.name}`} className="row-action" />}
              />
            )}
          </li>
        ))}
      </ul>

      <div className="role-explainer">
        <h3 className="sub-label">What each role can do</h3>
        <dl>
          <div><dt>Owner</dt><dd>Everything, including approving commands on the host computer.</dd></div>
          <div><dt>Collaborator</dt><dd>Send instructions and discussion, save decisions. Can’t run anything on the host.</dd></div>
          <div><dt>Viewer</dt><dd>Read the conversation, decisions and changes.</dd></div>
        </dl>
      </div>
    </div>
  );
}
