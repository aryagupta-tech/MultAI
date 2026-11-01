// The list that opens above the composer for `/` commands and `@` files. Focus stays in the textarea
// (aria-activedescendant), so typing keeps filtering and the arrow keys move the highlight.
import { useEffect, useRef } from 'react';
import type { LucideIcon } from 'lucide-react';
import { cx } from '../ui/primitives';

export interface SuggestItem {
  id: string;
  label: string;
  detail?: string;
  icon: LucideIcon;
  group: string;
  /** Characters of `label` to highlight, from the fuzzy match. */
  indices?: number[];
}

export const SUGGEST_LIST_ID = 'composer-suggest';
export const suggestOptionId = (item: SuggestItem) => `suggest-${item.id.replace(/[^\w-]/gu, '_')}`;

export function ComposerSuggest({ items, active, onActive, onPick, left, label, empty, footer }: {
  items: readonly SuggestItem[];
  active: number;
  onActive: (index: number) => void;
  onPick: (item: SuggestItem) => void;
  left: number;
  label: string;
  empty: string;
  footer?: string;
}) {
  const list = useRef<HTMLDivElement>(null);
  useEffect(() => {
    list.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, items]);

  let previous = '';
  return (
    <div className="composer-suggest" style={{ left }} onMouseDown={(e) => e.preventDefault()}>
      <div className="composer-suggest-list" id={SUGGEST_LIST_ID} role="listbox" aria-label={label} ref={list}>
        {items.length === 0 && <p className="composer-suggest-empty">{empty}</p>}
        {items.map((item, index) => {
          const heading = item.group !== previous ? item.group : null;
          previous = item.group;
          const Icon = item.icon;
          return (
            <div key={item.id} role="presentation">
              {heading && <div className="palette-group" role="presentation">{heading}</div>}
              <div
                id={suggestOptionId(item)}
                role="option"
                aria-selected={index === active}
                data-i={index}
                className={cx('palette-item', 'suggest-item', index === active && 'is-active')}
                onMouseMove={() => { if (index !== active) onActive(index); }}
                onClick={() => onPick(item)}
              >
                <Icon size={15} strokeWidth={1.8} aria-hidden />
                <span className="suggest-label truncate"><Highlighted text={item.label} indices={item.indices} /></span>
                {item.detail && <span className="suggest-detail truncate">{item.detail}</span>}
              </div>
            </div>
          );
        })}
      </div>
      {footer && <div className="composer-suggest-footer">{footer}</div>}
    </div>
  );
}

function Highlighted({ text, indices }: { text: string; indices?: number[] | undefined }) {
  if (!indices?.length) return <>{text}</>;
  const marked = new Set(indices);
  return <>{[...text].map((ch, i) => (marked.has(i) ? <mark key={i}>{ch}</mark> : ch))}</>;
}

/** The caret's x offset inside a textarea, measured with a hidden copy of its text. */
export function caretLeft(el: HTMLTextAreaElement, index: number): number {
  const style = getComputedStyle(el);
  const mirror = document.createElement('div');
  for (const prop of ['fontFamily', 'fontSize', 'fontWeight', 'letterSpacing', 'lineHeight', 'paddingLeft', 'paddingRight', 'paddingTop', 'borderLeftWidth', 'borderRightWidth', 'boxSizing', 'tabSize'] as const) {
    mirror.style[prop] = style[prop];
  }
  Object.assign(mirror.style, { position: 'absolute', visibility: 'hidden', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', width: `${el.clientWidth}px`, top: '0', left: '-9999px' });
  mirror.textContent = el.value.slice(0, index);
  const marker = document.createElement('span');
  marker.textContent = '​';
  mirror.append(marker);
  document.body.append(mirror);
  const left = marker.offsetLeft;
  mirror.remove();
  return left;
}
