import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import {
  ArrowUp, BookMarked, BookOpen, CircleHelp, FileCode2, FileText, FlaskConical, Folder, GitCompare, GitPullRequestArrow, Hammer,
  ImagePlus, ListChecks, Loader2, Mic, ScanSearch, Lock, MessageCircle, Minimize2, Plus, SearchCheck, Sparkles, Split, SquareTerminal, Square, Undo2, WandSparkles, X, type LucideIcon,
} from 'lucide-react';
import { useApp } from '../model/store';
import { DRAFT_LIMIT, applyFormat, draftMeter, resolveEnter, type FormatKind } from '../model/composer';
import { COMMANDS, commandNamed, parseSlash, replaceTrigger, shellCommand, triggerAt, withFolders } from '../model/commands';
import { fuzzyScore } from '../model/fuzzy';
import type { MessageKind, SessionDetail } from '../model/types';
import { IconButton, cx } from '../ui/primitives';
import { AccessPicker, EffortPicker, ModelPicker, SavedPrompts, readPrompts } from './ComposerControls';
import { ComposerSuggest, SUGGEST_LIST_ID, caretLeft, suggestOptionId, type SuggestItem } from './ComposerSuggest';
import { ContextMeter } from './ContextMeter';
import { isImage, toScreenshot } from './screenshot';
import { filesFor, loadFiles, loadSkills, runAppCommand, runShortcutCommand, skillsFor, subscribeAssist, useAssist } from '../live/assist';
import { useWork } from '../live/work';
import { reportTyping, stopTyping } from '../live/presence';
import { cancelVoice, toggleVoice, useVoice } from '../live/voice';

/** Record a voice instruction; the host's Meta or OpenAI connection turns it into text in the draft. */
function VoiceButton({ draftKey, disabled }: { draftKey: string; disabled: boolean }) {
  const recording = useVoice((s) => s.recording === draftKey);
  const busy = useVoice((s) => s.busy === draftKey);
  const startedAt = useVoice((s) => s.startedAt);
  const [, tick] = useState(0);
  useEffect(() => {
    if (!recording) return;
    const timer = setInterval(() => tick((n) => n + 1), 500);
    const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === 'Escape') cancelVoice(); };
    window.addEventListener('keydown', onKey);
    return () => { clearInterval(timer); window.removeEventListener('keydown', onKey); };
  }, [recording]);
  useEffect(() => () => { if (useVoice.getState().recording === draftKey) cancelVoice(); }, [draftKey]);
  const seconds = Math.floor((Date.now() - startedAt) / 1000);
  if (busy) return <span className="voice-state" aria-live="polite"><Loader2 size={13} className="spin" aria-hidden /> Transcribing…</span>;
  return (
    <>
      <IconButton size="sm" icon={recording ? Square : Mic} label={recording ? 'Stop and transcribe' : 'Speak an instruction'} tipSide="top" active={recording}
        className={cx(recording && 'is-recording')} onClick={() => toggleVoice(draftKey)} disabled={disabled} />
      {recording && <span className="voice-state is-live" aria-live="polite"><span className="voice-dot" aria-hidden />{`${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`} · Esc to cancel</span>}
    </>
  );
}

/** “Ana is typing…” for teammates typing in this session right now. */
function TypingIndicator({ d }: { d: SessionDetail }) {
  const me = useApp((s) => s.account?.id);
  const names = d.participants.filter((p) => p.typing && p.id !== me).map((p) => p.name);
  if (!names.length) return null;
  const who = names.length === 1 ? names[0] : names.length === 2 ? `${names[0]} and ${names[1]}` : `${names[0]} and ${names.length - 1} others`;
  return <div className="typing-indicator" aria-live="polite"><span className="typing-dots" aria-hidden><i /><i /><i /></span>{who} {names.length === 1 ? 'is' : 'are'} typing…</div>;
}

const COMMAND_ICONS: Record<string, LucideIcon> = {
  plan: ListChecks, build: Hammer, review: SearchCheck, test: FlaskConical, explain: BookOpen, init: FileCode2, compact: Minimize2, undo: Undo2,
  split: Split, diff: GitCompare, terminal: SquareTerminal, pr: GitPullRequestArrow, brief: Sparkles, skills: WandSparkles, new: Plus, help: CircleHelp,
};
const MAX_FILE_ITEMS = 60;

/** Fuzzy-filters by `key`, best first, keeping match positions for highlighting. */
function ranked<T>(items: readonly T[], query: string, key: (item: T) => string, limit = Infinity): { item: T; indices: number[] }[] {
  const out: { item: T; indices: number[]; score: number }[] = [];
  for (const item of items) {
    const match = fuzzyScore(query, key(item));
    if (match) out.push({ item, indices: match.indices, score: match.score });
  }
  if (query) out.sort((a, b) => b.score - a.score);
  return out.slice(0, limit);
}


