// The MultAI companion. Three separate ways in, never mixed: an ordinary sign-in (your sessions, as
// collaborator, viewer or owner-on-another-device), owner pairing (this phone asks the desktop to act)
// and a guest review invitation.
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Account, ApiClient, ApiError, Controller, type AccountState, type ControllerState} from '@multai/companion-core';
import type {CompanionPlatform, Links} from './platform';
import {parseInvitation} from './platform';
import {JoinIntent} from './join-intent';
import {Banner, Button, Field, Header, cx, errorText} from './ui';
import {useOnline} from './hooks';
import {ParticipantSession, SessionList} from './Participant';
import {OwnerSession, OwnerSessions, PairPhone} from './Owner';
import {GuestReview} from './Review';

type Screen =
  | {name: 'home'}
  | {name: 'sessions'}
  | {name: 'session'; id: string}
  | {name: 'pair'; code?: string}
  | {name: 'owner'}
  | {name: 'owner-session'; id: string}
  | {name: 'review'; token: string}
  | {name: 'join'; token?: string};

/** Screens are kept in history state (never in the URL), so Back and Android's back button work. */
function useNavigation(initial: Screen, onNavigate: (next: Screen) => void) {
  const [screen, setScreen] = useState<Screen>(initial);
  const changed=useRef(onNavigate);changed.current=onNavigate;
  const transition=useCallback((next:Screen)=>{changed.current(next);setScreen(next);},[]);
  useEffect(() => {
    history.replaceState({screen: initial}, '');
    const pop = (event: PopStateEvent) => transition((event.state as {screen?: Screen} | null)?.screen ?? {name: 'home'});
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const go = useCallback((next: Screen, replace = false) => {
    // A guest review never survives navigation: its credential is memory-only.
    if (replace) history.replaceState({screen: next}, ''); else history.pushState({screen: next.name === 'review' ? {name: 'home'} : next}, '');
    transition(next);
    window.scrollTo?.(0, 0);
  }, [transition]);
  const back = useCallback(() => {if (history.state && history.length > 1) history.back(); else transition({name: 'home'});}, [transition]);
  return {screen, go, back};
}

export function CompanionApp({platform}: {platform: CompanionPlatform}) {
  const api = useMemo(() => new ApiClient({origin: platform.origin, mode: platform.kind === 'web' ? 'web' : 'app'}), [platform]);
  const joinIntent=useMemo(()=>new JoinIntent(platform.account.flows,platform.origin),[platform]);
  const account = useMemo(() => new Account(api, {...platform.account,openSignIn:async url=>{joinIntent.bindFlow();await platform.account.openSignIn(url);}}), [api, platform,joinIntent]);
  const controller = useMemo(() => new Controller(api, platform.controller), [api, platform]);
  const [links] = useState<Links>(() => platform.initialLinks());
  const [accountState, setAccountState] = useState<AccountState>(account.current);
  const [controllerState, setControllerState] = useState<ControllerState>(controller.current);
  const [notice, setNotice] = useState<{tone: 'info' | 'warn' | 'error'; text: string} | null>(null);
  const [resume, setResume] = useState(0);
  const online = useOnline();
  const [initial]=useState<Screen>(()=>{const token=links.join??(!links.signin?joinIntent.resume():null);return links.review?{name:'review',token:links.review}:links.pair?{name:'pair',code:links.pair}:token?{name:'join',token}:{name:'home'};});
  const trackDestination=useCallback((next:Screen)=>{
    if(next.name==='join'&&next.token)joinIntent.remember(next.token);else joinIntent.clear();
  },[joinIntent]);
  const {screen,go,back}=useNavigation(initial,trackDestination);
  const completing=useRef<{fragment:string;promise:Promise<void>}|null>(null);

  useEffect(() => account.subscribe(setAccountState), [account]);
  useEffect(() => controller.subscribe(setControllerState), [controller]);
  useEffect(() => platform.onResume(() => setResume(value => value + 1)), [platform]);

  const completeSignIn=useCallback((fragment:string):Promise<void>=>{
    if(completing.current?.fragment===fragment)return completing.current.promise;
    const promise=(async()=>{
      try{await account.completeSignIn(fragment);const token=joinIntent.afterSignIn(fragment);go(token?{name:'join',token}:{name:'sessions'},true);}
      catch(failure){setNotice({tone:'error',text:errorText(failure)});}
    })();
    completing.current={fragment,promise};return promise;
  },[account,go,joinIntent]);

  // Restore saved sign-in and pairing after a reload, resume or process death.
  useEffect(() => {
    platform.clearLinks();
    if(links.join)joinIntent.remember(links.join);
    else if(links.review||links.pair)joinIntent.clear();
    if (links.signin) void completeSignIn(links.signin);
    else void account.restore().catch(failure => {if (failure instanceof ApiError && failure.uncertain) setNotice({tone: 'warn', text: 'Offline: your sign-in is kept and will be checked when the connection returns.'});});
    void controller.refresh().catch(() => undefined);
    return platform.onLink(next => {
      if (next.signin) void completeSignIn(next.signin);
      else if (next.pair) go({name: 'pair', code: next.pair});
      else if (next.review) go({name: 'review', token: next.review});
      else if (next.join) go({name: 'join', token: next.join});
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (controllerState.status === 'unpaired' && (controllerState.reason === 'revoked' || controllerState.reason === 'expired')) {
      setNotice({tone: 'warn', text: controllerState.reason === 'expired' ? 'This phone’s owner access expired. Pair it again from the desktop.' : 'This phone was removed on the desktop. It can no longer control the agent.'});
      if (screen.name === 'owner' || screen.name === 'owner-session') go({name: 'home'}, true);
    }
  }, [controllerState, screen.name, go]);
  useEffect(() => {
    if (accountState.status === 'signed-out' && accountState.reason === 'expired') setNotice({tone: 'warn', text: 'Your sign-in expired. Sign in again to see your sessions.'});
  }, [accountState]);

  const signedIn = accountState.status === 'signed-in' ? accountState.me : null;
  const paired = controllerState.status === 'paired';
  const nav = (
    <nav className="c-nav" aria-label="Main">
      <button type="button" className={cx(screen.name === 'home' && 'is-active')} aria-current={screen.name === 'home' ? 'page' : undefined} onClick={() => go({name: 'home'})}>Home</button>
      {signedIn && <button type="button" className={cx((screen.name === 'sessions' || screen.name === 'session') && 'is-active')} aria-current={screen.name === 'sessions' ? 'page' : undefined} onClick={() => go({name: 'sessions'})}>Sessions</button>}
      {paired && <button type="button" className={cx((screen.name === 'owner' || screen.name === 'owner-session') && 'is-active')} aria-current={screen.name === 'owner' ? 'page' : undefined} onClick={() => go({name: 'owner'})}>Owner control</button>}
    </nav>
  );

  let body;
  switch (screen.name) {
    case 'home': body = <Home platform={platform} account={account} accountState={accountState} controllerState={controllerState} go={go} />; break;
    case 'sessions': body = signedIn ? <><Header title="Sessions" /><SessionList api={api} account={account} me={signedIn} open={id => go({name: 'session', id})} resume={resume} /></> : <SignInFirst go={go} />; break;
    case 'session': body = signedIn ? <ParticipantSession api={api} account={account} me={signedIn} sessionId={screen.id} back={back} resume={resume} /> : <SignInFirst go={go} />; break;
    case 'pair': body = <><Header title="Pair as owner" back={back} /><PairPhone controller={controller} {...(screen.code ? {initialCode: screen.code} : {})} onDone={() => go({name: 'owner'}, true)} /></>; break;
    case 'owner': body = paired ? <><Header title="Owner control" /><OwnerSessions controller={controller} open={id => go({name: 'owner-session', id})} resume={resume} /></> : <><Header title="Owner control" back={back} /><main className="c-main c-narrow"><p>This phone isn’t paired.</p><Button variant="primary" onClick={() => go({name: 'pair'})}>Pair as owner</Button></main></>; break;
    case 'owner-session': body = <OwnerSession controller={controller} api={api} sessionId={screen.id} back={back} resume={resume} />; break;
    case 'review': body = <GuestReview api={api} invitation={screen.token} back={() => go({name: 'home'}, true)} />; break;
    case 'join': body = <Join key={screen.token??'empty'} api={api} account={account} signedIn={Boolean(signedIn)} restoring={accountState.status==='restoring'} token={screen.token} go={go} remember={token=>joinIntent.remember(token)} clear={()=>joinIntent.clear()} />; break;
  }
  return (
    <div className="c-app">
      <a className="c-skip" href="#main">Skip to content</a>
      {!online && <Banner tone="warn" title="You’re offline">Nothing you send is lost: messages stay in the box, and owner requests expire safely instead of running late.</Banner>}
      {notice && <Banner tone={notice.tone} title={notice.text} action={<button type="button" className="c-link" onClick={() => setNotice(null)}>Dismiss</button>} />}
      {body}
      {(signedIn || paired) && nav}
    </div>
  );
}

function SignInFirst({go}: {go: (screen: Screen) => void}) {
  return <><Header title="Sign in" /><main className="c-main c-narrow"><p>Sign in to see your sessions.</p><Button variant="primary" onClick={() => go({name: 'home'})}>Go to sign-in</Button></main></>;
}

function Home({platform, account, accountState, controllerState, go}: {platform: CompanionPlatform; account: Account; accountState: AccountState; controllerState: ControllerState; go: (screen: Screen) => void}) {
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [link, setLink] = useState('');
  const signIn = async () => {setBusy(true); setProblem(null); try {await account.beginSignIn();} catch (failure) {setProblem(errorText(failure));} finally {setBusy(false);}};
  const openLink = () => {
    const parsed = parseInvitation(link);
    if (!parsed) {setProblem('That isn’t a MultAI invitation or review link.'); return;}
    setLink('');
    go(parsed.kind === 'review' ? {name: 'review', token: parsed.token} : {name: 'join', token: parsed.token});
  };
  const me = accountState.status === 'signed-in' ? accountState.me : null;
  return (
    <>
      <header className="c-hero">
        <p className="c-logo" aria-hidden>MultAI</p>
        <h1 tabIndex={-1}>Companion</h1>
        <p className="c-muted">Follow your team’s coding agent and, as its owner, steer it from your phone. The agent, your code and your keys stay on the desktop.</p>
      </header>
      <main className="c-main c-narrow" id="main">
        {problem && <Banner tone="error" title={problem} />}
        <section className="c-card" aria-labelledby="home-account">
          <h2 className="c-h2" id="home-account">Your sessions</h2>
          {me ? (
            <>
              <p>Signed in as <b>{me.displayName}</b>.</p>
              <div className="c-row"><Button variant="primary" onClick={() => go({name: 'sessions'})}>Open sessions</Button><Button variant="ghost" onClick={() => void account.signOut()}>Sign out</Button></div>
            </>
          ) : accountState.status === 'restoring' ? <p className="c-muted">Checking your sign-in…</p> : (
            <>
              <p className="c-muted">See sessions you were admitted to, read catch-up briefs, talk to the team and review requirements.</p>
              <Button variant="primary" busy={busy} onClick={() => void signIn()}>Sign in with Google</Button>
            </>
          )}
        </section>
        <section className="c-card" aria-labelledby="home-owner">
          <h2 className="c-h2" id="home-owner">Owner control</h2>
          {controllerState.status === 'paired' ? (
            <><p>This phone controls <b>{controllerState.info.pairing.hostName}</b>.</p><Button variant="primary" onClick={() => go({name: 'owner'})}>Open owner control</Button></>
          ) : controllerState.status === 'claimed' ? (
            <><p>Waiting for the desktop to confirm this phone.</p><Button onClick={() => go({name: 'pair'})}>Show check digits</Button></>
          ) : (
            <><p className="c-muted">Start, stop, steer and approve the agent on your own desktop. Pairing starts on the desktop; signing in alone never allows this.</p><Button onClick={() => go({name: 'pair'})}>Pair as owner</Button></>
          )}
        </section>
        <section className="c-card" aria-labelledby="home-link">
          <h2 className="c-h2" id="home-link">Have a link?</h2>
          <form className="c-form" onSubmit={event => {event.preventDefault(); openLink();}}>
            <Field id="home-invite" label="Invitation or review link" hint="Paste the invitation link or complete code from the host.">
              <input id="home-invite" inputMode="url" autoCapitalize="off" autoCorrect="off" spellCheck={false} value={link} onChange={event => setLink(event.target.value)} />
            </Field>
            <Button disabled={!link.trim()} onClick={openLink}>Open link</Button>
          </form>
        </section>
        <p className="c-muted c-pad">MultAI Companion {platform.version} · {platform.kind === 'android' ? 'Android app' : 'browser'} · {new URL(platform.origin).host}</p>
      </main>
    </>
  );
}

function Join({api,account,signedIn,restoring,token,go,remember,clear}:{api:ApiClient;account:Account;signedIn:boolean;restoring:boolean;token?:string|undefined;go:(screen:Screen)=>void;remember:(token:string)=>boolean;clear:()=>void}) {
  const [state,setState]=useState<'ready'|'busy'|'pending'|'admitted'>('ready');
  const [problem,setProblem]=useState<string|null>(null);
  const [sessionId,setSessionId]=useState<string|null>(null);
  const busy=useRef(false),mounted=useRef(true);
  const identity=account.current;
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  useEffect(()=>{busy.current=false;setState('ready');setProblem(null);setSessionId(null);},[identity]);
  const signIn=async()=>{
    if(!token||busy.current)return;busy.current=true;setState('busy');setProblem(null);
    try{if(!remember(token))throw new Error('Allow browser session storage to keep this invitation during sign-in.');await account.beginSignIn();}
    catch(failure){if(mounted.current)setProblem(errorText(failure));}
    finally{busy.current=false;if(mounted.current)setState('ready');}
  };
  const join=async()=>{
    if(!token||busy.current)return;busy.current=true;setState('busy');setProblem(null);
    try{
      const result=await account.authorized(bearer=>api.request<{sessionId:string;status:'pending'|'admitted'}>('POST','/v1/invitations/join',{auth:{type:'bearer',token:bearer},body:{token}}));
      if(!mounted.current||account.current!==identity)return;clear();setSessionId(result.sessionId);setState(result.status);
    }catch(failure){if(mounted.current&&account.current===identity){setProblem(errorText(failure));setState('ready');}}
    finally{if(account.current===identity)busy.current=false;}
  };
  return <>
    <Header title="Join a session" back={()=>go({name:'home'})}/>
    <main className="c-main c-narrow" id="main">
      {problem&&<Banner tone="error" title={problem}/>}
      {!token?<p>Open the invitation link from the host.</p>:restoring?<p>Checking your sign-in…</p>:!signedIn?<>
        <p>Join this session in your browser. Sign in with Google to continue; no app download is needed.</p>
        <Button variant="primary" busy={state==='busy'} onClick={()=>void signIn()}>Sign in with Google</Button>
      </>:state==='pending'?<>
        <Banner title="Request sent">The host will admit you as a collaborator or viewer.</Banner>
        <Button variant="primary" onClick={()=>go({name:'sessions'})}>View sessions</Button>
      </>:state==='admitted'&&sessionId?<>
        <Banner tone="ok" title="You’re in"/><Button variant="primary" onClick={()=>go({name:'session',id:sessionId})}>Open session</Button>
      </>:<>
        <p>Ask the host to admit you to this session. The host chooses whether you can send instructions or only watch.</p>
        <Button variant="primary" busy={state==='busy'} onClick={()=>void join()}>Ask to join</Button>
      </>}
    </main>
  </>;
}
