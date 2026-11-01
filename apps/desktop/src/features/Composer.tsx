import { useEffect, useLayoutEffect, useRef, type KeyboardEvent } from 'react';
import { ArrowUp, ImagePlus, ListChecks, Lock, MessageCircle, X } from 'lucide-react';
import { useApp } from '../model/store';
import { DRAFT_LIMIT, applyFormat, draftMeter, resolveEnter, type FormatKind } from '../model/composer';
import type { MessageKind, SessionDetail } from '../model/types';
import { IconButton, cx } from '../ui/primitives';
import { AccessPicker, EffortPicker, ModelPicker, SavedPrompts } from './ComposerControls';
import { isImage, toScreenshot } from './screenshot';


export function Composer({ d, draftKey, autoFocus }: { d: SessionDetail | null; draftKey: string; autoFocus?: boolean }) {
  const draft = useApp((s) => s.drafts[draftKey]);
  const defaultKind = useApp((s) => s.prefs.defaultKind);
  const account = useApp((s) => s.account);
  const sending = useApp((s) => Boolean(s.sending[draftKey]));
  const app = useApp.getState();
  const text = draft?.text ?? '';
  const kind: MessageKind = draft?.kind ?? defaultKind;
  const live = useApp((s) => s.dataMode === 'live');
  const ta = useRef<HTMLTextAreaElement>(null);
  const picker = useRef<HTMLInputElement>(null);
  const image = draft?.image;
  const attach = async (file: Blob) => {
    try { app.setDraft(draftKey, { image: await toScreenshot(file) }); }
    catch (error) { app.toast(error instanceof Error ? error.message : 'That image couldn’t be attached.', 'error'); }
  };
  const fromTransfer = (items: DataTransferItemList | undefined) => [...(items ?? [])].map((item) => item.kind === 'file' ? item.getAsFile() : null).find((file): file is File => Boolean(file && isImage(file)));
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
  }, [text]);

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

  const submit = (as: MessageKind) => {
    if (empty || tooLong) return;
    app.send(draftKey, as);
  };
  const insert = (prompt: string) => {
    const next = text ? `${text}\n\n${prompt}` : prompt;
    if (next.length > DRAFT_LIMIT) app.toast('That would make the draft longer than the limit.', 'error');
    else app.setDraft(draftKey, { text: next });
    requestAnimationFrame(() => ta.current?.focus());
  };
  // Model, effort and access are the host's run settings; teammates don't choose them.
  const hostControls = live && (!d || (d.source === 'live' && d.capabilities.configure));

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
  const placeholder = !instruction
    ? 'Message your team. The agent won’t act on this…'
    : !d ? 'Describe what you want to build or fix…'
      : running ? 'Add a direction. It’s queued for the next safe point…' : 'Tell the agent what to do next…';
  const sendLabel = instruction ? (running ? 'Queue for agent' : 'Send to agent') : 'Send to team';

  return (
    <div
      className={cx('composer', instruction ? 'is-instruction' : 'is-discussion')}
      onDragOver={(e) => { if ([...e.dataTransfer.items].some((i) => i.kind === 'file')) e.preventDefault(); }}
      onDrop={(e) => { const file = fromTransfer(e.dataTransfer.items); if (file) { e.preventDefault(); void attach(file); } }}
    >
      {image && (
        <div className="composer-attachment">
          <img src={image} alt="Attached screenshot" />
          <button type="button" aria-label="Remove screenshot" onClick={() => app.setDraft(draftKey, { image: undefined })}><X size={12} aria-hidden /></button>
        </div>
      )}
      <div className="composer-field">
        {!instruction && <span className="composer-team-tag"><MessageCircle size={12} aria-hidden /> Team</span>}
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
          onPaste={(e) => { const file = fromTransfer(e.clipboardData.items); if (file) { e.preventDefault(); void attach(file); } }}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }}
        />
      </div>

      <div className="composer-bar">
        <IconButton size="sm" icon={ImagePlus} label="Attach a screenshot" tipSide="top" onClick={() => picker.current?.click()} disabled={!canSubmit} />
        <input ref={picker} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/heic" hidden onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void attach(file); }} />
        <SavedPrompts text={text} onInsert={insert} />
        {d?.mode === 'plan' && instruction && (
          <span className="mode-hint" title="Plan mode blocks file writes, shell commands and external actions">
            <ListChecks size={12} aria-hidden /> Plan
          </span>
        )}
        <span className="spacer" />
        {meter.show && (
          <span className={cx('meter', `tone-${meter.tone}`)} aria-live="polite">
            {text.length.toLocaleString()} / {DRAFT_LIMIT.toLocaleString()}
          </span>
        )}
        {hostControls && instruction && <>
          <ModelPicker />
          <EffortPicker />
          <AccessPicker sessionId={d?.id ?? null} />
        </>}

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

    </div>
  );
}
