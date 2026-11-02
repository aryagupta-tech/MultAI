// Browser reviewer (guest): no account, admitted by the host for one session. The credential lives in
// memory only, so leaving or reloading needs a new admission, as on the desktop's review page.
import {useEffect, useMemo, useRef, useState} from 'react';
import {ApiError, Reviewer, type ApiClient, type ReviewEvent, type ReviewView, type TimelineItem} from '@multai/companion-core';
import {Banner, Button, Field, Header, Tabs, errorText} from './ui';
import {usePoll, useRequestId} from './hooks';
import {Timeline} from './Timeline';
import {Requirements} from './Requirements';
import {ScreenshotMarker} from './Screenshots';

function toItem(event: ReviewEvent): TimelineItem | null {
  const text = typeof event.data.text === 'string' ? event.data.text : typeof event.data.summary === 'string' ? event.data.summary : null;
  const base = {id: `review-${event.sequence}`, sequence: event.sequence, at: event.at};
  if (event.type === 'plan' && Array.isArray(event.data.steps)) return {...base, kind: 'plan', steps: (event.data.steps as {text: string; state: 'todo' | 'active' | 'done'}[]).slice(0, 20)};
  if (!text) return null;
  if (event.type === 'brief.created') return {...base, kind: 'brief', text, model: 'Catch-up'};
  if (event.type === 'reviewer.comment') return {...base, kind: 'comment', who: event.who ?? 'Reviewer', text};
  if (event.type === 'agent.completed') return {...base, kind: 'agent', text};
  if (event.type.startsWith('activity.')) return {...base, kind: 'activity', text, failed: Boolean(event.data.failed)};
  if (event.type === 'decision.saved') return {...base, kind: 'decision', who: event.who ?? 'Host', text};
  return {...base, kind: 'message', style: event.type === 'message.instruction' ? 'instruction' : 'discussion', who: event.who ?? 'Teammate', authorId: '', text, screenshot: Boolean(event.data.screenshot), queued: false};
}

type Tab = 'activity' | 'requirements' | 'screenshots';

