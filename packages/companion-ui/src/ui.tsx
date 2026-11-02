// Small, accessible building blocks in MultAI's black-and-white style. Text is always rendered as
// text: nothing from the service is ever inserted as HTML.
import {useEffect, useRef, useState, type ButtonHTMLAttributes, type ReactNode} from 'react';
import {ApiError, type StatusView} from '@multai/companion-core';

export const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(' ');

export function Button({variant = 'secondary', busy, children, className, ...rest}: ButtonHTMLAttributes<HTMLButtonElement> & {variant?: 'primary' | 'secondary' | 'ghost' | 'danger'; busy?: boolean}) {
  return (
    <button type="button" {...rest} className={cx('c-btn', `c-btn-${variant}`, className)} disabled={rest.disabled || busy} aria-busy={busy || undefined}>
      {busy && <span className="c-spinner" aria-hidden />}
      <span>{children}</span>
    </button>
  );
}

export function Banner({tone = 'info', title, children, action}: {tone?: 'info' | 'warn' | 'error' | 'ok'; title: string; children?: ReactNode; action?: ReactNode}) {
  return (
    <div className={cx('c-banner', `c-tone-${tone}`)} role={tone === 'error' ? 'alert' : 'status'}>
      <div><strong>{title}</strong>{children && <div className="c-banner-body">{children}</div>}</div>
      {action}
    </div>
  );
}

export function StatusPill({view}: {view: StatusView}) {
  return <span className={cx('c-pill', `c-tone-${view.tone}`)}><span className="c-dot" aria-hidden />{view.headline}</span>;
}

export function Header({title, back, actions, subtitle}: {title: string; back?: () => void; actions?: ReactNode; subtitle?: ReactNode}) {
  const heading = useRef<HTMLHeadingElement>(null);
  // Moving focus to the new screen's heading tells screen readers the screen changed.
  useEffect(() => {heading.current?.focus();}, [title]);
  return (
    <header className="c-header">
      {back && <button type="button" className="c-back" onClick={back} aria-label="Back">‹</button>}
      <div className="c-header-text">
        <h1 ref={heading} tabIndex={-1}>{title}</h1>
        {subtitle && <div className="c-header-sub">{subtitle}</div>}
      </div>
      {actions && <div className="c-header-actions">{actions}</div>}
    </header>
  );
}

export function Empty({title, children}: {title: string; children?: ReactNode}) {
  return <div className="c-empty"><p className="c-empty-title">{title}</p>{children && <div className="c-muted">{children}</div>}</div>;
}

export function Field({label, hint, children, id}: {label: string; hint?: string; children: ReactNode; id: string}) {
  return (
    <div className="c-field">
      <label htmlFor={id}>{label}</label>
      {children}
      {hint && <p className="c-hint" id={`${id}-hint`}>{hint}</p>}
    </div>
  );
}

export function Tabs<T extends string>({value, options, onChange, label}: {value: T; options: {id: T; label: string; badge?: number}[]; onChange: (value: T) => void; label: string}) {
  return (
    <div className="c-tabs" role="tablist" aria-label={label}>
      {options.map(option => (
        <button key={option.id} type="button" role="tab" aria-selected={value === option.id} className={cx('c-tab', value === option.id && 'is-active')} onClick={() => onChange(option.id)}>
          {option.label}{option.badge ? <span className="c-badge" aria-label={`${option.badge} waiting`}>{option.badge}</span> : null}
        </button>
      ))}
    </div>
  );
}

/** Asks once more before an action that changes the desktop. */
export function useConfirm(): [(message: string) => Promise<boolean>, ReactNode] {
  const [pending, setPending] = useState<{message: string; resolve: (ok: boolean) => void} | null>(null);
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {if (pending) confirmRef.current?.focus();}, [pending]);
  const ask = (message: string) => new Promise<boolean>(resolve => setPending({message, resolve}));
  const done = (ok: boolean) => {pending?.resolve(ok); setPending(null);};
  const node = pending ? (
    <div className="c-sheet-backdrop" onClick={() => done(false)}>
      <div className="c-sheet" role="alertdialog" aria-modal="true" aria-labelledby="c-confirm-text" onClick={event => event.stopPropagation()} onKeyDown={event => {if (event.key === 'Escape') done(false);}}>
        <p id="c-confirm-text">{pending.message}</p>
        <div className="c-row">
          <Button variant="ghost" onClick={() => done(false)}>Cancel</Button>
          <button ref={confirmRef} type="button" className="c-btn c-btn-primary" onClick={() => done(true)}><span>Confirm</span></button>
        </div>
      </div>
    </div>
  ) : null;
  return [ask, node];
}

export function errorText(error: unknown): string {
  if (error instanceof ApiError) return error.message;
  return 'Something went wrong. Try again.';
}

export function relative(iso: string, now = Date.now()): string {
  const ms = now - Date.parse(iso);
  if (!Number.isFinite(ms)) return '';
  if (ms < 60_000) return 'just now';
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)} min ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)} h ago`;
  return new Date(iso).toLocaleDateString();
}
