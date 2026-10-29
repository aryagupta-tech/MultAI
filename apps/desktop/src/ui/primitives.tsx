import {
  forwardRef, useCallback, useEffect, useId, useLayoutEffect, useRef, useState,
  type ButtonHTMLAttributes, type ReactNode, type KeyboardEvent as ReactKeyboardEvent,
} from 'react';
import { createPortal } from 'react-dom';
import { Check, X, type LucideIcon } from 'lucide-react';

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');
export { cx };

/* ---------------------------------------------------------------- Button */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'subtle';
  size?: 'sm' | 'md' | 'lg';
  icon?: LucideIcon;
  trailing?: ReactNode;
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { variant = 'secondary', size = 'md', icon: Icon, trailing, className, children, type = 'button', ...rest }, ref,
) {
  return (
    <button ref={ref} type={type} className={cx('btn', `btn-${variant}`, `btn-${size}`, className)} {...rest}>
      {Icon && <Icon className="btn-icon" size={size === 'sm' ? 14 : 16} strokeWidth={1.8} aria-hidden />}
      {children && <span className="btn-label">{children}</span>}
      {trailing}
    </button>
  );
});

type IconButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  icon: LucideIcon;
  label: string;
  shortcut?: string;
  tipSide?: 'top' | 'bottom' | 'left' | 'right';
  active?: boolean;
  size?: 'sm' | 'md';
};

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { icon: Icon, label, shortcut, tipSide = 'bottom', active, size = 'md', className, type = 'button', ...rest }, ref,
) {
  return (
    <button
      ref={ref}
      type={type}
      aria-label={label}
      data-tip={shortcut ? `${label}  ${shortcut}` : label}
      data-tip-side={tipSide}
      className={cx('icon-btn', `icon-btn-${size}`, active && 'is-active', className)}
      {...rest}
    >
      <Icon size={size === 'sm' ? 14 : 16} strokeWidth={1.8} aria-hidden />
    </button>
  );
});

/* ---------------------------------------------------------------- Kbd */

export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);
export const MOD = isMac ? '⌘' : 'Ctrl';

export function Kbd({ keys }: { keys: string }) {
  return (
    <span className="kbd-group" aria-hidden>
      {keys.split('+').map((k) => (
        <kbd key={k} className="kbd">{k === 'Mod' ? MOD : k === 'Shift' ? (isMac ? '⇧' : 'Shift') : k === 'Enter' ? '↵' : k}</kbd>
      ))}
    </span>
  );
}

export const shortcutText = (keys: string) =>
  keys.split('+').map((k) => (k === 'Mod' ? MOD : k === 'Shift' ? (isMac ? '⇧' : 'Shift') : k)).join(isMac ? '' : '+');

/* ---------------------------------------------------------------- Avatar */

export function Avatar({ name, initials, hue, size = 24, presence, ring }: {
  name: string; initials: string; hue: number; size?: number; presence?: 'online' | 'idle' | 'offline' | 'unknown'; ring?: boolean;
}) {
  return (
    <span
      className={cx('avatar', ring && 'avatar-ring')}
      style={{ width: size, height: size, fontSize: Math.round(size * 0.42), ['--hue' as string]: hue }}
      role="img"
      aria-label={presence && presence !== 'unknown' ? `${name}, ${presence}` : name}
    >
      {initials}
      {presence && presence !== 'unknown' && <span className={cx('presence', `presence-${presence}`)} aria-hidden />}
    </span>
  );
}

/* ---------------------------------------------------------------- Segmented */