export function GuestReview({api, invitation, back}: {api: ApiClient; invitation: string; back: () => void}) {
  const reviewer = useMemo(() => new Reviewer(api, invitation), [api, invitation]);
  const [phase, setPhase] = useState<'name' | 'pending' | 'admitted' | 'ended'>(reviewer.hasInvitation ? 'name' : 'ended');
  const [ended, setEnded] = useState<string>(reviewer.hasInvitation ? '' : 'This invitation link is incomplete. Ask the host for a new one.');
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [view, setView] = useState<Extract<ReviewView, {status: 'admitted'}> | null>(null);
  const [events, setEvents] = useState<ReviewEvent[]>([]);
  const cursor = useRef(0);
  const [tab, setTab] = useState<Tab>('activity');
  const [comment, setComment] = useState('');
  const [commentId, renewComment] = useRequestId(comment);
  useEffect(() => () => reviewer.leave(), [reviewer]);

  const end = (message: string) => {reviewer.leave(); setView(null); setEvents([]); setPhase('ended'); setEnded(message);};
  const poll = usePoll(async () => {
    if (phase !== 'pending' && phase !== 'admitted') return;
    try {
      for (let page = 0; page < 20; page++) {
        const result = await reviewer.view(cursor.current);
        if (result.status === 'pending') {setPhase('pending'); return;}
        setPhase('admitted'); setView(result);
        if (result.events.length) setEvents(previous => [...previous, ...result.events].slice(-1000));
        cursor.current = result.next;
        if (result.done) break;
      }
    } catch (failure) {
      if (failure instanceof ApiError && failure.status === 403) {end(failure.message); return;}
      // Network trouble hides private content until a successful refresh, as on the review page.
      setView(null);
      throw failure;
    }
  }, 3_000, [phase]);

  const join = async () => {
    setBusy(true); setProblem(null);
    try {const result = await reviewer.request(name); setPhase(result.status === 'admitted' ? 'admitted' : 'pending');}
    catch (failure) {if (failure instanceof ApiError && failure.status === 403) end(failure.message); else setProblem(errorText(failure));}
    finally {setBusy(false);}
  };
  const act = async (work: () => Promise<unknown>) => {
    setProblem(null);
    try {await work();} catch (failure) {if (failure instanceof ApiError && failure.status === 403 && failure.code === 'review_unavailable') end(failure.message); else setProblem(errorText(failure));}
  };
  const items = useMemo(() => events.map(toItem).filter((item): item is TimelineItem => item !== null), [events]);

  return (
    <>
      <Header title={view?.session.title ?? 'Team review'} back={() => {reviewer.leave(); back();}} subtitle={view ? <span className="c-chip">Browser reviewer · {view.reviewer.name}</span> : undefined}
        actions={phase === 'admitted' || phase === 'pending' ? <Button variant="ghost" onClick={() => end('You left this review. Open the invitation again to ask for admission.')}>Leave</Button> : undefined} />
      {problem && <Banner tone="error" title="That didn’t go through">{problem}</Banner>}
      {poll.failing && phase !== 'ended' && <Banner tone="warn" title="Reconnecting…">Private review content stays hidden until the connection returns.</Banner>}
      {phase === 'name' && (
        <main className="c-main c-narrow" id="main">
          <form className="c-form" onSubmit={event => {event.preventDefault(); void join();}}>
            <p>The host invited you to review in a browser. Choose the name the host will see; they admit you before you see anything.</p>
            <Field id="review-name" label="Your name"><input id="review-name" autoComplete="name" maxLength={60} required value={name} onChange={event => setName(event.target.value)} enterKeyHint="go" /></Field>
            <Button variant="primary" busy={busy} disabled={!name.trim()} onClick={() => void join()}>Ask to join</Button>
            <p className="c-muted">Guests can comment, propose requirements and review evidence. They can’t run the agent or approve commands.</p>
          </form>
        </main>
      )}
      {phase === 'pending' && <main className="c-main c-narrow" id="main"><Banner title="Waiting for the host to admit you"><span className="c-spinner" aria-hidden /> Keep this screen open. Reloading needs a new request.</Banner></main>}
      {phase === 'ended' && <main className="c-main c-narrow" id="main"><Banner tone="warn" title="Review ended">{ended}</Banner></main>}
      {phase === 'admitted' && view && (
        <>
          {view.session.working && <Banner title="The agent is working">Reviews of evidence open again when it stops.</Banner>}
          <Tabs label="Review sections" value={tab} onChange={setTab} options={[{id: 'activity', label: 'Activity'}, {id: 'requirements', label: 'Requirements'}, {id: 'screenshots', label: 'Screenshots', badge: view.screenshots.length}]} />
          <main className="c-main" id="main">
            {tab === 'activity' && <Timeline items={items} />}
            {tab === 'requirements' && <Requirements acceptance={view.acceptance} canPropose canReview running={view.session.working}
              onPropose={input => act(() => reviewer.propose(input))} onReview={input => act(() => reviewer.decide(input))} />}
            {tab === 'screenshots' && (view.screenshots.length === 0 ? <p className="c-muted c-pad">The host hasn’t shared a screenshot.</p> :
              view.screenshots.map(shot => <ScreenshotMarker key={shot.id} shot={shot} onSubmit={input => act(() => reviewer.comment(input))} />))}
          </main>
          {tab === 'activity' && (
            <form className="c-composer" onSubmit={event => {event.preventDefault(); void act(async () => {await reviewer.comment({requestId: commentId, text: comment.trim()}); setComment(''); renewComment();});}}>
              <div className="c-composer-row">
                <label htmlFor="guest-comment" className="c-sr">Feedback for the team</label>
                <textarea id="guest-comment" rows={1} maxLength={4000} value={comment} placeholder="Feedback for the team (the agent sees it as context)" onChange={event => setComment(event.target.value)} enterKeyHint="send" />
                <Button variant="primary" disabled={!comment.trim()} onClick={() => void act(async () => {await reviewer.comment({requestId: commentId, text: comment.trim()}); setComment(''); renewComment();})}>Send</Button>
              </div>
            </form>
          )}
        </>
      )}
    </>
  );
}
