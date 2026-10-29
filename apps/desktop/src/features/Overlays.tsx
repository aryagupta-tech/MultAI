import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Archive, Bell, Bookmark, Check, CircleCheck, CircleX, Copy, Cpu, FileDiff, Folder, FolderOpen, FolderPlus, Info, Keyboard, Link2,
  ListChecks, Hammer, LogIn, MessageSquare, Monitor, Moon, PanelLeft, PanelRight, Palette, Search, Settings, Shield, SquarePen, Sun, Trash2, Users, X, Stethoscope,
} from 'lucide-react';
import { useApp, type Preferences } from '../model/store';
import { fuzzyFilter } from '../model/fuzzy';
import { getBridge } from '../bridge/client';
import * as live from '../live/controller';
import { Button, Dialog, Kbd, Segmented, Switch, cx, isMac, shortcutText } from '../ui/primitives';

/* ---------------------------------------------------------------- Command palette */

interface Command {
  id: string;
  label: string;
  group: 'Actions' | 'Chats' | 'Projects' | 'Navigate';
  icon: typeof Search;
  hint?: string;
  disabled?: string | false;
  run: () => void;
}

export function CommandPalette() {
  const open = useApp((s) => s.overlay === 'palette');
  const { sessions, projects, activeId, details, inspectorOpen } = useApp();
  const app = useApp.getState();
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const list = useRef<HTMLDivElement>(null);
  const d = activeId ? details[activeId] : undefined;

  useEffect(() => {
    if (open) {
      setQ('');
      setActive(0);
    }
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const owner = d?.role === 'owner';
    const running = d?.status === 'running';
    const cmds: Command[] = [
      { id: 'new-chat', label: 'New chat', group: 'Actions', icon: SquarePen, hint: 'Mod+N', run: () => app.newChat(null) },
      { id: 'new-project', label: 'New project…', group: 'Actions', icon: FolderPlus, hint: 'Mod+Shift+N', run: () => app.openOverlay('new-project') },
      { id: 'join', label: 'Join a session…', group: 'Actions', icon: LogIn, disabled: useApp.getState().dataMode === 'demo' && 'Not available with demo data', run: () => app.openOverlay('join') },
      { id: 'invite', label: 'Invite people…', group: 'Actions', icon: Users, disabled: !d ? 'Open a chat first' : !owner && 'Only the owner can invite', run: () => app.openOverlay('invite') },
      { id: 'plan', label: 'Switch to Plan mode', group: 'Actions', icon: ListChecks, disabled: !d ? 'Open a chat first' : !owner ? 'Only the owner can switch modes' : running ? 'Stop the agent first' : d.mode === 'plan' && 'Already in Plan', run: () => d && app.setMode(d.id, 'plan') },
      { id: 'build', label: 'Switch to Build mode', group: 'Actions', icon: Hammer, disabled: !d ? 'Open a chat first' : !owner ? 'Only the owner can switch modes' : running ? 'Stop the agent first' : d.mode === 'build' && 'Already in Build', run: () => d && app.setMode(d.id, 'build') },
      { id: 'focus', label: 'Focus composer', group: 'Navigate', icon: MessageSquare, hint: '/', run: () => window.dispatchEvent(new Event('multai:focus-composer')) },
      { id: 'sidebar', label: 'Toggle sidebar', group: 'Navigate', icon: PanelLeft, hint: 'Mod+B', run: app.toggleSidebar },
      { id: 'panel', label: inspectorOpen ? 'Hide side panel' : 'Show side panel', group: 'Navigate', icon: PanelRight, hint: 'Mod+Shift+B', disabled: !d && 'Open a chat first', run: () => app.setInspector(!inspectorOpen) },
      { id: 'changes', label: 'Show changes', group: 'Navigate', icon: FileDiff, disabled: !d && 'Open a chat first', run: () => app.setInspector(true, 'changes') },
      { id: 'decisions', label: 'Show decisions', group: 'Navigate', icon: Bookmark, disabled: !d && 'Open a chat first', run: () => app.setInspector(true, 'decisions') },
      { id: 'settings', label: 'Open settings', group: 'Navigate', icon: Settings, hint: 'Mod+,', run: () => app.openOverlay('settings') },
      { id: 'shortcuts', label: 'Keyboard shortcuts', group: 'Navigate', icon: Keyboard, hint: 'Mod+/', run: () => app.openOverlay('shortcuts') },
      { id: 'archived', label: 'Show archived chats', group: 'Navigate', icon: Archive, run: () => app.setShowArchived(true) },
    ];
    for (const s of sessions.filter((x) => !x.archived)) cmds.push({ id: `s-${s.id}`, label: s.title, group: 'Chats', icon: MessageSquare, run: () => app.selectSession(s.id) });
    for (const p of projects) cmds.push({ id: `p-${p.id}`, label: `New chat in ${p.name}`, group: 'Projects', icon: Folder, run: () => app.newChat(p.id) });
    return cmds;
  }, [sessions, projects, d, inspectorOpen, app]);

  const results = useMemo(() => {
    const filtered = fuzzyFilter(commands, q, (c) => c.label);
    return q ? filtered.slice(0, 40) : filtered.filter((c) => c.group !== 'Chats' || sessions.slice(0, 5).some((s) => `s-${s.id}` === c.id));
  }, [commands, q, sessions]);

  useEffect(() => setActive(0), [q]);
  useEffect(() => {
    list.current?.querySelector(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const run = (c: Command | undefined) => {
    if (!c || c.disabled) return;
    app.closeOverlay();
    requestAnimationFrame(c.run);
  };

  const groups = q ? [['Results', results] as const] : (['Actions', 'Chats', 'Projects', 'Navigate'] as const).map((g) => [g, results.filter((c) => c.group === g)] as const).filter(([, v]) => v.length);
  let i = -1;

  return (
    <Dialog open={open} onClose={app.closeOverlay} title="Command menu" hideHeader width={600} className="palette" initialFocus="input">
      <div className="palette-input">
        <Search size={16} aria-hidden />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search actions, chats and projects…"
          aria-label="Search commands"
          role="combobox"
          aria-expanded="true"
          aria-controls="palette-list"
          aria-activedescendant={results[active] ? `cmd-${results[active].id}` : undefined}
          onKeyDown={(e) => {
            if (e.nativeEvent.isComposing) return;
            if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(results.length - 1, a + 1)); }
            if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
            if (e.key === 'Enter') { e.preventDefault(); run(flatOrder(groups)[active]); }
          }}
        />
        <Kbd keys="Esc" />
      </div>
      <div className="palette-list" id="palette-list" role="listbox" ref={list} aria-label="Commands">
        {results.length === 0 && <p className="palette-empty">No results for “{q}”</p>}
        {groups.map(([g, items]) => (
          <div key={g} role="group" aria-label={g}>
            <div className="palette-group">{g}</div>
            {items.map((c) => {
              i++;
              const idx = i;
              const Icon = c.icon;
              return (
                <div
                  key={c.id}
                  id={`cmd-${c.id}`}
                  role="option"
                  aria-selected={idx === active}
                  aria-disabled={Boolean(c.disabled)}
                  data-i={idx}
                  className={cx('palette-item', idx === active && 'is-active', c.disabled && 'is-disabled')}
                  onMouseMove={() => setActive(idx)}
                  onClick={() => run(c)}
                >
                  <Icon size={15} strokeWidth={1.8} aria-hidden />
                  <span className="truncate">{c.label}</span>
                  {c.disabled ? <span className="palette-reason">{c.disabled}</span> : c.hint && <Kbd keys={c.hint} />}
                </div>
              );
            })}
          </div>
        ))}
      </div>
    </Dialog>
  );
}

function flatOrder(groups: readonly (readonly [string, readonly Command[]])[]) {
  return groups.flatMap(([, items]) => items);
}

/* ---------------------------------------------------------------- Settings */

const SECTIONS = [
  { id: 'general', label: 'General', icon: Settings },
  { id: 'appearance', label: 'Appearance', icon: Palette },
  { id: 'models', label: 'Models & accounts', icon: Cpu },
  { id: 'shortcuts', label: 'Keyboard', icon: Keyboard },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'privacy', label: 'Privacy & data', icon: Shield },
  { id: 'about', label: 'About', icon: Info },
] as const;

