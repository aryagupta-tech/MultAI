import { useEffect } from 'react';
import { useApp } from './model/store';
import { getBridge, loadBuildInfo } from './bridge/client';
import * as live from './live/controller';
import { Sidebar } from './features/Sidebar';
import { SessionHeader } from './features/SessionHeader';
import { Conversation } from './features/Conversation';
import { Composer } from './features/Composer';
import { Inspector } from './features/Inspector';
import { TeamPanel, useTeam } from './features/TeamPanel';
import { SidebarResizer } from './features/SidebarResizer';
import { AssistDialogs } from './features/AssistDialogs';
import { LockedActions } from './features/LockedActions';
import { QueuedMessages } from './features/QueuedMessages';
import { NewChat } from './features/NewChat';
import { Welcome } from './features/Welcome';
import {
  CommandPalette, DeleteSessionDialog, InviteDialog, JoinDialog, NewProjectDialog, SettingsDialog, ShortcutsDialog, Toasts,
} from './features/Overlays';
import { cx } from './ui/primitives';
import { LogoMark } from './ui/Logo';

async function loadDemo() {
  // Compile-time guard: production builds drop the fixtures chunk entirely.
  if (import.meta.env.MODE !== 'demo') return;
  const demo = await import('./model/demo');
  useApp.getState().loadDemo({
    account: demo.demoAccount,
    sessions: demo.demoSessions,
    projects: demo.demoProjects,
    details: { 's-rate': demo.demoSessionDetail() },
  });
}

function usePreferencesOnRoot() {
  const prefs = useApp((s) => s.prefs);
  useEffect(() => {
    const root = document.documentElement;
    const media = window.matchMedia('(prefers-color-scheme: light)');
    const apply = () => {
      root.dataset.theme = prefs.theme === 'system' ? (media.matches ? 'light' : 'dark') : prefs.theme;
    };
    apply();
    root.dataset.density = prefs.density;
    root.dataset.text = prefs.textSize;
    root.dataset.motion = prefs.motion;
    media.addEventListener('change', apply);
    return () => media.removeEventListener('change', apply);
  }, [prefs]);
}

function useGlobalShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.isComposing || e.keyCode === 229 || e.defaultPrevented) return;
      const s = useApp.getState();
      if (!s.account) return;
      const mod = e.metaKey || e.ctrlKey;
      const key = e.key.toLowerCase();
      const typing = e.target instanceof HTMLElement && (e.target.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName));

      const take = (fn: () => void) => {
        e.preventDefault();
        fn();
      };

      if (mod && key === 'k') return take(() => (s.overlay === 'palette' ? s.closeOverlay() : s.openOverlay('palette')));
      if (s.overlay) return; // Dialogs own the keyboard while open.
      if (mod && e.shiftKey && key === 'n') return take(() => s.openOverlay('new-project'));
      if (mod && !e.shiftKey && key === 'n') return take(() => s.newChat(null));
      if (mod && e.shiftKey && key === 'b') return take(() => s.activeId && s.setInspector(!s.inspectorOpen));
      if (mod && !e.shiftKey && key === 'b') return take(s.toggleSidebar);
      if (mod && key === ',') return take(() => s.openOverlay('settings', 'general'));
      if (mod && key === '/') return take(() => s.openOverlay('shortcuts'));
      if (!mod && !typing && e.key === '/') return take(() => window.dispatchEvent(new Event('multai:focus-composer')));
      if (e.altKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown') && !typing) {
        const list = s.sessions.filter((x) => !x.archived).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        const i = list.findIndex((x) => x.id === s.activeId);
        const next = list[e.key === 'ArrowDown' ? i + 1 : Math.max(0, i - 1)];
        if (next) take(() => s.selectSession(next.id));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

export function App() {
  const { account, activeId, details, sidebarOpen, inspectorOpen, dataMode, build, onboarding, loading, auth } = useApp();
  const teamOpen = useTeam((s) => s.open);
  const d = activeId ? details[activeId] ?? null : null;

  usePreferencesOnRoot();
  useGlobalShortcuts();

  useEffect(() => {
    void loadBuildInfo().then(useApp.getState().setBuild);
    if (dataMode === 'demo') void loadDemo();
    else if (getBridge()) void live.start();
  }, [dataMode]);

  // Until the saved sign-in has been checked, neither the sign-in page nor the app is the right
  // screen: showing sign-in first flashes it at people who are already signed in.
  if (dataMode === 'live' && getBridge() && !auth) {
    return (
      <div className="launch" role="status" aria-label="Opening MultAI">
        <LogoMark size={56} />
      </div>
    );
  }

  if (!account || onboarding !== 'done') {
    return (
      <>
        <Welcome onDemoSignIn={() => void loadDemo()} />
        <JoinDialog />
        <Toasts />
      </>
    );
  }

  return (
    <div
      className={cx('app', !sidebarOpen && 'sidebar-closed', !((inspectorOpen || teamOpen) && d) && 'inspector-closed', build?.platform && `platform-${build.platform}`)}
    >
      {sidebarOpen && <Sidebar />}
      {sidebarOpen && <SidebarResizer />}
      <main className="main" aria-label={d ? d.title : 'New chat'}>
        <SessionHeader d={d} />
        {activeId && !d ? (
          <div className="session-loading" role="status">{loading[activeId] ? 'Loading session…' : 'This session isn’t available.'}</div>
        ) : d ? (
          <>
            <Conversation d={d} />
            <div className="composer-dock">
              {d.source === 'live' && d.capabilities.configure && <LockedActions sessionId={d.id} />}
              {d.source === 'live' && <QueuedMessages d={d} />}
              <Composer d={d} draftKey={d.id} />
            </div>
          </>
        ) : (
          <NewChat />
        )}
      </main>
      {d && inspectorOpen && <Inspector d={d} />}
      {d && teamOpen && !inspectorOpen && <TeamPanel d={d} />}
      <AssistDialogs />

      <CommandPalette />
      <SettingsDialog />
      <ShortcutsDialog />
      <InviteDialog />
      <NewProjectDialog />
      <DeleteSessionDialog />
      <JoinDialog />
      <Toasts />
    </div>
  );
}
