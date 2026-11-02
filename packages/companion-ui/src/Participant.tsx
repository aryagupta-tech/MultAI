// Screens for an ordinary signed-in account: the sessions you were admitted to, their live activity,
// people, requirements and shared screenshots. Your role in each session decides what you can send;
// running or approving anything on the desktop needs owner pairing, never this sign-in.
import {useCallback, useMemo, useRef, useState} from 'react';
import {acceptanceSchema, describeStatus, eventPageSchema, hostPresenceSchema, type HostPresence, personLabel, projectTimeline, screenshotsSchema, sessionDetailSchema, sessionListSchema, type Account, type Acceptance, type ApiClient, type Me, type Session, type SharedScreenshot, type WireEvent} from '@multai/companion-core';
import {Banner, Button, Empty, Header, StatusPill, Tabs, cx, errorText, relative} from './ui';
import {usePoll, useRequestId} from './hooks';
import {Timeline} from './Timeline';
import {Requirements, type ReviewInput} from './Requirements';
import {ScreenshotMarker} from './Screenshots';

const ROLE: Record<Session['role'], string> = {owner: 'Owner', collaborator: 'Collaborator', viewer: 'Viewer'};

export function SessionList({api, account, me, open, resume}: {api: ApiClient; account: Account; me: Me; open: (id: string) => void; resume: number}) {
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const poll = usePoll(async signal => {
    const list = await account.authorized(token => api.request('GET', '/v1/sessions?limit=100', {auth: {type: 'bearer', token}, schema: sessionListSchema, signal}));
    setSessions([...list.sessions].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  }, 15_000, [], resume);
  return (
    <>
      {poll.failing && <Banner tone="warn" title={poll.offline ? 'No connection' : 'Can’t reach MultAI'}>Showing what was loaded {poll.lastOk ? relative(new Date(poll.lastOk).toISOString()) : 'earlier'}. Retrying.</Banner>}
      {sessions === null ? <p className="c-muted c-pad">Loading sessions…</p> : sessions.length === 0 ? (
        <Empty title="No sessions yet">Ask a host for an invitation link, then paste it under <b>Join a session</b>.</Empty>
      ) : (
        <ul className="c-list" aria-label="Your sessions">
          {sessions.map(session => {
            const status = describeStatus({sessionStatus: session.status});
            return (
              <li key={session.id}>
                <button type="button" className="c-list-item" onClick={() => open(session.id)}>
                  <span className="c-list-title">{session.title ?? 'Untitled session'}</span>
                  <span className="c-list-meta"><span className="c-chip">{ROLE[session.role]}</span><StatusPill view={status} /><span className="c-muted">{relative(session.updatedAt)}</span></span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <p className="c-muted c-pad">Signed in as {me.displayName}. This sign-in can’t run or approve anything on a desktop; owners pair their phone for that.</p>
    </>
  );
}

type Tab = 'activity' | 'people' | 'requirements' | 'screenshots';

export function ParticipantSession({api, account, me, sessionId, back, resume}: {api: ApiClient; account: Account; me: Me; sessionId: string; back: () => void; resume: number}) {
  const [session, setSession] = useState<Session | null>(null);
  const [participants, setParticipants] = useState<{userId: string; role: Session['role']}[]>([]);
  const [events, setEvents] = useState<WireEvent[]>([]);
  const cursor = useRef(0);
  const [acceptance, setAcceptance] = useState<Acceptance | null>(null);
  const [shots, setShots] = useState<SharedScreenshot[]>([]);
  const [tab, setTab] = useState<Tab>('activity');
  const [error, setError] = useState<string | null>(null);
  const [gone, setGone] = useState<string | null>(null);
  const [presence, setPresence] = useState<HostPresence | null>(null);
  const bearer = useCallback(<T,>(work: (token: string) => Promise<T>) => account.authorized(work), [account]);

  const poll = usePoll(async signal => {
    try {
      const detail = await bearer(token => api.request('GET', `/v1/sessions/${sessionId}`, {auth: {type: 'bearer', token}, schema: sessionDetailSchema, signal}));
      setSession(detail.session); setParticipants(detail.participants);
      // Catch up page by page, and only when the session has something new: the phone and the
      // desktop often share one home IP and its request budget.
      for (let page = 0; page < 20 && detail.session.lastSequence > cursor.current; page++) {
        const result = await bearer(token => api.request('GET', `/v1/sessions/${sessionId}/events?after=${cursor.current}&limit=100`, {auth: {type: 'bearer', token}, schema: eventPageSchema, signal}));
        if (result.events.length) {setEvents(previous => [...previous, ...result.events].slice(-1500)); cursor.current = result.cursor;}
        if (result.events.length < 100) break;
      }
      setGone(null);
    } catch (failure) {
      const status = (failure as {status?: number}).status;
      if (status === 403 || status === 404 || status === 410) {setGone(errorText(failure)); setEvents([]); return;}
      throw failure;
    }
  }, 3_000, [sessionId], resume);
  usePoll(async signal => {
    setPresence(await bearer(token => api.request('GET', `/v1/sessions/${sessionId}/host-presence`, {auth: {type: 'bearer', token}, schema: hostPresenceSchema, signal})));
  }, 10_000, [sessionId], resume);
  usePoll(async signal => {
    if (tab !== 'requirements' && tab !== 'screenshots') return;
    const [a, s] = await Promise.all([
      bearer(token => api.request('GET', `/v1/sessions/${sessionId}/acceptance`, {auth: {type: 'bearer', token}, schema: acceptanceSchema, signal})),
      bearer(token => api.request('GET', `/v1/sessions/${sessionId}/shared-screenshots`, {auth: {type: 'bearer', token}, schema: screenshotsSchema, signal})),
    ]);
    setAcceptance(a); setShots(s.screenshots);
  }, 8_000, [sessionId, tab], resume);

  const nameOf = useCallback((userId: string | null) => personLabel(userId, me, session?.ownerId ?? null), [me, session?.ownerId]);
  const items = useMemo(() => projectTimeline(events, nameOf), [events, nameOf]);
  const status = session ? describeStatus({sessionStatus: session.status, ...(presence ? {report: presence.report, connected: presence.connected} : {})}) : null;
  const canSend = session ? session.role !== 'viewer' : false;
  const act = async (work: () => Promise<unknown>) => {setError(null); try {await work();} catch (failure) {setError(errorText(failure));}};

  if (gone) return <><Header title="Session" back={back} /><Banner tone="error" title="This session isn’t available">{gone}</Banner></>;
  return (
    <>
      <Header title={session?.title ?? 'Session'} back={back} subtitle={session && <><span className="c-chip">{ROLE[session.role]}</span> {status && <StatusPill view={status} />}</>} />
      {poll.failing && <Banner tone="warn" title={poll.offline ? 'No connection' : 'Reconnecting…'}>New activity will appear when the connection returns.</Banner>}
      {error && <Banner tone="error" title="That didn’t go through">{error}</Banner>}
      <Tabs label="Session sections" value={tab} onChange={setTab} options={[{id: 'activity', label: 'Activity'}, {id: 'people', label: 'People'}, {id: 'requirements', label: 'Requirements'}, {id: 'screenshots', label: 'Screenshots', badge: shots.length}]} />
      <main className="c-main" id="main">
        {tab === 'activity' && (
          <Timeline items={items} canChangeQueued={item => canSend && (item.authorId === me.id || session?.role === 'owner')}
            onSteer={session?.status === 'running' ? id => void act(() => bearer(token => api.request('POST', `/v1/sessions/${sessionId}/instructions/${id}/steer`, {auth: {type: 'bearer', token}, body: {}}))) : undefined}
            onRemove={id => void act(() => bearer(token => api.request('DELETE', `/v1/sessions/${sessionId}/instructions/${id}`, {auth: {type: 'bearer', token}})))} />
        )}
        {tab === 'people' && (
          <ul className="c-list" aria-label="People in this session">
            {participants.map(person => <li key={person.userId} className="c-list-row"><b>{nameOf(person.userId)}</b><span className="c-chip">{ROLE[person.role]}</span>{person.userId === session?.ownerId && <span className="c-muted">original host</span>}</li>)}
          </ul>
        )}
        {tab === 'requirements' && (
          <Requirements acceptance={acceptance} canPropose={canSend} canReview={canSend} running={session?.status === 'running'}
            onPropose={input => act(() => bearer(token => api.request('POST', `/v1/sessions/${sessionId}/acceptance/criteria`, {auth: {type: 'bearer', token}, body: input})))}
            onReview={(input: ReviewInput) => act(() => bearer(token => api.request('POST', `/v1/sessions/${sessionId}/acceptance/reviews`, {auth: {type: 'bearer', token}, body: input})))} />
        )}
        {tab === 'screenshots' && (shots.length === 0 ? <Empty title="No shared screenshots">The host shares screenshots from the desktop when they want feedback on a specific screen.</Empty> :
          shots.map(shot => <ScreenshotMarker key={shot.id} shot={shot} disabled={!canSend} onSubmit={input => act(() => bearer(token => api.request('POST', `/v1/sessions/${sessionId}/screenshot-comments`, {auth: {type: 'bearer', token}, body: input})))} />))}
      </main>
      {tab === 'activity' && canSend && session && <Composer onSend={(kind, text, requestId) => bearer(token => api.request('POST', `/v1/sessions/${sessionId}/messages`, {auth: {type: 'bearer', token}, body: {requestId, kind, text}}))} />}
      {tab === 'activity' && session?.role === 'viewer' && <p className="c-muted c-pad">You’re a viewer: you can read along but not send.</p>}
    </>
  );
}

/** The message box. A retry after a lost answer reuses the same request id, so nothing is sent twice. */
export function Composer({onSend}: {onSend: (kind: 'discussion' | 'instruction', text: string, requestId: string) => Promise<unknown>}) {
  const [text, setText] = useState('');
  const [kind, setKind] = useState<'discussion' | 'instruction'>('discussion');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [requestId, renew] = useRequestId(`${kind}:${text}`);
  const send = async () => {
    const value = text.trim();
    if (!value || busy) return;
    setBusy(true); setProblem(null);
    try {await onSend(kind, value, requestId); setText(''); renew();}
    catch (failure) {setProblem(errorText(failure));}
    finally {setBusy(false);}
  };
  return (
    <form className="c-composer" onSubmit={event => {event.preventDefault(); void send();}}>
      {problem && <p className="c-error" role="alert">{problem} Your message is kept; send again to retry.</p>}
      <div className="c-seg" role="radiogroup" aria-label="Message type">
        {(['discussion', 'instruction'] as const).map(value => (
          <button key={value} type="button" role="radio" aria-checked={kind === value} className={cx('c-seg-item', kind === value && 'is-active')} onClick={() => setKind(value)}>{value === 'discussion' ? 'Team discussion' : 'Instruction for the agent'}</button>
        ))}
      </div>
      <div className="c-composer-row">
        <label htmlFor="composer" className="c-sr">{kind === 'discussion' ? 'Message to the team' : 'Instruction for the agent'}</label>
        <textarea id="composer" rows={1} maxLength={16_000} value={text} placeholder={kind === 'discussion' ? 'Message the team' : 'Tell the agent what to do (the host decides when it runs)'} onChange={event => setText(event.target.value)}
          onKeyDown={event => {if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {event.preventDefault(); void send();}}} enterKeyHint="send" />
        <Button variant="primary" busy={busy} disabled={!text.trim()} onClick={() => void send()}>Send</Button>
      </div>
    </form>
  );
}
