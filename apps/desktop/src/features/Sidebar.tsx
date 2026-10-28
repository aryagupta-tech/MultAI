import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  Archive, ArchiveRestore, ChevronRight, Folder, FolderPlus, MoreHorizontal, PanelLeftClose, Pencil, Pin, PinOff, Plus,
  Search, Settings, ShieldAlert, SquarePen, X, Keyboard, LogOut, Command,
} from 'lucide-react';
import { useApp } from '../model/store';
import { recencyBucket } from '../model/format';
import { fuzzyScore } from '../model/fuzzy';
import type { SessionSummary } from '../model/types';
import { Avatar, IconButton, Kbd, Menu, cx, shortcutText } from '../ui/primitives';
import { LogoMark } from '../ui/Logo';

export function Sidebar() {
  const { sessions, projects, activeId, showArchived, account, dataMode, build } = useApp();
  const app = useApp.getState();
  const [query, setQuery] = useState('');
  const searchRef = useRef<HTMLInputElement>(null);

  const visible = useMemo(
    () => sessions.filter((s) => s.archived === showArchived && (!query || fuzzyScore(query, s.title) !== null)),
    [sessions, showArchived, query],
  );
  const pinned = visible.filter((s) => s.pinned);
  const loose = visible.filter((s) => !s.pinned && !s.projectId);
  const grouped = useMemo(() => {
    const map = new Map<string, SessionSummary[]>();
    for (const s of [...loose].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))) {
      const k = recencyBucket(s.updatedAt);
      map.set(k, [...(map.get(k) ?? []), s]);
    }
    return [...map.entries()];
  }, [loose]);
  const archivedCount = sessions.filter((s) => s.archived).length;
  const mac = build?.platform === 'darwin';

  return (
    <nav className="sidebar" aria-label="Chats and projects">
      <div className={cx('sidebar-top drag', mac && 'has-traffic-lights')}>
        <span className="sidebar-brand no-drag"><LogoMark size={20} /><span>MultAI</span></span>
        <span className="spacer" />
        <IconButton className="no-drag" icon={PanelLeftClose} label="Hide sidebar" shortcut={shortcutText('Mod+B')} onClick={app.toggleSidebar} />
      </div>

      <div className="sidebar-actions">
        <button type="button" className="new-chat-btn" onClick={() => app.newChat(null)}>
          <SquarePen size={15} strokeWidth={1.8} aria-hidden />
          <span>New chat</span>
          <Kbd keys="Mod+N" />
        </button>
        <div className="sidebar-search">
          <Search size={14} aria-hidden />
          <input
            ref={searchRef}
            type="search"
            placeholder="Search chats"
            aria-label="Search chats"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => e.key === 'Escape' && setQuery('')}
          />
          {query ? (
            <button type="button" className="search-clear" aria-label="Clear search" onClick={() => setQuery('')}><X size={12} /></button>
          ) : (
            <button type="button" className="search-cmd" aria-label="Open command menu" onClick={() => app.openOverlay('palette')}><Kbd keys="Mod+K" /></button>
          )}
        </div>
      </div>

      <div className="sidebar-scroll">
        {showArchived && (
          <div className="archive-banner">
            <Archive size={14} aria-hidden />
            <span>Archived chats</span>
            <button type="button" className="link-btn" onClick={() => app.setShowArchived(false)}>Done</button>
          </div>
        )}

        {pinned.length > 0 && (
          <Section title="Pinned">
            {pinned.map((s) => <ChatRow key={s.id} s={s} active={s.id === activeId} />)}
          </Section>
        )}

        {!showArchived && (
          <Section
            title="Projects"
            action={<IconButton icon={FolderPlus} size="sm" label="New project" shortcut={shortcutText('Mod+Shift+N')} onClick={() => app.openOverlay('new-project')} />}
          >
            {projects.length === 0 && (
              <button type="button" className="sidebar-hint" onClick={() => app.openOverlay('new-project')}>
                <FolderPlus size={14} aria-hidden /> Add a project folder
              </button>
            )}
            {projects.map((p) => {
              const chats = visible.filter((s) => s.projectId === p.id && !s.pinned);
              if (query && chats.length === 0 && fuzzyScore(query, p.name) === null) return null;
              return (
                <div key={p.id} className="project">
                  <div className="project-row">
                    <button
                      type="button"
                      className="project-toggle"
                      aria-expanded={p.expanded}
                      onClick={() => app.toggleProject(p.id)}
                      title={p.folderHint}
                    >
                      <ChevronRight size={13} className={cx('chev', p.expanded && 'is-open')} aria-hidden />
                      <Folder size={14} strokeWidth={1.8} aria-hidden />
                      <span className="truncate">{p.name}</span>
                    </button>
                    <IconButton className="row-action" icon={Plus} size="sm" label={`New chat in ${p.name}`} onClick={() => app.newChat(p.id)} />
                  </div>
                  {p.expanded && (
                    <div className="project-chats">
                      {chats.length === 0 ? (
                        <p className="project-empty">No chats yet</p>
                      ) : (
                        chats.map((s) => <ChatRow key={s.id} s={s} active={s.id === activeId} nested />)
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </Section>
        )}

        {grouped.length > 0 && !showArchived && <div className="sidebar-label sidebar-label-major">Chats</div>}
        {grouped.map(([bucket, items]) => (
          <Section key={bucket} title={showArchived ? '' : bucket} minor>
            {items.map((s) => <ChatRow key={s.id} s={s} active={s.id === activeId} />)}
          </Section>
        ))}

        {visible.length === 0 && query && <p className="sidebar-empty">No chats match “{query}”</p>}
        {showArchived && visible.length === 0 && !query && <p className="sidebar-empty">Nothing archived</p>}
      </div>

      <div className="sidebar-footer">
        {dataMode === 'demo' && (
          <div className="demo-badge" role="note">
            <ShieldAlert size={13} aria-hidden />
            <span><strong>Demo data</strong> · not a live session</span>
          </div>
        )}
        {account && (
          <Menu
            label="Account"
            side="top"
            width={248}
            items={[
              { id: 'acct', separator: true, label: account.email },
              { id: 'settings', label: 'Settings', icon: Settings, hint: shortcutText('Mod+,'), onSelect: () => app.openOverlay('settings', 'general') },
              { id: 'shortcuts', label: 'Keyboard shortcuts', icon: Keyboard, hint: shortcutText('Mod+/'), onSelect: () => app.openOverlay('shortcuts') },
              { id: 'palette', label: 'Command menu', icon: Command, hint: shortcutText('Mod+K'), onSelect: () => app.openOverlay('palette') },
              { id: 'archived', label: showArchived ? 'Hide archived' : `Archived chats${archivedCount ? ` (${archivedCount})` : ''}`, icon: Archive, onSelect: () => app.setShowArchived(!showArchived) },
              { id: 'sep', separator: true },
              { id: 'signout', label: 'Sign out', icon: LogOut, onSelect: app.signOut },
            ]}
            trigger={(t) => (
              <button type="button" className="account-btn" {...t}>
                <Avatar name={account.name} initials={account.initials} hue={account.hue} size={26} />
                <span className="account-text">
                  <span className="truncate">{account.name}</span>
                  <span className="account-sub truncate">{account.workspace} workspace</span>
                </span>
                <Settings size={15} className="account-gear" aria-hidden />
              </button>
            )}
          />
        )}
      </div>
    </nav>
  );
}

function Section({ title, children, action, minor }: { title: string; children: React.ReactNode; action?: React.ReactNode; minor?: boolean }) {
  return (
    <section className="sidebar-section">
      {(title || action) && (
        <div className={cx('sidebar-label', minor && 'is-minor')}>
          <span>{title}</span>
          {action}
        </div>
      )}
      <div role="list">{children}</div>
    </section>
  );
}

function ChatRow({ s, active, nested }: { s: SessionSummary; active: boolean; nested?: boolean }) {
  const app = useApp.getState();
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(s.title);

  const commit = () => {
    app.rename(s.id, title);
    setEditing(false);
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') {
      setTitle(s.title);
      setEditing(false);
    }
  };

  return (
    <div role="listitem" className={cx('chat-row', active && 'is-active', nested && 'is-nested', s.unread && 'is-unread')}>
      {editing ? (
        <input
          className="chat-rename"
          aria-label="Chat name"
          autoFocus
          value={title}
          maxLength={120}
          onChange={(e) => setTitle(e.target.value)}
          onBlur={commit}
          onKeyDown={onKey}
          onFocus={(e) => e.currentTarget.select()}
        />
      ) : (
        <button
          type="button"
          className="chat-link"
          aria-current={active ? 'page' : undefined}
          onClick={() => app.selectSession(s.id)}
          onDoubleClick={() => setEditing(true)}
        >
          <StatusDot status={s.status} approvals={s.pendingApprovals} />
          <span className="truncate">{s.title}</span>
          {s.pendingApprovals > 0 && <span className="row-badge" aria-label={`${s.pendingApprovals} approval waiting`}>{s.pendingApprovals}</span>}
          {s.unread && <span className="unread-dot" aria-label="Unread" />}
        </button>
      )}
      {!editing && (
        <Menu
          label={`Actions for ${s.title}`}
          align="end"
          width={200}
          items={[
            { id: 'pin', label: s.pinned ? 'Unpin' : 'Pin', icon: s.pinned ? PinOff : Pin, onSelect: () => app.togglePin(s.id), disabled: s.archived && 'Restore the chat to pin it' },
            { id: 'rename', label: 'Rename', icon: Pencil, onSelect: () => setEditing(true) },
            s.archived
              ? { id: 'restore', label: 'Restore', icon: ArchiveRestore, onSelect: () => app.setArchived(s.id, false) }
              : { id: 'archive', label: 'Archive', icon: Archive, description: 'Hides it for you only', onSelect: () => app.setArchived(s.id, true) },
          ]}
          trigger={(t) => <IconButton {...t} className="row-action" icon={MoreHorizontal} size="sm" label="Chat actions" />}
        />
      )}
    </div>
  );
}

export function StatusDot({ status, approvals }: { status: SessionSummary['status']; approvals?: number }) {
  if (approvals) return <span className="status-dot is-attention" aria-hidden />;
  return <span className={cx('status-dot', `is-${status}`)} aria-hidden />;
}