export function Segmented<T extends string>({ value, options, onChange, label, size = 'md', disabled }: {
  value: T;
  options: { value: T; label: string; icon?: LucideIcon; hint?: string }[];
  onChange: (v: T) => void;
  label: string;
  size?: 'sm' | 'md';
  disabled?: boolean | string;
}) {
  const refs = useRef<(HTMLButtonElement | null)[]>([]);
  const onKey = (e: ReactKeyboardEvent, i: number) => {
    const delta = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!delta) return;
    e.preventDefault();
    const next = (i + delta + options.length) % options.length;
    const opt = options[next];
    if (opt) {
      onChange(opt.value);
      refs.current[next]?.focus();
    }
  };
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cx('segmented', `segmented-${size}`, disabled && 'is-disabled')}
      data-tip={typeof disabled === 'string' ? disabled : undefined}
    >
      {options.map((o, i) => {
        const Icon = o.icon;
        const selected = o.value === value;
        return (
          <button
            key={o.value}
            ref={(el) => { refs.current[i] = el; }}
            type="button"
            role="radio"
            aria-checked={selected}
            tabIndex={selected ? 0 : -1}
            disabled={Boolean(disabled)}
            className={cx('segment', selected && 'is-selected')}
            onClick={() => onChange(o.value)}
            onKeyDown={(e) => onKey(e, i)}
            title={o.hint}
          >
            {Icon && <Icon size={13} strokeWidth={2} aria-hidden />}
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/* ---------------------------------------------------------------- Switch */

export function Switch({ checked, onChange, label, description }: {
  checked: boolean; onChange: (v: boolean) => void; label: string; description?: string;
}) {
  const id = useId();
  return (
    <div className="switch-row">
      <div className="switch-text">
        <label htmlFor={id} className="switch-label">{label}</label>
        {description && <p className="switch-desc" id={`${id}-d`}>{description}</p>}
      </div>
      <button
        id={id}
        type="button"
        role="switch"
        aria-checked={checked}
        aria-describedby={description ? `${id}-d` : undefined}
        className={cx('switch', checked && 'is-on')}
        onClick={() => onChange(!checked)}
      >
        <span className="switch-thumb" />
      </button>
    </div>
  );
}

/* ---------------------------------------------------------------- Dialog */

const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({ open, onClose, title, description, children, width = 480, className, initialFocus, hideHeader }: {
  open: boolean;
  onClose: () => void;
  title: string;
  description?: ReactNode;
  children: ReactNode;
  width?: number;
  className?: string;
  initialFocus?: string;
  hideHeader?: boolean;
}) {
  const panel = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const restore = useRef<HTMLElement | null>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // Layout effect so focus moves before the next keystroke can land in the element behind.
  useLayoutEffect(() => {
    if (!open) return;
    restore.current = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const target = (initialFocus ? panel.current?.querySelector<HTMLElement>(initialFocus) : null)
      ?? panel.current?.querySelector<HTMLElement>(FOCUSABLE);
    target?.focus();

    // Escape and focus containment must work even if focus slipped to <body>, e.g. after a
    // clicked control re-rendered.
    const onWindowKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing || e.keyCode === 229) return;
      if (document.querySelector('.menu')) return; // An open menu closes first.
      e.preventDefault();
      onCloseRef.current();
    };
    const onFocusIn = (e: FocusEvent) => {
      const node = e.target as Node | null;
      if (panel.current && node && !panel.current.contains(node) && !(node as Element).closest?.('.menu')) {
        panel.current.querySelector<HTMLElement>(FOCUSABLE)?.focus();
      }
    };
    window.addEventListener('keydown', onWindowKey);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      window.removeEventListener('keydown', onWindowKey);
      document.removeEventListener('focusin', onFocusIn);
      document.body.style.overflow = prevOverflow;
      restore.current?.focus?.();
    };
  }, [open, initialFocus]);

  const onKeyDown = (e: ReactKeyboardEvent) => {
    if (e.nativeEvent.isComposing) return;
    if (e.key === 'Tab' && panel.current) {
      const nodes = [...panel.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((n) => n.offsetParent !== null);
      const first = nodes[0];
      const last = nodes.at(-1);
      if (!first || !last) return;
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  };

  if (!open) return null;
  return createPortal(
    <div className="dialog-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={panel}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        className={cx('dialog', className)}
        style={{ width: `min(${width}px, calc(100vw - 32px))` }}
        onKeyDown={onKeyDown}
      >
        {hideHeader ? (
          <h2 id={titleId} className="sr-only">{title}</h2>
        ) : (
          <header className="dialog-header">
            <div>
              <h2 id={titleId} className="dialog-title">{title}</h2>
              {description && <p className="dialog-desc">{description}</p>}
            </div>
            <IconButton icon={X} label="Close" onClick={onClose} size="sm" />
          </header>
        )}
        {children}
      </div>
    </div>,
    document.body,
  );
}

/* ---------------------------------------------------------------- Menu */

export interface MenuItem {
  id: string;
  label?: string;
  icon?: LucideIcon;
  hint?: string;
  checked?: boolean;
  danger?: boolean;
  disabled?: string | false;
  description?: string;
  onSelect?: () => void;
  separator?: boolean;
}

export function Menu({ trigger, items, align = 'start', side = 'bottom', label, width = 220 }: {
  trigger: (props: { ref: (el: HTMLButtonElement | null) => void; onClick: () => void; 'aria-haspopup': 'menu'; 'aria-expanded': boolean }) => ReactNode;
  items: MenuItem[];
  align?: 'start' | 'end';
  side?: 'bottom' | 'top';
  label: string;
  width?: number;
}) {
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const [active, setActive] = useState(0);
  const anchor = useRef<HTMLButtonElement | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const enabled = items.filter((i) => !i.separator);

  const close = useCallback((refocus = true) => {
    setOpen(false);
    if (refocus) anchor.current?.focus();
  }, []);

  useLayoutEffect(() => {
    if (!open || !anchor.current) return;
    const r = anchor.current.getBoundingClientRect();
    const h = list.current?.offsetHeight ?? 0;
    const left = align === 'end' ? r.right - width : r.left;
    const top = side === 'top' ? r.top - h - 6 : r.bottom + 6;
    setPos({
      left: Math.max(8, Math.min(left, window.innerWidth - width - 8)),
      top: Math.max(8, Math.min(top, window.innerHeight - h - 8)),
    });
  }, [open, align, side, width]);

  useEffect(() => {
    if (!open) return;
    const firstEnabled = enabled.findIndex((i) => !i.disabled);
    setActive(Math.max(0, firstEnabled));
    const onDown = (e: MouseEvent) => {
      if (!list.current?.contains(e.target as Node) && !anchor.current?.contains(e.target as Node)) close(false);
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (open) list.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.focus();
  }, [open, active, pos]);

  const onKey = (e: ReactKeyboardEvent) => {
    if (e.key === 'Escape' || e.key === 'Tab') {
      e.preventDefault();
      close();
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const dir = e.key === 'ArrowDown' ? 1 : -1;
      let next = active;
      for (let n = 0; n < enabled.length; n++) {
        next = (next + dir + enabled.length) % enabled.length;
        if (!enabled[next]?.disabled) break;
      }
      setActive(next);
    } else if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      setActive(e.key === 'Home' ? 0 : enabled.length - 1);
    }
  };

  let index = -1;
  return (
    <>
      {trigger({ ref: (el) => { anchor.current = el; }, onClick: () => setOpen((o) => !o), 'aria-haspopup': 'menu', 'aria-expanded': open })}
      {open && createPortal(
        <div
          ref={list}
          role="menu"
          aria-label={label}
          className="menu"
          style={{ width, top: pos?.top ?? -9999, left: pos?.left ?? -9999 }}
          onKeyDown={onKey}
        >
          {items.map((item) => {
            if (item.separator) return <div key={item.id} role="separator" className="menu-sep">{item.label && <span>{item.label}</span>}</div>;
            index++;
            const Icon = item.icon;
            const i = index;
            return (
              <button
                key={item.id}
                type="button"
                role={item.checked === undefined ? 'menuitem' : 'menuitemradio'}
                aria-checked={item.checked}
                aria-disabled={Boolean(item.disabled)}
                data-index={i}
                tabIndex={-1}
                className={cx('menu-item', item.danger && 'is-danger', item.disabled && 'is-disabled')}
                title={item.disabled || undefined}
                onMouseEnter={() => setActive(i)}
                onClick={() => {
                  if (item.disabled) return;
                  close();
                  item.onSelect?.();
                }}
              >
                <span className="menu-icon">{item.checked ? <Check size={14} strokeWidth={2.2} /> : Icon ? <Icon size={14} strokeWidth={1.8} /> : null}</span>
                <span className="menu-text">
                  <span>{item.label}</span>
                  {item.description && <span className="menu-desc">{item.description}</span>}
                </span>
                {item.hint && <span className="menu-hint">{item.hint}</span>}
              </button>
            );
          })}
        </div>,
        document.body,
      )}
    </>
  );
}

/* ---------------------------------------------------------------- Misc */

export function Spinner({ size = 14 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} role="status" aria-label="Loading" />;
}

export function EmptyState({ icon: Icon, title, children, action }: { icon: LucideIcon; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <span className="empty-icon"><Icon size={18} strokeWidth={1.6} aria-hidden /></span>
      <h3>{title}</h3>
      {children && <p>{children}</p>}
      {action}
    </div>
  );
}
