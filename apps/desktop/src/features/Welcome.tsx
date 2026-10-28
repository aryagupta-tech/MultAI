import { useState } from 'react';
import { ArrowRight, Check, Cpu, KeyRound, Laptop, ShieldCheck, Users, WifiOff, CircleX } from 'lucide-react';
import { useApp } from '../model/store';
import { Button, Spinner, cx } from '../ui/primitives';
import { LogoMark } from '../ui/Logo';

export function Welcome({ onDemoSignIn }: { onDemoSignIn: () => void }) {
  const { onboarding, dataMode, build } = useApp();
  const app = useApp.getState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState<'account' | 'api' | 'later'>('later');

  const signIn = () => {
    setError(null);
    if (dataMode !== 'demo') {
      setError('Sign-in isn’t connected in this build yet. The collaboration service client is still being built.');
      return;
    }
    setBusy(true);
    setTimeout(() => {
      setBusy(false);
      app.completeOnboarding('connect');
    }, 700);
  };

  return (
    <div className={cx('welcome drag', build?.platform === 'darwin' && 'is-mac')}>
      <div className="welcome-glow" aria-hidden />
      <main className="welcome-card no-drag">
        <div className="welcome-mark"><LogoMark size={44} /></div>

        {onboarding === 'signin' ? (
          <>
            <h1 className="welcome-title">One agent. The whole team.</h1>
            <p className="welcome-sub">Work on the same AI coding session together. Everyone sees the conversation, decisions and changes, while your files and commands stay on your computer.</p>

            <ul className="welcome-points">
              <li><span><Users size={15} aria-hidden /></span><div><strong>Join mid-task</strong>Pick up a teammate’s session with its full context.</div></li>
              <li><span><ShieldCheck size={15} aria-hidden /></span><div><strong>You approve every command</strong>The host reviews exactly what runs, every time.</div></li>
              <li><span><Laptop size={15} aria-hidden /></span><div><strong>Code stays local</strong>Each chat gets its own private worktree. Your checkout is never touched.</div></li>
            </ul>

            <Button variant="primary" size="lg" className="btn-block" onClick={signIn} disabled={busy} trailing={busy ? <Spinner /> : <ArrowRight size={16} aria-hidden />}>
              Continue with Google
            </Button>
            <p className="welcome-fine">Opens your browser to sign in, then brings you back here.</p>
            {error && <p className="welcome-error" role="alert"><CircleX size={14} aria-hidden />{error}</p>}
          </>
        ) : (
          <>
            <span className="step-kicker">Step 2 of 2</span>
            <h1 className="welcome-title">Connect your AI</h1>
            <p className="welcome-sub">Pick how sessions you host get inference. Teammates who join your sessions never need their own.</p>

            <div className="connect-options" role="radiogroup" aria-label="AI connection">
              {([
                ['account', Cpu, 'Sign in to a provider account', 'Use a subscription you already have. Only works with that provider’s own agent.'],
                ['api', KeyRound, 'Use an API key', 'Stored encrypted on this computer and never shown to teammates.'],
                ['later', WifiOff, 'Set up later', 'You can still join teammates’ sessions and add projects.'],
              ] as const).map(([v, Icon, title, desc]) => (
                <button key={v} type="button" role="radio" aria-checked={choice === v} className={cx('connect-option', choice === v && 'is-selected')} onClick={() => setChoice(v)}>
                  <span className="connect-icon"><Icon size={16} aria-hidden /></span>
                  <span className="connect-text"><span className="connect-title">{title}</span><span className="connect-desc">{desc}</span></span>
                  <span className="radio-dot" aria-hidden>{choice === v && <Check size={11} strokeWidth={3} />}</span>
                </button>
              ))}
            </div>

            <Button variant="primary" size="lg" className="btn-block" onClick={() => {
              if (choice !== 'later') app.toast('Provider connections arrive with the local runtime. Continuing without one.', 'info');
              onDemoSignIn();
            }}>
              Continue
            </Button>
          </>
        )}
      </main>
      <footer className="welcome-footer no-drag">
        <span className="mono">MultAI {build?.version ?? ''} · {build?.commit ?? ''}</span>
        {dataMode === 'demo' && <span className="demo-inline">Demo data</span>}
      </footer>
    </div>
  );
}
