// Paired owner control. The phone asks; the desktop decides and does. Every button sends one signed
// request bound to what this screen shows (session, run generation, the exact action or queue), and
// the screen says "waiting for the desktop" until the desktop acknowledges it. Nothing is ever shown as
// done because the phone sent it.
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {ApiError, type Account, type Me, describeStatus, formatPairingCode, hostAvailability, normalizePairingCode, personLabel, projectTimeline, type ApiClient, type ControlSession, type Controller, type ControllerState, type LedgerEntry, type WireEvent} from '@multai/companion-core';
import {Banner, Button, Empty, Field, Header, StatusPill, Tabs, cx, errorText, relative, useConfirm} from './ui';
import {useNow, usePoll} from './hooks';
import {Timeline} from './Timeline';
import {Composer} from './Participant';

const KIND_LABEL: Record<LedgerEntry['kind'], string> = {start: 'Start instruction', resolve: 'Resolve directions', stop: 'Stop', steer: 'Steer', approve: 'Approve action', reject: 'Reject action'};

export function requestStatusText(entry: LedgerEntry, now: number): {text: string; tone: 'info' | 'ok' | 'warn' | 'error'} {
  switch (entry.status) {
    case 'sending': return {text: 'Sending…', tone: 'info'};
    case 'unsent': return entry.signed.envelope.expiresAt > now ? {text: 'Not delivered yet — retrying', tone: 'warn'} : {text: 'Never delivered. It expired and will not run.', tone: 'warn'};
    case 'pending': return {text: 'Waiting for the desktop', tone: 'info'};
    case 'delivered': return {text: 'The desktop is checking it', tone: 'info'};
    case 'accepted': return {text: 'The desktop did it', tone: 'ok'};
    case 'rejected': return {text: `The desktop refused: ${entry.message ?? entry.code ?? 'no reason given'}`, tone: 'error'};
    case 'expired': return {text: 'Expired before the desktop answered. It will not run.', tone: 'warn'};
    case 'canceled': return {text: entry.code === 'run_stopped' ? 'Canceled because the run stopped.' : 'Canceled. It will not run.', tone: 'warn'};
  }
}

export function PairPhone({controller, initialCode, onDone}: {controller: Controller; initialCode?: string; onDone: () => void}) {
  const [code, setCode] = useState(initialCode ? formatPairingCode(normalizePairingCode(initialCode) ?? initialCode) : '');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [state, setState] = useState<ControllerState>(controller.current);
  useEffect(() => controller.subscribe(setState), [controller]);
  const claim = async () => {
    setBusy(true); setProblem(null);
    try {await controller.claim(code);} catch (failure) {setProblem(errorText(failure));} finally {setBusy(false);}
  };
  usePoll(async () => {if (state.status === 'claimed') await controller.refresh();}, 2_000, [state.status]);
  useEffect(() => {if (state.status === 'paired') onDone();}, [state.status, onDone]);
  return (
    <main className="c-main c-narrow" id="main">
      {state.status !== 'claimed' ? (
        <form className="c-form" onSubmit={event => {event.preventDefault(); void claim();}}>
          <p>On the desktop, open <b>Settings → Paired phones</b> and choose <b>Pair a phone</b>. Scan the QR code with this phone’s camera, or type the code.</p>
          <Field id="pair-code" label="Pairing code" hint="12 letters and digits, valid for five minutes and only once.">
            <input id="pair-code" className="c-code-input" inputMode="text" autoCapitalize="characters" autoComplete="one-time-code" autoCorrect="off" spellCheck={false} maxLength={16} value={code} onChange={event => setCode(event.target.value)} aria-describedby="pair-code-hint" />
          </Field>
          {problem && <p className="c-error" role="alert">{problem}</p>}
          <Button variant="primary" busy={busy} disabled={!normalizePairingCode(code)} onClick={() => void claim()}>Pair this phone</Button>
          <p className="c-muted">This phone gets its own key. It never receives the desktop’s sign-in, files, terminal or model keys.</p>
        </form>
      ) : (
        <section className="c-form" aria-live="polite">
          <h2 className="c-h2">Confirm on the desktop</h2>
          <p>Check that <b>{state.hostName}</b> shows these six digits, then confirm there:</p>
          <p className="c-sas" aria-label={`Check digits ${state.verificationCode.split('').join(' ')}`}>{state.verificationCode}</p>
          <p className="c-muted"><span className="c-spinner" aria-hidden /> Waiting for the desktop to confirm…</p>
          <Button variant="ghost" onClick={() => void controller.reset().then(() => controller.refresh())}>Cancel pairing</Button>
        </section>
      )}
    </main>
  );
}

