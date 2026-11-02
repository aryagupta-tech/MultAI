// Team requirements and the evidence for each. A passing check and a person accepting the behavior are
// shown separately: accepting never turns a failed check green.
import {useState} from 'react';
import type {Acceptance, Criterion} from '@multai/companion-core';
import {Button, Field, cx, relative} from './ui';
import {useRequestId} from './hooks';

const STATUS: Record<Criterion['status'], {label: string; tone: string}> = {
  proposed: {label: 'Waiting for the host to approve', tone: 'info'},
  needs_review: {label: 'Needs human review', tone: 'warn'},
  passed: {label: 'Check passed', tone: 'ok'},
  failed: {label: 'Check failed', tone: 'error'},
  stale: {label: 'Stale — verify the current code', tone: 'warn'},
};

export interface ReviewInput {requestId: string; criterionId: string; criterionVersion: number; evidenceId: string; revision: string; decision: 'accept' | 'reject'; comment?: string}

export function Requirements({acceptance, canPropose, canReview, running, onPropose, onReview}: {
  acceptance: Acceptance | null; canPropose: boolean; canReview: boolean; running?: boolean;
  onPropose?: ((input: {requestId: string; text: string; checkCommand?: string}) => Promise<void>) | undefined;
  onReview?: ((input: ReviewInput) => Promise<void>) | undefined;
}) {
  if (!acceptance) return <p className="c-muted c-pad">Loading requirements…</p>;
  return (
    <section className="c-reqs" aria-label="Requirements and verification">
      {acceptance.criteria.length === 0 && <p className="c-muted">No requirements yet.</p>}
      {acceptance.criteria.map(criterion => <CriterionCard key={`${criterion.id}-${criterion.version}`} criterion={criterion} revision={acceptance.revision} canReview={canReview && !running} onReview={onReview} />)}
      {running && canReview && <p className="c-muted">Reviews open again when the agent stops.</p>}
      {canPropose && onPropose && <Propose onPropose={onPropose} />}
    </section>
  );
}

function CriterionCard({criterion, revision, canReview, onReview}: {criterion: Criterion; revision: string | null; canReview: boolean; onReview?: ((input: ReviewInput) => Promise<void>) | undefined}) {
  const status = STATUS[criterion.status];
  const evidence = criterion.evidence;
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState<'accept' | 'reject' | null>(null);
  const reviewable = canReview && onReview && evidence && criterion.state === 'approved' && criterion.status !== 'stale' && revision === evidence.revision;
  const [acceptId, renewAccept] = useRequestId(`${evidence?.id}:${comment}:accept`);
  const [rejectId, renewReject] = useRequestId(`${evidence?.id}:${comment}:reject`);
  const decide = async (decision: 'accept' | 'reject') => {
    if (!evidence || !onReview) return;
    setBusy(decision);
    try {await onReview({requestId: decision === 'accept' ? acceptId : rejectId, criterionId: criterion.id, criterionVersion: criterion.version, evidenceId: evidence.id, revision: evidence.revision, decision, ...(comment.trim() ? {comment: comment.trim()} : {})}); setComment(''); renewAccept(); renewReject();}
    finally {setBusy(null);}
  };
  return (
    <article className="c-card">
      <div className="c-meta"><span className={cx('c-chip', `c-tone-${status.tone}`)}>{status.label}</span><span className="c-chip">v{criterion.version}</span><span className="c-muted">{criterion.authorName}{criterion.authorKind === 'browser' ? ' · browser reviewer' : ''}</span></div>
      <p className="c-text">{criterion.text}</p>
      {criterion.checkCommand && <p className="c-mono" aria-label="Locked check command">$ {criterion.checkCommand}</p>}
      {evidence && (
        <details className="c-evidence">
          <summary>Evidence from {relative(evidence.createdAt)}{evidence.kind === 'command' ? ` · exit ${evidence.exitCode ?? 'unknown'}` : ' · manual'}{evidence.timedOut ? ' · timed out' : ''}{evidence.canceled ? ' · canceled' : ''}</summary>
          <p className="c-muted">Source revision {evidence.revision.slice(0, 12)}{revision && revision !== evidence.revision ? ' (the code changed since)' : ''}</p>
          {evidence.output && <pre className="c-pre">{evidence.output}</pre>}
          {evidence.reviews.length > 0 && <ul className="c-reviews">{evidence.reviews.map(review => <li key={`${review.reviewerKind}-${review.reviewerId}`}><b>{review.reviewerName}</b> {review.decision === 'accept' ? 'accepted the behavior' : 'requested changes'}{review.comment ? `: ${review.comment}` : ''}</li>)}</ul>}
        </details>
      )}
      {reviewable && (
        <div className="c-review">
          <label className="c-sr" htmlFor={`comment-${criterion.id}`}>Comment (optional)</label>
          <input id={`comment-${criterion.id}`} placeholder="Comment (optional)" maxLength={2000} value={comment} onChange={event => setComment(event.target.value)} />
          <div className="c-row">
            <Button variant="primary" busy={busy === 'accept'} disabled={Boolean(busy)} onClick={() => void decide('accept')}>Accept behavior</Button>
            <Button variant="danger" busy={busy === 'reject'} disabled={Boolean(busy)} onClick={() => void decide('reject')}>Request changes</Button>
          </div>
          {criterion.status === 'failed' && <p className="c-muted">Accepting records your judgment; the check stays failed.</p>}
        </div>
      )}
    </article>
  );
}

function Propose({onPropose}: {onPropose: (input: {requestId: string; text: string; checkCommand?: string}) => Promise<void>}) {
  const [text, setText] = useState('');
  const [command, setCommand] = useState('');
  const [busy, setBusy] = useState(false);
  const [requestId, renew] = useRequestId(`${text}\n${command}`);
  const submit = async () => {
    setBusy(true);
    try {await onPropose({requestId, text: text.trim(), ...(command.trim() ? {checkCommand: command} : {})}); setText(''); setCommand(''); renew();}
    finally {setBusy(false);}
  };
  return (
    <form className="c-card c-form" onSubmit={event => {event.preventDefault(); void submit();}}>
      <h2 className="c-h2">Propose a requirement</h2>
      <Field id="req-text" label="Required behavior"><textarea id="req-text" rows={2} maxLength={2000} required value={text} onChange={event => setText(event.target.value)} /></Field>
      <Field id="req-command" label="Check command (optional)" hint="The host approves the exact command before it ever runs."><input id="req-command" className="c-mono-input" maxLength={2000} autoCapitalize="off" autoCorrect="off" spellCheck={false} value={command} onChange={event => setCommand(event.target.value)} /></Field>
      <Button variant="primary" busy={busy} disabled={!text.trim()} onClick={() => void submit()}>Propose</Button>
    </form>
  );
}
