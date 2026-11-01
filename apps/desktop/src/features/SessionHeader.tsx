import {useEffect, useState} from 'react';
import {
  Archive, Hammer, Laptop, ListChecks, MoreHorizontal, PanelLeftOpen, PanelRightClose, PanelRightOpen,
  Pencil, Pin, Play, Square, SquarePen, Trash2, UserPlus, GitBranch, Radio, Sparkles, MessageCircle,
} from 'lucide-react';
import { useApp } from '../model/store';
import type { SessionDetail } from '../model/types';
import { Avatar, Button, IconButton, Menu, Segmented, cx, shortcutText } from '../ui/primitives';
import * as execution from '../live/execution';
import {refreshWork,useWork} from '../live/work';
import {getBridge} from '../bridge/client';
import {ChatGPTPlanUsage,isChatGPTUsageLimit} from './ChatGPTPlanUsage';

export function SessionHeader({ d }: { d: SessionDetail | null }) {
  const { sidebarOpen, inspectorOpen, build, sessions, liveStatus } = useApp();
  const app = useApp.getState();
  const mac = build?.platform === 'darwin';
  const summary = d ? sessions.find((s) => s.id === d.id) : undefined;
  const [selection,setSelection] = useState(() => execution.getSelection());
  const [connection,setConnection] = useState(() => execution.getSelectedConnection());
  const [runIssue,setRunIssue] = useState(() => d ? execution.getRunIssue(d.id) : null);
  const [dispatching,setDispatching] = useState(false);
  const inference=getBridge()?.inference;
  useEffect(() => {
    const update = () => {
      setSelection(execution.getSelection());
      setConnection(execution.getSelectedConnection());
      setRunIssue(d ? execution.getRunIssue(d.id) : null);
    };
    update();
    window.addEventListener('multai:selection-changed',update);
    return () => window.removeEventListener('multai:selection-changed',update);
  },[d?.id]);

  const leading = !sidebarOpen && (
    <div className="header-leading no-drag">
      <IconButton icon={PanelLeftOpen} label="Show sidebar" shortcut={shortcutText('Mod+B')} onClick={app.toggleSidebar} />
      <IconButton icon={SquarePen} label="New chat" shortcut={shortcutText('Mod+N')} onClick={() => app.newChat(null)} />
    </div>
  );

  if (!d) {
    return (
      <header className={cx('session-header drag', !sidebarOpen && mac && 'has-traffic-lights')}>
        {leading}
        <span className="header-title-muted">New chat</span>
        <span className="spacer" />
        <div className="header-controls no-drag"><TeamChatToggle draftKey="new" /></div>
      </header>
    );
  }

  const running = d.status === 'running';
  const owner = d.role === 'owner';
  const modeLock = !owner ? 'Only the session owner can switch modes' : running ? 'Stop the agent to switch modes' : false;
  const statusLabel = running ? 'Working' : d.status === 'paused' ? 'Paused' : 'Ready';
  const others = d.participants.filter((p) => p.presence !== 'offline');
  const run = async () => {
    if (dispatching) return;
    setDispatching(true);
    try {await execution.runPending(d.id);}
    finally {setDispatching(false);}
  };

  return (
    <header className={cx('session-header drag', !sidebarOpen && mac && 'has-traffic-lights')}>
      {leading}
      <div className="header-identity">
        <h1 className="header-title truncate" title={d.title}>{d.title}</h1>
        <div className="header-meta">
          <span className={cx('state-chip', `is-${d.status}`)}>
            <span className="state-pulse" aria-hidden />
            {statusLabel}
          </span>
          <span className="meta-item" title="Files are stored and tools run on the original host. Selected text may be sent to the chosen AI provider.">
            <Laptop size={12} aria-hidden />
            <span className="truncate">{d.hostName}</span>
          </span>
          {d.baseline && (
            <span className="meta-item meta-hide-sm" title={`Worktree ${d.worktree}`}>
              <GitBranch size={12} aria-hidden />
              <span className="truncate">{d.baseline}</span>
            </span>
          )}
          {d.source === 'live' && d.capabilities.approve && <WorkChip sessionId={d.id} />}
          {d.source === 'live' && <LiveIndicator status={liveStatus[d.id]} />}
        </div>
      </div>

      <span className="spacer" />

      <div className="header-controls no-drag">
        <Segmented
          label="Execution mode"
          size="sm"
          value={d.mode}
          disabled={modeLock}
          onChange={(m) => app.setMode(d.id, m)}
          options={[
            { value: 'plan', label: 'Plan', icon: ListChecks, hint: 'Read and discuss only. No writes, shell or external actions.' },
            { value: 'build', label: 'Build', icon: Hammer, hint: 'Agent may edit files. Every command still needs host approval.' },
          ]}
        />


        {d.source==='live'&&connection?.provider==='chatgpt'&&inference&&(
          <ChatGPTPlanUsage api={inference} limited={Boolean(runIssue&&isChatGPTUsageLimit(runIssue.code))}/>
        )}

        <button
          type="button"
          className="people-btn"
          aria-label={`${d.participants.length} participants, ${others.length} online. Show people`}
          onClick={() => app.setInspector(true, 'people')}
          data-tip="People"
        >
          {d.participants.slice(0, 3).map((p) => (
            <Avatar key={p.id} name={p.name} initials={p.initials} hue={p.hue} size={24} ring />
          ))}
          {d.participants.length > 3 && <span className="avatar-more">+{d.participants.length - 3}</span>}
        </button>

        {owner && (
          <Button size="sm" icon={UserPlus} onClick={() => app.openOverlay('invite')}>Invite</Button>
        )}

        {d.source === 'live' ? (running ? (
          <Button size="sm" variant="danger" icon={Square} disabled={!owner || dispatching} onClick={() => void execution.stopRun(d.id)}>Stop</Button>
        ) : owner && (
          <Button size="sm" icon={Play} disabled={!selection || !d.capabilities.configure || dispatching} onClick={() => void run()} title={!selection ? 'Connect an AI provider and choose a model first' : !d.capabilities.configure ? 'Only the original host can run this task' : 'Run the next pending instruction with the selected AI connection'}>
            {dispatching ? 'Starting…' : d.status === 'paused' ? 'Resume' : 'Run instruction'}
          </Button>
        )) : running ? (
          <Button size="sm" variant="danger" icon={Square} onClick={() => app.stop(d.id)} disabled={!owner} title={owner ? 'Stop the agent' : 'Only the host can stop the agent'}>
            Stop
          </Button>
        ) : d.status === 'paused' && owner ? (
          <Button size="sm" variant="secondary" icon={Play} onClick={() => app.resume(d.id)}>Resume</Button>
        ) : null}

        {d.capabilities.submit && <TeamChatToggle draftKey={d.id} />}

        <Menu
          label="Session options"
          align="end"
          width={232}
          items={[
            ...(d.source === 'live' && d.capabilities.configure ? [{ id: 'brief', label: 'Write catch-up brief', icon: Sparkles, description: 'Muse Wonder summarizes the session for everyone', onSelect: () => void execution.writeBrief(d.id) }] : []),
            { id: 'rename', label: 'Rename', icon: Pencil, ...(d.source === 'live' ? { description: 'Only you see this name' } : {}), onSelect: () => renamePrompt(d) },
            { id: 'pin', label: summary?.pinned ? 'Unpin' : 'Pin to sidebar', icon: Pin, onSelect: () => app.togglePin(d.id) },
            { id: 'archive', label: 'Archive', icon: Archive, description: 'Hides it for you only', onSelect: () => app.setArchived(d.id, true) },
            { id: 'sep', separator: true },
            {
              id: 'delete', label: 'Delete shared session…', icon: Trash2, danger: true,
              disabled: !d.capabilities.delete ? 'Only the session owner can delete' : running ? 'Stop the agent before deleting' : false,
              onSelect: () => app.openOverlay('delete-session'),
            },
          ]}
          trigger={(t) => <IconButton {...t} icon={MoreHorizontal} label="Session options" />}
        />

        <IconButton
          icon={inspectorOpen ? PanelRightClose : PanelRightOpen}
          label={inspectorOpen ? 'Hide panel' : 'Show panel'}
          shortcut={shortcutText('Mod+Shift+B')}
          active={inspectorOpen}
          onClick={() => app.setInspector(!inspectorOpen)}
        />
      </div>
    </header>
  );
}