export function OwnerSessions({controller, open, resume}: {controller: Controller; open: (id: string) => void; resume: number}) {
  const [state, setState] = useState<ControllerState>(controller.current);
  useEffect(() => controller.subscribe(setState), [controller]);
  const poll = usePoll(async () => {await controller.refresh();}, 5_000, [], resume);
  const [ask, confirmNode] = useConfirm();
  if (state.status !== 'paired') return null;
  const info = state.info;
  return (
    <>
      {poll.failing && <Banner tone="warn" title={poll.offline ? 'No connection' : 'Can’t reach MultAI'}>The desktop’s state below may be out of date.</Banner>}
      <p className="c-muted c-pad">Paired with <b>{info.pairing.hostName}</b> ({info.pairing.ownerName}) as <b>{info.pairing.deviceName}</b>{info.pairing.expiresAt ? ` until ${new Date(info.pairing.expiresAt).toLocaleString()}` : ''}.</p>
      {info.sessions.length === 0 ? <Empty title="No sessions">The desktop paired this phone for sessions that no longer exist.</Empty> : (
        <ul className="c-list" aria-label="Sessions you control">
          {info.sessions.map(session => {
            const view = describeStatus({sessionStatus: session.status, report: session.host});
            return (
              <li key={session.id}>
                <button type="button" className="c-list-item" onClick={() => open(session.id)}>
                  <span className="c-list-title">{session.title}</span>
                  <span className="c-list-meta"><StatusPill view={view} />{session.host?.state.approval && <span className="c-chip c-tone-warn">Approval waiting</span>}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="c-pad"><Button variant="danger" onClick={() => void ask('Unpair this phone? It stops controlling the desktop right away.').then(async ok => {if (ok) await controller.unpair();})}>Unpair this phone</Button></div>
      {confirmNode}
    </>
  );
}

type Tab = 'control' | 'activity';

export function OwnerSession({controller, api, account, me, sessionId, back, resume}: {controller: Controller; api: ApiClient; account: Account; me: Me | null; sessionId: string; back: () => void; resume: number}) {
  const [detail, setDetail] = useState<ControlSession | null>(null);
  const [events, setEvents] = useState<WireEvent[]>([]);
  const cursor = useRef(0);
  const [ledger, setLedger] = useState<LedgerEntry[]>(controller.ledger());
  const [tab, setTab] = useState<Tab>('control');
  const [problem, setProblem] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [resolution, setResolution] = useState('');
  const [preview, setPreview] = useState<string | null>(null);
  // A prompt typed on this phone is selected as soon as the queue shows it, ready to start or steer.
  const [typed, setTyped] = useState<string | null>(null);
  const [ask, confirmNode] = useConfirm();
  const now = useNow(1000);
  useEffect(() => controller.onLedger(setLedger), [controller]);
  useEffect(() => {
    if (!typed) return;
    const mine = [...(detail?.queue.pending ?? [])].reverse().find(item => item.text === typed);
    if (mine) {setSelected(mine.id); setResolution(mine.text); setTyped(null);}
  }, [typed, detail?.queue.pending]);

  const poll = usePoll(async () => {
    let next: ControlSession;
    try {next = await controller.sessionDetail(sessionId);}
    catch (failure) {
      // Removed, expired or out of scope: refresh the pairing so the app says so plainly.
      if (failure instanceof ApiError && failure.status === 403) await controller.refresh();
      throw failure;
    }
    setDetail(next);
    // Only fetch events when the session moved on, and only check requests that are still open.
    for (let page = 0; page < 20 && next.session.lastSequence > cursor.current; page++) {
      const result = await controller.events(sessionId, cursor.current);
      if (result.events.length) {setEvents(previous => [...previous, ...result.events].slice(-1500)); cursor.current = result.cursor;}
      if (result.events.length < 100) break;
    }
    if (controller.ledger().some(entry => !['accepted', 'rejected', 'expired', 'canceled'].includes(entry.status))) await controller.poll();
  }, 2_500, [sessionId], resume);

  const approval = detail?.host?.state.approval ?? null;
  const pendingAction = detail?.pendingAction ?? null;
  // The service and the desktop must agree on which exact action is waiting.
  const exact = approval && pendingAction && approval.actionId === pendingAction.actionId && approval.fingerprint === pendingAction.fingerprint ? approval : null;
  useEffect(() => {
    setPreview(null);
    if (exact?.preview) void controller.decryptPreview(exact.preview, {actionId: exact.actionId, fingerprint: exact.fingerprint}).then(setPreview);
  }, [controller, exact?.actionId, exact?.fingerprint, exact?.preview]);
  const nameOf = useCallback((userId: string | null) => personLabel(userId, null, detail?.participants.find(p => p.role === 'owner')?.userId ?? null, new Map((detail?.participants ?? []).map(p => [p.userId, p.label.replace(/ \(host\)$/u, '')]))), [detail?.participants]);
  const items = useMemo(() => projectTimeline(events, nameOf), [events, nameOf]);

  if (!detail) return <><Header title="Owner control" back={back} />{poll.failing ? <Banner tone="error" title="Can’t load this session">Check your connection. Retrying.</Banner> : <p className="c-muted c-pad">Loading…</p>}</>;
  const view = describeStatus({sessionStatus: detail.session.status, report: detail.host, pendingAction: Boolean(pendingAction), conflict: detail.queue.requiresReview});
  const availability = hostAvailability(detail.host ?? undefined);
  const hostAway = availability === 'offline' || availability === 'asleep';
  const generation = detail.session.runtimeGeneration;
  const running = detail.session.status === 'running';
  const mine = ledger.filter(entry => entry.sessionId === sessionId).slice(0, 8);
  const waitingFor = (kind: LedgerEntry['kind']) => mine.find(entry => entry.kind === kind && ['sending', 'pending', 'delivered'].includes(entry.status) && entry.signed.envelope.expiresAt > now);

  const send = async (label: string, kind: LedgerEntry['kind'], target: object, question?: string) => {
    if (question && !await ask(question)) return;
    setBusy(kind); setProblem(null);
    try {await controller.send({sessionId, runGeneration: generation, kind, target: target as never, label});}
    catch (failure) {setProblem(errorText(failure));}
    finally {setBusy(null);}
  };
  const pending = detail.queue.pending;
  const chosen = pending.find(item => item.id === selected) ?? null;
  const ownerId = detail.participants.find(person => person.role === 'owner')?.userId ?? null;
  const canType = Boolean(me && ownerId && me.id === ownerId);
  const postMessage = async (kind: 'discussion' | 'instruction', text: string, requestId: string) => {
    await account.authorized(token => api.request('POST', `/v1/sessions/${sessionId}/messages`, {auth: {type: 'bearer', token}, body: {requestId, kind, text}}));
    if (kind === 'instruction') setTyped(text);
  };

  return (
    <>
      <Header title={detail.session.title} back={back} subtitle={<StatusPill view={view} />} />
      <Banner tone={view.tone} title={view.headline}>{view.detail}</Banner>
      {poll.failing && <Banner tone="warn" title={poll.offline ? 'This phone is offline' : 'Reconnecting…'}>What you see may be out of date. Requests wait and expire after two minutes; they are never run late.</Banner>}
      {problem && <Banner tone="error" title="Not sent">{problem}</Banner>}
      <Tabs label="Owner control sections" value={tab} onChange={setTab} options={[{id: 'control', label: 'Control', badge: (exact ? 1 : 0) + (detail.queue.requiresReview ? 1 : 0)}, {id: 'activity', label: 'Activity'}]} />
      <main className="c-main" id="main">
        {tab === 'activity' && <Timeline items={items} />}
        {tab === 'control' && (
          <>
            {pendingAction && (
              <section className="c-card c-approval" aria-labelledby="approval-title">
                <h2 className="c-h2" id="approval-title">Waiting for your approval</h2>
                <p className="c-muted">{exact?.reason ?? 'The agent asked to do this on the desktop.'}</p>
                {pendingAction.kind === 'file_write' ? (
                  <>
                    <p><b>{pendingAction.newFile ? 'Create' : 'Change'}</b> <span className="c-mono">{pendingAction.path}</span></p>
                    {preview !== null ? <pre className="c-pre" aria-label="Proposed file content">{preview}</pre> : <p className="c-muted">{exact?.preview ? 'Decrypting the preview…' : 'The desktop didn’t send a preview. Review it on the desktop if you’re unsure.'}</p>}
                    {pendingAction.contentHash && <p className="c-muted c-mono">sha256 {pendingAction.contentHash.slice(0, 16)}…</p>}
                  </>
                ) : (
                  <pre className="c-pre" aria-label="Exact command">{pendingAction.command}</pre>
                )}
                <p className="c-muted">Expires {pendingAction.expiresAt > now ? `in ${Math.round((pendingAction.expiresAt - now) / 1000)} s` : 'now'}</p>
                {!exact && <p className="c-warn">The desktop hasn’t confirmed this action yet. Approval waits for it to match.</p>}
                <div className="c-row">
                  <Button variant="primary" busy={busy === 'approve'} disabled={!exact || hostAway || Boolean(waitingFor('approve') || waitingFor('reject'))}
                    onClick={() => void send(`Approve: ${exact?.summary ?? ''}`, 'approve', {actionId: pendingAction.actionId, actionFingerprint: pendingAction.fingerprint})}>Approve</Button>
                  <Button variant="danger" busy={busy === 'reject'} disabled={!exact || hostAway || Boolean(waitingFor('approve') || waitingFor('reject'))}
                    onClick={() => void send(`Reject: ${exact?.summary ?? ''}`, 'reject', {actionId: pendingAction.actionId, actionFingerprint: pendingAction.fingerprint})}>Reject</Button>
                </div>
              </section>
            )}

            {running && (
              <section className="c-card">
                <h2 className="c-h2">Agent running</h2>
                <Button variant="danger" busy={busy === 'stop'} disabled={hostAway || Boolean(waitingFor('stop'))} onClick={() => void send('Stop the agent', 'stop', {}, 'Stop the agent on the desktop? Waiting approvals are canceled.')}>Stop</Button>
              </section>
            )}

            {pending.length > 0 && <section className="c-card" aria-labelledby="queue-title">
              <h2 className="c-h2" id="queue-title">Pending directions</h2>
              {(
                <fieldset className="c-choices">
                  <legend className="c-sr">Choose a direction</legend>
                  {detail.queue.previousDirection && <p className="c-muted">The interrupted run followed {detail.queue.previousDirection.author}: “{detail.queue.previousDirection.text.slice(0, 300)}”</p>}
                  {pending.map(item => (
                    <label key={item.id} className={cx('c-choice', selected === item.id && 'is-selected')}>
                      <input type="radio" name="direction" checked={selected === item.id} onChange={() => {setSelected(item.id); setResolution(item.text);}} />
                      <span><b>{item.author}</b><span className="c-text">{item.text}</span></span>
                    </label>
                  ))}
                </fieldset>
              )}
              {detail.queue.requiresReview && pending.length > 0 && (
                <div className="c-conflict">
                  <Banner tone="warn" title="Conflicting directions">Several people want different things. Your decision replaces all of the directions above; the others will not run later.</Banner>
                  <label htmlFor="resolution">Your decision for the agent</label>
                  <textarea id="resolution" rows={3} maxLength={8000} value={resolution} onChange={event => setResolution(event.target.value)} placeholder="Pick a direction above and edit it, or write your own" />
                  <Button variant="primary" busy={busy === 'resolve'} disabled={!chosen || !resolution.trim() || hostAway || running || Boolean(waitingFor('resolve'))}
                    onClick={() => chosen && void send(`Decide: ${resolution.trim().slice(0, 80)}`, 'resolve', {instructionId: chosen.id, queueFingerprint: detail.queue.fingerprint, resolution: resolution.trim()}, 'Record this decision and start the agent with it?')}>Decide and start</Button>
                </div>
              )}
              {!detail.queue.requiresReview && pending.length > 0 && (
                <div className="c-row">
                  {!running && <Button variant="primary" busy={busy === 'start'} disabled={!chosen || hostAway || Boolean(waitingFor('start'))}
                    onClick={() => chosen && void send(`Start: ${chosen.text.slice(0, 80)}`, 'start', {instructionId: chosen.id, queueFingerprint: detail.queue.fingerprint}, `Start the agent on “${chosen.text.slice(0, 120)}”?`)}>Start selected</Button>}
                  {running && <Button busy={busy === 'steer'} disabled={!chosen || hostAway || Boolean(waitingFor('steer'))}
                    onClick={() => chosen && void send(`Steer: ${chosen.text.slice(0, 80)}`, 'steer', {instructionId: chosen.id})}>Steer into the running agent</Button>}
                </div>
              )}
              {!chosen && pending.length > 0 && <p className="c-muted">Select a direction to act on it.</p>}
            </section>}

            <section className="c-card" aria-labelledby="prompt-title">
              <h2 className="c-h2" id="prompt-title">New prompt</h2>
              {canType ? <>
                <p className="c-muted">An instruction joins the queue above, already selected: then Start it, or Steer it into the running agent. A discussion message goes to the team.</p>
                <Composer onSend={postMessage} />
              </> : me ? <p className="c-muted">You’re signed in as {me.displayName}, not this desktop’s owner. Sign in with the owner’s Google account to type prompts here.</p> : <>
                <p className="c-muted">Sign in with the same Google account as your desktop to type new prompts and messages from this phone. Pairing still decides what runs.</p>
                <Button onClick={() => void account.beginSignIn().catch(failure => setProblem(errorText(failure)))}>Sign in with Google</Button>
              </>}
            </section>

            {mine.length > 0 && <section className="c-card" aria-labelledby="requests-title" aria-live="polite">
              <h2 className="c-h2" id="requests-title">Your requests</h2>
              {(
                <ul className="c-requests">
                  {mine.map(entry => {const status = requestStatusText(entry, now); return (
                    <li key={entry.requestId} className={`c-tone-${status.tone}`}><b>{KIND_LABEL[entry.kind]}</b> <span className="c-muted">{relative(new Date(entry.createdAt).toISOString(), now)}</span><br />{status.text}</li>
                  );})}
                </ul>
              )}
            </section>}
            <p className="c-muted c-pad">Model on the desktop: {detail.host?.state.model ?? 'unknown'} · approvals: {detail.host ? {ask: 'ask for everything', auto: 'approve-for-me', full: 'full access'}[detail.host.state.access] : 'unknown'}</p>
          </>
        )}
      </main>
      {confirmNode}
    </>
  );
}