export function SettingsDialog() {
  const open = useApp((s) => s.overlay === 'settings');
  const section = useApp((s) => s.settingsSection);
  const { prefs, build, account, dataMode, health } = useApp();
  const app = useApp.getState();
  const set = (p: Partial<Preferences>) => app.setPrefs(p);

  return (
    <Dialog open={open} onClose={app.closeOverlay} title="Settings" width={820} className="settings">
      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {SECTIONS.map((s) => {
            const Icon = s.icon;
            return (
              <button key={s.id} type="button" className={cx('settings-nav-item', section === s.id && 'is-active')} aria-current={section === s.id ? 'page' : undefined} onClick={() => app.openOverlay('settings', s.id)}>
                <Icon size={15} strokeWidth={1.8} aria-hidden />{s.label}
              </button>
            );
          })}
        </nav>
        <div className="settings-body">
          {section === 'general' && (
            <>
              <SettingsGroup title="Messages">
                <Row label="Default destination" desc="Where Enter sends a new draft. You can switch per message.">
                  <Segmented label="Default destination" size="sm" value={prefs.defaultKind} onChange={(v) => set({ defaultKind: v })} options={[{ value: 'instruction', label: 'Agent' }, { value: 'discussion', label: 'Team' }]} />
                </Row>
                <Switch label="Expand tool activity by default" description="Show each tool call instead of a one-line summary." checked={prefs.showToolDetails} onChange={(v) => set({ showToolDetails: v })} />
              </SettingsGroup>
              <SettingsGroup title="Window">
                <p className="settings-note">Closing the window keeps a running session alive in the menu bar. Quit stops the agent and any terminals safely.</p>
              </SettingsGroup>
            </>
          )}
          {section === 'appearance' && (
            <>
              <SettingsGroup title="Theme">
                <div className="theme-cards" role="radiogroup" aria-label="Theme">
                  {([['dark', 'Dark', Moon], ['light', 'Light', Sun], ['system', 'System', Monitor]] as const).map(([v, label, Icon]) => (
                    <button key={v} type="button" role="radio" aria-checked={prefs.theme === v} className={cx('theme-card', `theme-${v}`, prefs.theme === v && 'is-selected')} onClick={() => set({ theme: v })}>
                      <span className="theme-preview" aria-hidden><span /><span /><span /></span>
                      <span className="theme-label"><Icon size={13} aria-hidden />{label}</span>
                    </button>
                  ))}
                </div>
              </SettingsGroup>
              <SettingsGroup title="Layout">
                <Row label="Density" desc="Compact fits more rows in the sidebar and panels.">
                  <Segmented label="Density" size="sm" value={prefs.density} onChange={(v) => set({ density: v })} options={[{ value: 'comfortable', label: 'Comfortable' }, { value: 'compact', label: 'Compact' }]} />
                </Row>
                <Row label="Text size">
                  <Segmented label="Text size" size="sm" value={prefs.textSize} onChange={(v) => set({ textSize: v })} options={[{ value: 'small', label: 'Small' }, { value: 'default', label: 'Default' }, { value: 'large', label: 'Large' }]} />
                </Row>
                <Switch label="Reduce motion" description="Turns off animations. The system setting is respected automatically." checked={prefs.motion === 'reduce'} onChange={(v) => set({ motion: v ? 'reduce' : 'system' })} />
              </SettingsGroup>
            </>
          )}
          {section === 'models' && (
            <>
              <SettingsGroup title="Connected AI">
                {dataMode === 'demo' ? (
                  <div className="connection-card">
                    <span className="conn-icon"><Cpu size={16} aria-hidden /></span>
                    <div className="conn-main"><span className="conn-name">Demo connection</span><span className="conn-sub">App coding loop · no provider is contacted</span></div>
                    <span className="pill pill-approved">Demo</span>
                  </div>
                ) : (
                  <p className="settings-note">No AI connection on this computer yet, and this collaboration service has inference disabled. You can still create sessions, invite people and discuss together; teammates never need their own key.</p>
                )}
                <Button size="sm" disabled title="Provider connections arrive with the local runtime">Connect a provider</Button>
              </SettingsGroup>
              <SettingsGroup title="How payment works">
                <p className="settings-note">Your MultAI account identifies you to the team. The host’s selected connection decides which provider is used and who pays. Joining someone else’s session never uses your key.</p>
              </SettingsGroup>
            </>
          )}
          {section === 'shortcuts' && <ShortcutList />}
          {section === 'notifications' && (
            <SettingsGroup title="Notifications">
              <p className="settings-note">Notifications are off. When enabled, MultAI will ask your operating system for permission and only notify for approvals and mentions while the window is in the background.</p>
              <Button size="sm" disabled title="Native notifications aren’t wired up yet">Turn on notifications</Button>
            </SettingsGroup>
          )}
          {section === 'privacy' && (
            <SettingsGroup title="What leaves this computer">
              <ul className="privacy-list">
                <li><CircleCheck size={14} className="tone-ok" aria-hidden /> Shared conversation, decisions, and the diffs you review are synced to your team.</li>
                <li><CircleCheck size={14} className="tone-ok" aria-hidden /> Relevant context goes to the AI provider the host selected.</li>
                <li><CircleX size={14} className="tone-danger" aria-hidden /> Your project folders are never mirrored, and teammates can’t read files or run commands on this computer.</li>
                <li><CircleX size={14} className="tone-danger" aria-hidden /> Drafts stay on this computer until you send them.</li>
              </ul>
              <Button size="sm" icon={Stethoscope} disabled title="Diagnostics export arrives with the local runtime">Export diagnostics…</Button>
            </SettingsGroup>
          )}
          {section === 'about' && (
            <SettingsGroup title="This build">
              <dl className="about-list">
                <div><dt>Version</dt><dd className="mono">{build?.version ?? 'unknown'}</dd></div>
                <div><dt>Source</dt><dd className="mono">{build ? `${build.commit}${build.dirty ? ' (uncommitted changes)' : ''}` : 'unknown'}</dd></div>
                <div><dt>Built</dt><dd>{build ? new Date(build.builtAt).toLocaleString() : 'unknown'}</dd></div>
                <div><dt>Channel</dt><dd>{build?.channel ?? 'unknown'}{dataMode === 'demo' && ' · demo data'}</dd></div>
                <div><dt>Account</dt><dd>{account ? account.email || account.name : 'Signed out'}</dd></div>
                {dataMode === 'live' && <div><dt>Service</dt><dd className="mono">{build?.serviceOrigin ?? 'unknown'}{health ? ` · ${health.reachable ? `database ${health.database}` : 'unreachable'}` : ''}</dd></div>}
                {dataMode === 'live' && <div><dt>Credentials</dt><dd>{useApp.getState().auth?.status === 'signed-in' && (useApp.getState().auth as { persisted?: boolean }).persisted ? 'Encrypted with the system keychain' : 'Kept in memory only'}</dd></div>}
              </dl>
            </SettingsGroup>
          )}
        </div>
      </div>
    </Dialog>
  );
}

