import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import {
  ArrowUp, Bold, BookMarked, Code, Eye, EyeOff, Italic, List, ListChecks, Lock, MessageCircle, Quote, SquareCode, TerminalSquare, Type,
} from 'lucide-react';
import { useApp } from '../model/store';
import { DRAFT_LIMIT, applyFormat, draftMeter, resolveEnter, type FormatKind } from '../model/composer';
import type { MessageKind, SessionDetail } from '../model/types';
import { IconButton, Kbd, Menu, Segmented, cx, shortcutText } from '../ui/primitives';
import { Markdown } from '../ui/Markdown';

const SAVED_PROMPTS = [
  { id: 'review', label: 'Review the current diff', text: 'Review the current changes for correctness and edge cases. List concrete problems with file and line, most severe first. Don’t change any files yet.' },
  { id: 'tests', label: 'Write tests first', text: 'Before changing behavior, add failing tests that describe the expected result, then make them pass with the smallest change.' },
  { id: 'explain', label: 'Explain for a teammate', text: 'Summarize what this session has done so far for a teammate who just joined: objective, decisions, current state and what’s next.' },
];

export function Composer({ d, draftKey, autoFocus }: { d: SessionDetail | null; draftKey: string; autoFocus?: boolean }) {
  const draft = useApp((s) => s.drafts[draftKey]);
  const defaultKind = useApp((s) => s.prefs.defaultKind);
  const account = useApp((s) => s.account);
  const sending = useApp((s) => Boolean(s.sending[draftKey]));
  const app = useApp.getState();
  const text = draft?.text ?? '';
  const kind: MessageKind = draft?.kind ?? defaultKind;
  const [preview, setPreview] = useState(false);
  const [formatBar, setFormatBar] = useState(false);
  const ta = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const pendingSelection = useRef<[number, number] | null>(null);

  const running = d?.status === 'running';
  const canSubmit = d ? d.capabilities.submit : true;
  const meter = draftMeter(text.length);
  const tooLong = text.length > DRAFT_LIMIT;
  const empty = text.trim().length === 0;

  // Autosize the textarea to its content.
  useLayoutEffect(() => {
    const el = ta.current;
    if (!el) return;
    el.style.height = '0px';
    el.style.height = `${Math.min(el.scrollHeight, Math.round(window.innerHeight * 0.4))}px`;
    if (pendingSelection.current) {
      el.setSelectionRange(...pendingSelection.current);
      pendingSelection.current = null;
    }
  }, [text, preview]);

  useEffect(() => {
    if (autoFocus) ta.current?.focus();
  }, [autoFocus, draftKey]);

  useEffect(() => {
    const focus = () => ta.current?.focus();
    window.addEventListener('multai:focus-composer', focus);
    return () => window.removeEventListener('multai:focus-composer', focus);
  }, []);

  if (d && !canSubmit) {
    return (
      <div className="composer-readonly" role="note">
        <Lock size={14} aria-hidden />
        You’re a viewer in this session. You can read everything, but only collaborators can send messages.
      </div>
    );
  }

  const setKind = (k: MessageKind) => app.setDraft(draftKey, { kind: k });
  const submit = (as: MessageKind) => {
    if (empty || tooLong) return;
    if (app.send(draftKey, as)) setPreview(false);
  };

  const format = (k: FormatKind) => {
    const el = ta.current;
    if (!el) return;
    const edit = applyFormat(text, el.selectionStart, el.selectionEnd, k);
    if (!edit) {
      app.toast('That would make the draft longer than the limit.', 'error');
      return;
    }
    pendingSelection.current = [edit.selectionStart, edit.selectionEnd];
    app.setDraft(draftKey, { text: edit.text });
    el.focus();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    const intent = resolveEnter({
      key: e.key, shiftKey: e.shiftKey, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey,
      isComposing: e.nativeEvent.isComposing || composing.current, keyCode: e.keyCode,
    });
    if (intent === 'send') {
      e.preventDefault();
      submit(kind);
    } else if (intent === 'send-alternate') {
      e.preventDefault();
      submit(kind === 'instruction' ? 'discussion' : 'instruction');
    } else if (e.key === 'ArrowUp' && empty && d && account && !e.nativeEvent.isComposing) {
      // Recall the last thing you sent in this session.
      const mine = [...d.timeline].reverse().find((t) => t.type === 'message' && t.authorId === account.id);
      if (mine?.type === 'message') {
        e.preventDefault();
        app.setDraft(draftKey, { text: mine.text, kind: mine.kind });
      }
    } else if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey) {
      // Mod+B is reserved for the sidebar, so bold is toolbar-only.
      const map: Record<string, FormatKind> = { i: 'italic', e: 'code' };
      const k = map[e.key.toLowerCase()];
      if (k) {
        e.preventDefault();
        format(k);
      }
    }
  };

  const instruction = kind === 'instruction';
  const placeholder = !d
    ? 'Describe what you want to build or fix…'
    : instruction
      ? running ? 'Add a direction. It’s queued for the next safe point…' : 'Tell the agent what to do next…'
      : 'Talk with the team. The agent won’t act on this…';
  const sendLabel = instruction ? (running ? 'Queue for agent' : 'Send to agent') : 'Send to team';

  return (
    <div className={cx('composer', instruction ? 'is-instruction' : 'is-discussion')}>
      {formatBar && !preview && (
        <div className="format-bar" role="toolbar" aria-label="Formatting">
          <IconButton size="sm" icon={Bold} label="Bold" onClick={() => format('bold')} tipSide="top" />
          <IconButton size="sm" icon={Italic} label="Italic" shortcut={shortcutText('Mod+I')} onClick={() => format('italic')} tipSide="top" />
          <IconButton size="sm" icon={Code} label="Inline code" shortcut={shortcutText('Mod+E')} onClick={() => format('code')} tipSide="top" />
          <IconButton size="sm" icon={SquareCode} label="Code block" onClick={() => format('codeblock')} tipSide="top" />
          <IconButton size="sm" icon={List} label="List" onClick={() => format('list')} tipSide="top" />
          <IconButton size="sm" icon={Quote} label="Quote" onClick={() => format('quote')} tipSide="top" />
        </div>
      )}

      {preview ? (
        <div className="composer-preview" aria-label="Preview">
          {empty ? <p className="tone-muted">Nothing to preview</p> : <Markdown text={text} />}
        </div>
      ) : (
        <textarea
          ref={ta}
          className="composer-input"
          aria-label={instruction ? 'Instruction to the agent' : 'Message to the team'}
          placeholder={placeholder}
          value={text}
          rows={1}
          spellCheck
          onChange={(e) => app.setDraft(draftKey, { text: e.target.value })}
          onKeyDown={onKeyDown}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }}
        />
      )}

      <div className="composer-bar">
        <Segmented
          label="Who is this for"
          size="sm"
          value={kind}
          onChange={setKind}
          options={[
            { value: 'instruction', label: 'Agent', icon: TerminalSquare, hint: 'An instruction the agent will act on' },
            { value: 'discussion', label: 'Team', icon: MessageCircle, hint: 'Human discussion. The agent won’t act on it' },
          ]}
        />
        {d?.mode === 'plan' && instruction && (
          <span className="mode-hint" title="Plan mode blocks file writes, shell commands and external actions">
            <ListChecks size={12} aria-hidden /> Plan mode
          </span>
        )}
        <span className="spacer" />

        {meter.show && (
          <span className={cx('meter', `tone-${meter.tone}`)} aria-live="polite">
            {text.length.toLocaleString()} / {DRAFT_LIMIT.toLocaleString()}
          </span>
        )}

        <Menu
          label="Saved prompts"
          side="top"
          align="end"
          width={280}
          items={SAVED_PROMPTS.map((p) => ({
            id: p.id, label: p.label, description: 'Inserts into your draft. Doesn’t send.',
            onSelect: () => {
              const next = text ? `${text}\n\n${p.text}` : p.text;
              if (next.length > DRAFT_LIMIT) app.toast('That would make the draft longer than the limit.', 'error');
              else app.setDraft(draftKey, { text: next });
              requestAnimationFrame(() => ta.current?.focus());
            },
          }))}
          trigger={(t) => <IconButton {...t} size="sm" icon={BookMarked} label="Saved prompts" tipSide="top" />}
        />
        <IconButton size="sm" icon={Type} label={formatBar ? 'Hide formatting' : 'Formatting'} active={formatBar} onClick={() => setFormatBar(!formatBar)} tipSide="top" />
        <IconButton size="sm" icon={preview ? EyeOff : Eye} label={preview ? 'Edit' : 'Preview'} active={preview} onClick={() => setPreview(!preview)} tipSide="top" />

        <button
          type="button"
          className={cx('send-btn', instruction ? 'is-instruction' : 'is-discussion')}
          onClick={() => submit(kind)}
          disabled={empty || tooLong || sending}
          aria-busy={sending}
          aria-label={sending ? 'Sending' : sendLabel}
          data-tip={`${sendLabel}  ↵`}
          data-tip-side="top"
        >
          {sending ? <span className="spinner" style={{ width: 14, height: 14 }} aria-hidden /> : instruction ? <ArrowUp size={16} strokeWidth={2.2} aria-hidden /> : <MessageCircle size={15} strokeWidth={2} aria-hidden />}
        </button>
      </div>

      <div className="composer-hints" aria-hidden>
        <span><Kbd keys="Enter" /> {instruction ? (running ? 'queue' : 'send') : 'send to team'}</span>
        <span><Kbd keys="Shift+Enter" /> new line</span>
        <span><Kbd keys="Mod+Enter" /> send to {instruction ? 'team' : 'agent'} instead</span>
      </div>
    </div>
  );
}
