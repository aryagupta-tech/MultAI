import {
  Archive, ChevronDown, Cpu, Hammer, Laptop, ListChecks, MoreHorizontal, PanelLeftOpen, PanelRightClose, PanelRightOpen,
  Pencil, Pin, Play, Square, SquarePen, Trash2, UserPlus, GitBranch, Brain,
} from 'lucide-react';
import { useApp } from '../model/store';
import type { SessionDetail } from '../model/types';
import { Avatar, Button, IconButton, Menu, Segmented, cx, shortcutText } from '../ui/primitives';

export function SessionHeader({ d }: { d: SessionDetail | null }) {
  const { sidebarOpen, inspectorOpen, build, sessions } = useApp();
  const app = useApp.getState();
  const mac = build?.platform === 'darwin';
  const summary = d ? sessions.find((s) => s.id === d.id) : undefined;

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
      </header>
    );
  }

  const running = d.status === 'running';
  const owner = d.role === 'owner';
  const modeLock = !owner ? 'Only the session owner can switch modes' : running ? 'Stop the agent to switch modes' : false;
  const statusLabel = running ? 'Working' : d.status === 'paused' ? 'Paused' : 'Ready';
  const others = d.participants.filter((p) => p.presence !== 'offline');

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
          <span className="meta-item" title="Where the agent runs. Files never leave this computer.">
            <Laptop size={12} aria-hidden />
            <span className="truncate">{d.hostName}</span>
          </span>
          <span className="meta-item meta-hide-sm" title={`Worktree ${d.worktree}`}>
            <GitBranch size={12} aria-hidden />
            <span className="truncate">{d.baseline}</span>
          </span>
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

        <Menu
          label="Model and reasoning"
          align="end"
          width={260}
          items={[
            { id: 'h-model', separator: true, label: d.model.engine },
            { id: d.model.id, label: d.model.label, icon: Cpu, checked: true, description: 'Connected on this host' },
            { id: 'h-reason', separator: true, label: 'Reasoning' },
            ...d.model.reasoning.map((r) => ({
              id: `r-${r}`, label: r, checked: d.reasoning === r,
              disabled: (!d.capabilities.configure ? 'Only the host can change this' : running ? 'Stop the agent first' : false) as string | false,
              onSelect: () => app.setReasoning(d.id, r),
            })),
          ]}
          trigger={(t) => (
            <button type="button" className="model-btn" {...t}>
              <Brain size={14} strokeWidth={1.8} aria-hidden />
              <span className="model-name">{d.model.label}</span>
              <span className="model-reason">{d.reasoning}</span>
              <ChevronDown size={13} aria-hidden />
            </button>
          )}
        />

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

        {running ? (
          <Button size="sm" variant="danger" icon={Square} onClick={() => app.stop(d.id)} disabled={!owner} title={owner ? 'Stop the agent' : 'Only the host can stop the agent'}>
            Stop
          </Button>
        ) : d.status === 'paused' && owner ? (
          <Button size="sm" variant="secondary" icon={Play} onClick={() => app.resume(d.id)}>Resume</Button>
        ) : null}

        <Menu
          label="Session options"
          align="end"
          width={232}
          items={[
            { id: 'rename', label: 'Rename', icon: Pencil, onSelect: () => renamePrompt(d) },
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
