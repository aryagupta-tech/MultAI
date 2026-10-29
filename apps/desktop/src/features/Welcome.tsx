import { useEffect, useState } from 'react';
import { ArrowRight, Check, CircleX, Cpu, KeyRound, Laptop, Loader2, RefreshCw, ShieldCheck, Users, WifiOff } from 'lucide-react';
import { useApp } from '../model/store';
import { getBridge } from '../bridge/client';
import * as live from '../live/controller';
import { Button, Spinner, cx } from '../ui/primitives';
import { LogoMark } from '../ui/Logo';

export function Welcome({ onDemoSignIn }: { onDemoSignIn: () => void }) {
  const { onboarding, dataMode, build, auth, health, account } = useApp();
  const app = useApp.getState();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [choice, setChoice] = useState<'account' | 'api' | 'later'>('later');
  const isLive = dataMode === 'live';
  const signingIn = auth?.status === 'signing-in';
  const step = isLive ? (account ? 'connect' : 'signin') : onboarding === 'connect' ? 'connect' : 'signin';

  // Show the reason a sign-in ended (expired flow, rejected proof, offline).
  useEffect(() => {
    if (auth?.status === 'signed-out' && auth.error) setError(live.describe(auth.error));
  }, [auth]);

  const signIn = async () => {
    setError(null);
    if (!isLive) {
      setBusy(true);
      setTimeout(() => {
        setBusy(false);
        app.completeOnboarding('connect');
      }, 700);
      return;
    }
    if (!getBridge()) {
      setError('Sign-in needs the MultAI desktop app. It isn’t available in a browser preview.');
      return;
    }
    setBusy(true);
    const err = await live.signIn();
    setBusy(false);
    if (err) {
      setError(live.describe(err));
      void live.checkHealth();
    }
  };

  const finishConnect = () => {
    if (isLive) live.completeOnboarding();
    else onDemoSignIn();
  };

  return (
    <div className={cx('welcome drag', build?.platform === 'darwin' && 'is-mac')}>
      <div className="welcome-glow" aria-hidden />
      <main className="welcome-card no-drag">
        <div className="welcome-mark"><LogoMark size={36} /></div>

        {step === 'signin' ? (
          signingIn ? (
            <>
              <h1 className="welcome-title">Finish signing in</h1>
              <p className="welcome-sub">We opened Google sign-in in your browser. When you’re done there, it brings you back here automatically.</p>
              <div className="waiting-row" role="status"><Loader2 size={16} className="spin" aria-hidden /> Waiting for your browser…</div>
              <div className="welcome-actions">
                <Button variant="ghost" onClick={() => void live.cancelSignIn()}>Cancel</Button>
                <Button variant="secondary" icon={RefreshCw} onClick={() => void signIn()}>Open the browser again</Button>
              </div>
            </>
          ) : (
            <>
              <h1 className="welcome-title">One agent. The whole team.</h1>
              <p className="welcome-sub">Work on the same AI coding session together. Everyone sees the conversation, decisions and changes, while your files and commands stay on your computer.</p>

              <ul className="welcome-points">
                <li><span><Users size={15} aria-hidden /></span><div><strong>Join mid-task</strong>Pick up a teammate’s session with its full context.</div></li>
                <li><span><ShieldCheck size={15} aria-hidden /></span><div><strong>You approve every command</strong>The host reviews exactly what runs, every time.</div></li>
                <li><span><Laptop size={15} aria-hidden /></span><div><strong>Code stays local</strong>Each chat gets its own private worktree. Your checkout is never touched.</div></li>
              </ul>

              <Button variant="primary" size="lg" className="btn-block" onClick={() => void signIn()} disabled={busy} trailing={busy ? <Spinner /> : <ArrowRight size={16} aria-hidden />}>
                Continue with Google
              </Button>
              <p className="welcome-fine">Opens your browser to sign in, then brings you back here.</p>
              {error && <p className="welcome-error" role="alert"><CircleX size={14} aria-hidden />{error}</p>}
            </>
          )
        ) : (
          <>
            <span className="step-kicker">{isLive ? 'Almost done' : 'Step 2 of 2'}</span>
            <h1 className="welcome-title">Connect your AI</h1>
            <p className="welcome-sub">Pick how sessions you host get inference. Teammates who join your sessions never need their own.</p>

            <div className="connect-options" role="radiogroup" aria-label="AI connection">
              {([
                ['account', Cpu, 'Sign in to a provider account', 'Use a subscription you already have. Only works with that provider’s own agent.'],
                ['api', KeyRound, 'Use an API key', 'Stored encrypted on this computer and never shown to teammates.'],
                ['later', WifiOff, 'Set up later', 'You can still create and join sessions and talk with your team.'],
              ] as const).map(([v, Icon, title, desc]) => {
                const unavailable = isLive && v !== 'later';
                return (
                  <button
                    key={v}
                    type="button"
                    role="radio"
                    aria-checked={choice === v}
                    aria-disabled={unavailable}
                    className={cx('connect-option', choice === v && 'is-selected', unavailable && 'is-unavailable')}
                    onClick={() => !unavailable && setChoice(v)}
                  >
                    <span className="connect-icon"><Icon size={16} aria-hidden /></span>
                    <span className="connect-text">
                      <span className="connect-title">{title}{unavailable && <span className="soon-tag">Not available yet</span>}</span>
                      <span className="connect-desc">{desc}</span>
                    </span>
                    <span className="radio-dot" aria-hidden>{choice === v && <Check size={11} strokeWidth={3} />}</span>
                  </button>
                );
              })}
            </div>

            <Button variant="primary" size="lg" className="btn-block" onClick={() => {
              if (!isLive && choice !== 'later') app.toast('Provider connections arrive with the local runtime. Continuing without one.', 'info');
              finishConnect();
            }}>
              Continue
            </Button>
          </>
        )}
      </main>
      <footer className="welcome-footer no-drag">
        {isLive && (
          <span className={cx('service-pill', health?.reachable ? (health.identity === 'configured_unverified' ? 'is-ok' : 'is-warn') : 'is-down')}>
            <span className="service-dot" aria-hidden />
            {!health ? 'Checking service…' : !health.reachable ? `Service unreachable at ${health.origin}` : health.identity === 'not_configured' ? `Connected to ${health.origin} · Google sign-in not configured` : `Connected to ${health.origin}`}
            {health && !health.reachable && <button type="button" className="link-btn" onClick={() => void live.checkHealth()}>Retry</button>}
          </span>
        )}
        <span className="mono">MultAI {build?.version ?? ''} · {build?.commit ?? ''}</span>
        {dataMode === 'demo' && <span className="demo-inline">Demo data</span>}
      </footer>
    </div>
  );
}