function SettingsGroup({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="settings-group">
      <h3 className="settings-group-title">{title}</h3>
      <div className="settings-group-body">{children}</div>
    </section>
  );
}

function Row({ label, desc, children }: { label: string; desc?: string; children: React.ReactNode }) {
  return (
    <div className="settings-row">
      <div><div className="switch-label">{label}</div>{desc && <p className="switch-desc">{desc}</p>}</div>
      {children}
    </div>
  );
}

export const SHORTCUTS: [string, string][] = [
  ['Mod+K', 'Command menu'],
  ['Mod+N', 'New chat'],
  ['Mod+Shift+N', 'New project'],
  ['Mod+B', 'Toggle sidebar'],
  ['Mod+Shift+B', 'Toggle side panel'],
  ['Mod+,', 'Settings'],
  ['Mod+/', 'Keyboard shortcuts'],
  ['/', 'Focus composer'],
  ['Enter', 'Send to the selected destination'],
  ['Shift+Enter', 'New line'],
  ['Mod+Enter', 'Send to the other destination'],
  ['Alt+↑', 'Previous chat'],
  ['Alt+↓', 'Next chat'],
];

function ShortcutList() {
  return (
    <dl className="shortcut-list">
      {SHORTCUTS.map(([k, label]) => (
        <div key={k}><dt>{label}</dt><dd><Kbd keys={k} /></dd></div>
      ))}
    </dl>
  );
}