/** The main composer talks to the agent; the team panel's composer (team) talks to people. */
export function Composer({ d, draftKey, autoFocus, team = false }: { d: SessionDetail | null; draftKey: string; autoFocus?: boolean; team?: boolean }) {
  const draft = useApp((s) => s.drafts[draftKey]);
  const account = useApp((s) => s.account);
  const sending = useApp((s) => Boolean(s.sending[draftKey]));
  const app = useApp.getState();
  const text = draft?.text ?? '';
  const kind: MessageKind = team ? 'discussion' : 'instruction';
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
  const [caret, setCaret] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [active, setActive] = useState(0);
  const newProject = useApp((s) => s.draftTarget.projectId);
  const projectId = !d && newProject && !newProject.startsWith('p-') ? newProject : null;
  const inProject = useWork((s) => Boolean(d && s.summary[d.id]));

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
  useEffect(() => { subscribeAssist(); }, []);

  useEffect(() => {
    const focus = () => ta.current?.focus();
    const name = team ? 'multai:focus-team' : 'multai:focus-composer';
    window.addEventListener(name, focus);
    return () => window.removeEventListener(name, focus);
  }, [team]);

  // Model, effort and access are the host's run settings; teammates don't choose them.
  const hostControls = live && (!d || (d.source === 'live' && d.capabilities.configure));
  const sessionId = d?.id ?? null;
  const trigger = !team && canSubmit ? triggerAt(text, caret) : null;
  const triggerKey = trigger ? `${trigger.kind}:${trigger.start}` : null;
  const files = useAssist((s) => filesFor(s, sessionId, projectId));
  const skills = useAssist((s) => skillsFor(s, sessionId, projectId));
  const mentions = trigger?.kind === 'mention' && hostControls;
  useEffect(() => {
    if (mentions) void loadFiles(sessionId, projectId);
    if (trigger?.kind === 'slash' && hostControls) void loadSkills(sessionId, projectId);
  }, [triggerKey, mentions, hostControls, sessionId, projectId]);
  useEffect(() => { setActive(0); }, [triggerKey, trigger?.query]);

  const suggestions = useMemo<SuggestItem[]>(() => {
    if (!trigger || triggerKey === dismissed) return [];
    const query = trigger.query;
    if (trigger.kind === 'mention') {
      if (!hostControls) return [];
      const codebase = fuzzyScore(query, 'codebase');
      return [
        ...(codebase && !query.includes('/') ? [{ id: 'file:codebase', label: 'codebase', detail: 'The code most related to your request', icon: ScanSearch, group: 'Search', indices: codebase.indices }] : []),
        ...ranked(withFolders(files?.files ?? []), query, (path) => path, MAX_FILE_ITEMS).map(({ item, indices }) => ({
          id: `file:${item}`, label: item, icon: item.endsWith('/') ? Folder : FileText, group: 'Files', indices,
        })),
      ];
    }
    const commands = COMMANDS.filter((command) => (hostControls || command.kind === 'agent') && (!command.session || d) && (!command.project || inProject));
    return [
      ...ranked(commands, query, (command) => command.name).map(({ item, indices }) => ({
        id: `cmd:${item.name}`, label: `/${item.name}`, detail: item.description, icon: COMMAND_ICONS[item.name] ?? Sparkles, group: 'Commands', indices: indices.map((i) => i + 1),
      })),
      ...(hostControls ? ranked(skills ?? [], query, (skill) => skill.name).map(({ item, indices }) => ({
        id: `skill:${item.name}`, label: `/${item.name}`, detail: item.description, icon: WandSparkles, group: item.source === 'project' ? 'Project skills' : 'Your skills', indices: indices.map((i) => i + 1),
      })) : []),
      ...ranked(readPrompts(), query, (prompt) => prompt.label).slice(0, 8).map(({ item, indices }) => ({
        id: `prompt:${item.id}`, label: item.label, detail: 'Saved prompt', icon: BookMarked, group: 'Saved prompts', indices,
      })),
    ];
  }, [trigger?.kind, trigger?.query, triggerKey, dismissed, files, skills, hostControls, d, inProject]);
  const suggesting = Boolean(trigger && triggerKey !== dismissed && (trigger.kind === 'slash' || hostControls));
  const suggestLeft = useMemo(() => (trigger && ta.current ? Math.max(0, Math.min(caretLeft(ta.current, trigger.start) - 12, (ta.current.clientWidth || 400) - 380)) : 0), [triggerKey]);
  const syncCaret = () => { const el = ta.current; if (el) setCaret(el.selectionEnd); };

  if (d && !canSubmit) {
    return (
      <div className="composer-readonly" role="note">
        <Lock size={14} aria-hidden />
        You’re a viewer in this session. You can read everything, but only collaborators can send messages.
      </div>
    );
  }

  const context = { sessionId, projectId, draftKey };
  const submit = (as: MessageKind) => {
    if (empty || tooLong) return;
    if (as === 'instruction' && !team && hostControls) {
      // `!cmd` runs in the terminal; app commands act here. Agent commands and skills are sent as written.
      const shell = shellCommand(text);
      if (shell) { void runShortcutCommand(sessionId, shell, draftKey); return; }
      const slash = parseSlash(text);
      if (slash && commandNamed(slash.name)?.kind === 'app') { void runAppCommand(slash.name, slash.args, context); return; }
    }
    if (d) stopTyping(d.id);
    app.send(draftKey, as, d?.id ?? draftKey);
  };
  const replaceWith = (insert: string) => {
    if (!trigger) return;
    const next = replaceTrigger(text, trigger, insert);
    pendingSelection.current = [next.caret, next.caret];
    setCaret(next.caret);
    app.setDraft(draftKey, { text: next.text });
  };
  const pick = (item: SuggestItem) => {
    const [type, ...rest] = item.id.split(':');
    const value = rest.join(':');
    if (type === 'file') replaceWith(`@${value}`);
    else if (type === 'skill') replaceWith(`/${value}`);
    else if (type === 'prompt') {
      const prompt = readPrompts().find((p) => p.id === value);
      if (prompt) { pendingSelection.current = [prompt.text.length, prompt.text.length]; setCaret(prompt.text.length); app.setDraft(draftKey, { text: prompt.text }); }
    } else if (type === 'cmd') {
      const command = commandNamed(value);
      if (command?.kind === 'app' && !command.args && hostControls) { setDismissed(triggerKey); void runAppCommand(value, '', context); }
      else replaceWith(`/${value}`);
    }
    requestAnimationFrame(() => ta.current?.focus());
  };
  const insert = (prompt: string) => {
    const next = text ? `${text}\n\n${prompt}` : prompt;
    if (next.length > DRAFT_LIMIT) app.toast('That would make the draft longer than the limit.', 'error');
    else app.setDraft(draftKey, { text: next });
    requestAnimationFrame(() => ta.current?.focus());
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
    if (suggesting && !(e.nativeEvent.isComposing || composing.current)) {
      const count = suggestions.length;
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && count) {
        e.preventDefault();
        setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : count - 1)) % count);
        return;
      }
      if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey && count) {
        e.preventDefault();
        pick(suggestions[Math.min(active, count - 1)]!);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setDismissed(triggerKey);
        return;
      }
    }
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
    : !d ? (hostControls ? 'Describe what you want to build or fix. @ for files, / for commands' : 'Describe what you want to build or fix…')
      : running ? 'Queue a follow-up. Press Steer on it to send it to the agent now…' : hostControls ? 'Tell the agent what to do next. @ for files, / for commands' : 'Tell the agent what to do next…';
  const sendLabel = instruction ? (running ? 'Add to queue' : 'Send to agent') : 'Send to team';

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
      {d && <TypingIndicator d={d} />}
      {suggesting && (
        <ComposerSuggest
          items={suggestions}
          active={active}
          onActive={setActive}
          onPick={pick}
          left={suggestLeft}
          label={trigger?.kind === 'mention' ? 'Files' : 'Commands'}
          empty={trigger?.kind === 'mention' ? (files ? `No files match “${trigger.query}”` : 'Loading files…') : 'No matching commands'}
          footer={trigger?.kind === 'mention' ? (files?.truncated ? 'Showing the first 20,000 files.' : '↑↓ to choose · ↵ or Tab to insert · Esc to close') : '↑↓ to choose · ↵ to run · ! runs a terminal command'}
        />
      )}
      <div className="composer-field">
        <textarea
          ref={ta}
          className="composer-input"
          aria-label={instruction ? 'Instruction to the agent' : 'Message to the team'}
          placeholder={placeholder}
          value={text}
          rows={1}
          spellCheck
          onChange={(e) => { app.setDraft(draftKey, { text: e.target.value }); setCaret(e.target.selectionEnd); if (d) reportTyping(d.id); }}
          onKeyDown={onKeyDown}
          onKeyUp={(e) => { if (e.key.startsWith('Arrow') || e.key === 'Home' || e.key === 'End') syncCaret(); }}
          onClick={syncCaret}
          onBlur={() => setDismissed(triggerKey)}
          onFocus={() => setDismissed(null)}
          role="combobox"
          aria-autocomplete="list"
          aria-expanded={suggesting}
          aria-controls={suggesting ? SUGGEST_LIST_ID : undefined}
          aria-activedescendant={suggesting && suggestions[active] ? suggestOptionId(suggestions[active]) : undefined}
          onPaste={(e) => { const file = fromTransfer(e.clipboardData.items); if (file) { e.preventDefault(); void attach(file); } }}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; }}
        />
      </div>

      <div className="composer-bar">
        <IconButton size="sm" icon={ImagePlus} label="Attach a screenshot" tipSide="top" onClick={() => picker.current?.click()} disabled={!canSubmit} />
        <input ref={picker} type="file" accept="image/png,image/jpeg,image/webp,image/gif,image/heic" hidden onChange={(e) => { const file = e.target.files?.[0]; e.target.value = ''; if (file) void attach(file); }} />
        {!team && <SavedPrompts text={text} onInsert={insert} />}
        <VoiceButton draftKey={draftKey} disabled={!canSubmit} />
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
          {d && <ContextMeter sessionId={d.id} />}
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
