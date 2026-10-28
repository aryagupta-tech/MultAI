// Pure composer behavior, kept free of React so it can be unit tested.

/** Matches the collaboration service's per-message text bound. */
export const DRAFT_LIMIT = 16_000;

export interface KeyInput {
  key: string;
  shiftKey: boolean;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  /** True while an input method editor is composing; Enter then confirms text, never sends. */
  isComposing: boolean;
  keyCode?: number;
}

export type EnterIntent = 'send' | 'send-alternate' | 'newline' | 'ignore';

export function resolveEnter(e: KeyInput): EnterIntent {
  if (e.key !== 'Enter') return 'ignore';
  // keyCode 229 is reported by some IMEs for the confirming Enter even after compositionend.
  if (e.isComposing || e.keyCode === 229) return 'ignore';
  if (e.shiftKey) return 'newline';
  if (e.metaKey || e.ctrlKey) return 'send-alternate';
  if (e.altKey) return 'newline';
  return 'send';
}

export type FormatKind = 'bold' | 'italic' | 'code' | 'codeblock' | 'link' | 'list' | 'quote';

export interface Edit {
  text: string;
  selectionStart: number;
  selectionEnd: number;
}

const WRAPS: Partial<Record<FormatKind, [string, string]>> = {
  bold: ['**', '**'],
  italic: ['_', '_'],
  code: ['`', '`'],
  codeblock: ['```\n', '\n```'],
  link: ['[', '](url)'],
};

/**
 * Inserts Markdown formatting as editable text. Returns null (leaving the draft unchanged)
 * when the result would exceed the draft limit.
 */
export function applyFormat(text: string, start: number, end: number, kind: FormatKind, limit = DRAFT_LIMIT): Edit | null {
  const selected = text.slice(start, end);
  let next: Edit;
  const wrap = WRAPS[kind];
  if (wrap) {
    const [before, after] = wrap;
    next = {
      text: text.slice(0, start) + before + selected + after + text.slice(end),
      selectionStart: start + before.length,
      selectionEnd: start + before.length + selected.length,
    };
  } else {
    const prefix = kind === 'list' ? '- ' : '> ';
    const lineStart = text.lastIndexOf('\n', start - 1) + 1;
    const block = text.slice(lineStart, end);
    const prefixed = block.split('\n').map((line) => prefix + line).join('\n');
    next = {
      text: text.slice(0, lineStart) + prefixed + text.slice(end),
      selectionStart: start + prefix.length,
      selectionEnd: lineStart + prefixed.length,
    };
  }
  return next.text.length > limit ? null : next;
}

export function draftMeter(length: number, limit = DRAFT_LIMIT): { show: boolean; tone: 'muted' | 'warn' | 'error' } {
  const ratio = length / limit;
  if (ratio > 1) return { show: true, tone: 'error' };
  if (ratio > 0.9) return { show: true, tone: 'warn' };
  return { show: ratio > 0.75, tone: 'muted' };
}