export function ShortcutsDialog() {
  const open = useApp((s) => s.overlay === 'shortcuts');
  return (
    <Dialog open={open} onClose={useApp.getState().closeOverlay} title="Keyboard shortcuts" description={isMac ? undefined : 'Ctrl is used in place of ⌘.'} width={440}>
      <div className="dialog-body"><ShortcutList /></div>
    </Dialog>
  );
}

/* ---------------------------------------------------------------- Invite */

export function InviteDialog() {
  const open = useApp((s) => s.overlay === 'invite');
  const { activeId, details, dataMode } = useApp();
  const app = useApp.getState();
  const d = activeId ? details[activeId] : undefined;
  const isLive = d?.source === 'live';
  const [role, setRole] = useState<'collaborator' | 'viewer'>('collaborator');
  const [expiry, setExpiry] = useState<'1h' | '24h' | '7d'>('24h');
  const [invite, setInvite] = useState<{ code: string; link: string; expiresAt?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState<'link' | 'code' | null>(null);

  useEffect(() => {
    if (open) {
      setInvite(null);
      setCopied(null);
    }
  }, [open]);

  const create = async () => {
    if (!d) return;
    if (dataMode === 'demo') {
      const code = `demo-${Math.random().toString(36).slice(2, 10)}`;
      setInvite({ code, link: `https://collab.example.test/join/${code}` });
      return;
    }
    setBusy(true);
    const seconds = expiry === '1h' ? 3600 : 86_400;
    const created = await live.createInvitation(d.id, seconds);
    setBusy(false);
    if (created) setInvite({ code: created.token, link: `multai-dev://join?token=${created.token}`, expiresAt: created.expiresAt });
  };

  const copy = (what: 'link' | 'code', value: string) => {
    void navigator.clipboard?.writeText(value).catch(() => undefined);
    setCopied(what);
  };

  return (
    <Dialog open={open} onClose={app.closeOverlay} title="Invite to this session" description={d?.title} width={520}>
      <div className="dialog-body">
        {!isLive && (
          <div className="field">
            <span className="field-label">They’ll join as</span>
            <div className="role-cards" role="radiogroup" aria-label="Role">
              {([['collaborator', 'Collaborator', 'Can send instructions and discussion, and save decisions.'], ['viewer', 'Viewer', 'Can read everything but can’t send.']] as const).map(([v, label, desc]) => (
                <button key={v} type="button" role="radio" aria-checked={role === v} className={cx('role-card', role === v && 'is-selected')} onClick={() => { setRole(v); setInvite(null); }}>
                  <span className="role-card-title">{label}{role === v && <Check size={14} aria-hidden />}</span>
                  <span className="role-card-desc">{desc}</span>
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="settings-row">
          <div><div className="switch-label">Link expires</div>{isLive && <p className="switch-desc">You’ll choose collaborator or viewer when you admit each person.</p>}</div>
          <Segmented
            label="Link expiry"
            size="sm"
            value={expiry}
            onChange={(v) => { setExpiry(v); setInvite(null); }}
            options={isLive
              ? [{ value: '1h', label: '1 hour' }, { value: '24h', label: '1 day' }]
              : [{ value: '1h', label: '1 hour' }, { value: '24h', label: '1 day' }, { value: '7d', label: '7 days' }]}
          />
        </div>

        {invite ? (
          <div className="invite-result">
            <div className="invite-link">
              <Link2 size={14} aria-hidden className="tone-muted" />
              <input readOnly value={invite.link} aria-label="Invitation link" onFocus={(e) => e.currentTarget.select()} />
              <Button size="sm" variant={copied === 'link' ? 'secondary' : 'primary'} icon={copied === 'link' ? Check : Copy} onClick={() => copy('link', invite.link)}>{copied === 'link' ? 'Copied' : 'Copy link'}</Button>
            </div>
            {isLive && (
              <p className="invite-code">
                Or share the code: <code>{invite.code.slice(0, 10)}…</code>
                <button type="button" className="link-btn" onClick={() => copy('code', invite.code)}>{copied === 'code' ? 'Copied' : 'Copy code'}</button>
              </p>
            )}
            {invite.expiresAt && <p className="field-help">Expires {new Date(invite.expiresAt).toLocaleString()}. Anyone with it can ask to join; nobody gets in until you admit them.</p>}
          </div>
        ) : (
          <Button variant="primary" icon={Link2} onClick={() => void create()} className="btn-block" disabled={busy}>
            {busy ? 'Creating…' : 'Create invitation link'}
          </Button>
        )}

        <p className="callout">
          <Shield size={14} aria-hidden />
          <span>Having the link isn’t enough. You’ll admit each person before they see anything. Teammates never get access to your files or shell.</span>
        </p>
      </div>
    </Dialog>
  );
}

/* ---------------------------------------------------------------- Join */

export function JoinDialog() {
  const open = useApp((s) => s.overlay === 'join');
  const prompt = useApp((s) => s.joinPrompt);
  const signedIn = useApp((s) => Boolean(s.account));
  const app = useApp.getState();
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<'pending' | 'admitted' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setInput(prompt ? `multai-dev://join?token=${prompt}` : '');
      setResult(null);
      setError(null);
    }
  }, [open, prompt]);

  const close = () => {
    useApp.setState({ joinPrompt: null });
    app.closeOverlay();
  };

  const submit = async () => {
    const token = live.parseInvite(input);
    if (!token) {
      setError('That doesn’t look like a MultAI invitation link or code.');
      return;
    }
    setError(null);
    setBusy(true);
    const status = await live.join(token);
    setBusy(false);
    if (status === 'admitted') close();
    else if (status) setResult(status);
  };

  return (
    <Dialog open={open} onClose={close} title="Join a session" description="Paste the invitation link or code a teammate sent you." width={480}>
      <form className="dialog-body" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
        {result === 'pending' ? (
          <>
            <p className="callout callout-ok"><Check size={14} aria-hidden /><span>Request sent. The session owner needs to admit you. It’ll appear in your sidebar once they do.</span></p>
            <div className="form-actions"><Button variant="primary" onClick={close}>Done</Button></div>
          </>
        ) : !signedIn ? (
          <>
            <p className="dialog-text">Sign in first, then open the invitation again.</p>
            <div className="form-actions"><Button variant="primary" onClick={close}>OK</Button></div>
          </>
        ) : (
          <>
            <label className="field">
              <span className="field-label">Invitation</span>
              <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="multai-dev://join?token=…" autoFocus spellCheck={false} autoComplete="off" />
              {error && <span className="field-error" role="alert">{error}</span>}
            </label>
            <p className="field-help">Joining only sends a request. You’ll see the conversation after the owner admits you.</p>
            <div className="form-actions">
              <Button variant="ghost" onClick={close}>Cancel</Button>
              <Button variant="primary" type="submit" disabled={busy || !input.trim()}>{busy ? 'Sending…' : 'Ask to join'}</Button>
            </div>
          </>
        )}
      </form>
    </Dialog>
  );
}

/* ---------------------------------------------------------------- New project */

export function NewProjectDialog() {
  const open = useApp((s) => s.overlay === 'new-project');
  const app = useApp.getState();
  const [name, setName] = useState('');
  const [folder, setFolder] = useState<{ name: string; folderHint: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (open) {
      setName('');
      setFolder(null);
      setError(null);
    }
  }, [open]);

  const pick = async () => {
    setError(null);
    const bridge = getBridge();
    if (!bridge) {
      setError('Folder picking needs the desktop app. It isn’t available in a browser preview.');
      return;
    }
    const result = await bridge.pickProjectFolder();
    if (!result.canceled) {
      setFolder({ name: result.name, folderHint: result.folderHint });
      if (!name) setName(result.name);
    }
  };

  return (
    <Dialog open={open} onClose={app.closeOverlay} title="New project" description="Saving registers the folder on this computer. Nothing in the folder changes and no agent starts." width={480}>
      <form className="dialog-body" onSubmit={(e) => {
        e.preventDefault();
        if (name.trim() && folder) app.addProject({ name: name.trim(), folderHint: folder.folderHint });
      }}>
        <label className="field">
          <span className="field-label">Name</span>
          <input value={name} maxLength={80} onChange={(e) => setName(e.target.value)} placeholder="my-app" autoFocus />
        </label>
        <div className="field">
          <span className="field-label">Folder</span>
          <button type="button" className={cx('folder-pick', folder && 'has-value')} onClick={() => void pick()}>
            {folder ? <FolderOpen size={16} aria-hidden /> : <FolderPlus size={16} aria-hidden />}
            <span className="truncate">{folder ? folder.folderHint : 'Choose a folder…'}</span>
            {folder && <span className="link-btn">Change</span>}
          </button>
          <span className="field-help">The full path stays private to this computer and account.</span>
          {error && <span className="field-error" role="alert">{error}</span>}
        </div>
        <div className="form-actions">
          <Button variant="ghost" onClick={app.closeOverlay}>Cancel</Button>
          <Button variant="primary" type="submit" disabled={!name.trim() || !folder}>Save project</Button>
        </div>
      </form>
    </Dialog>
  );
}

/* ---------------------------------------------------------------- Delete session */

export function DeleteSessionDialog() {
  const open = useApp((s) => s.overlay === 'delete-session');
  const { activeId, details } = useApp();
  const app = useApp.getState();
  const d = activeId ? details[activeId] : undefined;
  const [confirm, setConfirm] = useState('');
  useEffect(() => { if (open) setConfirm(''); }, [open]);
  if (!d) return null;
  const word = 'delete';
  return (
    <Dialog open={open} onClose={app.closeOverlay} title="Delete this shared session?" width={460}>
      <div className="dialog-body">
        <p className="dialog-text">This permanently removes <strong>{d.title}</strong> for everyone: conversation, decisions, invitations and approvals. It can’t be undone.</p>
        <p className="callout callout-ok"><Folder size={14} aria-hidden /><span>Your project folder and this chat’s worktree files stay on disk. Use Archive instead if you just want it out of your sidebar.</span></p>
        <label className="field">
          <span className="field-label">Type <strong>{word}</strong> to confirm</span>
          <input value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="off" spellCheck={false} />
        </label>
        <div className="form-actions">
          <Button variant="ghost" onClick={app.closeOverlay}>Cancel</Button>
          <Button variant="danger" icon={Trash2} disabled={confirm.trim().toLowerCase() !== word} onClick={() => app.deleteSession(d.id)}>Delete for everyone</Button>
        </div>
      </div>
    </Dialog>
  );
}

/* ---------------------------------------------------------------- Toasts */

export function Toasts() {
  const toasts = useApp((s) => s.toasts);
  const app = useApp.getState();
  return (
    <div className="toasts" role="region" aria-label="Notifications" aria-live="polite">
      {toasts.map((t) => (
        <div key={t.id} className={cx('toast', `is-${t.tone}`)}>
          {t.tone === 'success' ? <CircleCheck size={15} aria-hidden /> : t.tone === 'error' ? <CircleX size={15} aria-hidden /> : <Info size={15} aria-hidden />}
          <span>{t.text}</span>
          <button type="button" aria-label="Dismiss" onClick={() => app.dismissToast(t.id)}><X size={13} /></button>
        </div>
      ))}
    </div>
  );
}

export { shortcutText };