function renamePrompt(d: SessionDetail) {
  // Rename happens inline in the sidebar; focus that row's editor via a double click proxy.
  const row = document.querySelector<HTMLButtonElement>('.chat-row.is-active .chat-link');
  row?.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
  if (!row) useApp.getState().toast(`Double-click “${d.title}” in the sidebar to rename it`);
}

function LiveIndicator({ status }: { status: string | undefined }) {
  const label = status === 'live' ? 'Live' : status === 'reconnecting' ? 'Reconnecting…' : status === 'ended' ? 'Disconnected' : 'Connecting…';
  return (
    <span className={cx('live-chip', `is-${status ?? 'connecting'}`)} title={status === 'live' ? 'Receiving updates from your team in real time' : 'Updates will catch up automatically when the connection returns'}>
      <Radio size={11} aria-hidden />
      {label}
    </span>
  );
}

/** The session's branch in the host's project, when the chat works in one. */
function WorkChip({sessionId}:{sessionId:string}) {
  const summary=useWork(s=>s.summary[sessionId]);
  const app=useApp.getState();
  useEffect(()=>{if(summary===undefined)void refreshWork(sessionId);},[sessionId,summary]);
  if(!summary)return null;
  return (
    <button type="button" className="meta-item work-chip" title={`Working on ${summary.branch} from ${summary.baseBranch??'detached'}@${(summary.fromCommit??summary.baseCommit).slice(0,7)}${summary.carried?' with your uncommitted changes':''} in ${summary.projectName}. Review in Changes.`} onClick={()=>app.setInspector(true,'changes')}>
      <GitBranch size={12} aria-hidden />
      <span className="truncate mono">{summary.branch}</span>
    </button>
  );
}

/** Team chat: the next message goes to people, not the agent. One icon, top right. */
function TeamChatToggle({draftKey}:{draftKey:string}) {
  const kind=useApp(s=>s.drafts[draftKey]?.kind??s.prefs.defaultKind);
  const team=kind==='discussion';
  return (
    <IconButton
      icon={MessageCircle}
      label={team?'Team chat on: messages go to your team. Click to talk to the agent':'Team chat: message your team instead of the agent'}
      active={team}
      onClick={()=>{useApp.getState().setDraft(draftKey,{kind:team?'instruction':'discussion'});window.dispatchEvent(new Event('multai:focus-composer'));}}
    />
  );
}
