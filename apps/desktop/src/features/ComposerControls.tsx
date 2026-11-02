// The composer's run settings, side by side like a chat app: which model, how much effort, how much
// access, plus prompts you've saved. They belong to the host; teammates don't see them.
import { useEffect, useState } from 'react';
import { BookMarked, Check, Globe, ChevronDown, Gauge, Hand, Infinity as InfinityIcon, Lock, LockOpen, Plus, Settings2, ShieldCheck, Trash2 } from 'lucide-react';
import { getBridge } from '../bridge/client';
import type { AccessLevel } from '../bridge/execution';
import type { InferenceModel } from '../bridge/inference';
import { useApp } from '../model/store';
import { DRAFT_LIMIT } from '../model/composer';
import * as execution from '../live/execution';
import { Button, Dialog, IconButton, Menu, cx } from '../ui/primitives';

/** Re-renders when the selection, connections, effort or new-chat access change. */
function useExecutionState<T>(read: () => T): T {
  const [value, setValue] = useState(read);
  useEffect(() => {
    const update = () => setValue(read);
    update();
    window.addEventListener('multai:selection-changed', update);
    return () => window.removeEventListener('multai:selection-changed', update);
    // read is a stable module function for each caller.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return value;
}

/* ---------------------------------------------------------------- Model */

export function ModelPicker() {
  const accountId = useApp((s) => s.account?.id);
  const selection = useExecutionState(execution.getSelection);
  const connections = useExecutionState(execution.getConnections);
  const [models, setModels] = useState<Record<string, InferenceModel[]>>({});
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);
  const app = useApp.getState();
  useEffect(() => {
    const inference = getBridge()?.inference;
    setModels({});
    setFailed(false);
    setLoading(Boolean(inference && connections.length));
    if (!inference) return;
    let current = true;
    void Promise.all(connections.map(async (connection) => {
      try {
        const result = await inference.models(connection.id);
        if (!current || useApp.getState().account?.id !== accountId) return;
        if (!result.ok) { setFailed(true); return; }
        setModels((previous) => ({ ...previous, [connection.id]: result.value }));
      } catch { if (current && useApp.getState().account?.id === accountId) setFailed(true); }
    })).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [connections.map((c) => c.id).join(), accountId, retry]);

  const label = selection ? prettyModel(selection.modelName ?? selection.model) : 'Choose model';
  const items = connections.flatMap((connection) => [
    ...(connections.length > 1 ? [{ id: `h-${connection.id}`, separator: true as const, label: connection.name }] : []),
    ...(models[connection.id] ?? []).map((model) => ({
      id: `${connection.id}:${model.id}`,
      label: prettyModel(model.name || model.id),
      checked: selection?.connectionId === connection.id && selection.model === model.id,
      onSelect: () => void execution.selectConnection(connection.id, model.id, model.name, true),
    })),
  ]);
  return (
    <Menu
      label="Model"
      side="top"
      align="end"
      width={260}
      items={[
        ...items,
        ...(loading ? [{ id: 'loading', label: 'Loading models…', disabled: 'Models are loading' }] : []),
        ...(failed ? [{ id: 'retry', label: 'Retry loading models', onSelect: () => setRetry((value) => value + 1) }] : []),
        ...(items.length ? [{ id: 'sep', separator: true as const }] : []),
        { id: 'manage', label: connections.length ? 'Manage AI connections…' : 'Connect an AI provider…', icon: Settings2, onSelect: () => app.openOverlay('settings', 'models') },
      ]}
      trigger={(t) => (
        <button type="button" {...t} aria-label={`Model: ${label}`} className={cx('composer-pick composer-model-pick', !selection && 'is-empty')} data-tip="Model" data-tip-side="top">
          {selection && /muse/i.test(selection.model) && <InfinityIcon className="meta-mark" size={16} strokeWidth={2} aria-hidden />}
          <span className="truncate">{label}</span>
          <ChevronDown size={13} aria-hidden />
        </button>
      )}
    />
  );
}

/** muse-spark-1.3 → Muse Spark 1.3; other ids pass through. */
function prettyModel(id: string): string {
  const muse = /^muse-([a-z]+)-([\d.]+)$/i.exec(id);
  return muse ? `Muse ${muse[1]![0]!.toUpperCase()}${muse[1]!.slice(1)} ${muse[2]}` : id;
}


/* ---------------------------------------------------------------- Effort */

const EFFORT: Record<execution.Effort, { label: string; description: string }> = {
  low: { label: 'Low', description: 'Fastest. Quick answers and small edits.' },
  medium: { label: 'Medium', description: 'Balanced for most tasks.' },
  high: { label: 'High', description: 'Thinks longer for harder problems.' },
  xhigh: { label: 'Very high', description: 'Deep reasoning and more steps for complex work.' },
  max: { label: 'Max', description: 'The most thinking, steps and time. Slowest and uses the most tokens.' },
};

export function EffortPicker() {
  const effort = useExecutionState(execution.getEffort);
  return (
    <Menu
      label="Reasoning"
      side="top"
      align="end"
      width={280}
      items={(['low', 'medium', 'high', 'xhigh', 'max'] as const).map((id) => ({
        id, label: EFFORT[id].label, description: EFFORT[id].description, checked: id === effort,
        onSelect: () => execution.setEffort(id),
      }))}
      trigger={(t) => (
        <button type="button" {...t} aria-label={`Reasoning: ${EFFORT[effort].label}`} className="composer-pick composer-effort-pick" data-tip="Reasoning" data-tip-side="top">
          <Gauge size={14} strokeWidth={1.8} aria-hidden />
          <span>{EFFORT[effort].label}</span>
          <ChevronDown size={13} aria-hidden />
        </button>
      )}
    />
  );
}

/* ---------------------------------------------------------------- Access */

export const ACCESS = {
  ask: { icon: Hand, label: 'Ask for approval', short: 'Ask first', description: 'Every file change and command waits for you' },
  auto: { icon: ShieldCheck, label: 'Approve for me', short: 'Auto', description: 'Only ask for actions that look unsafe' },
  full: { icon: LockOpen, label: 'Full access', short: 'Full access', description: 'Everything runs without asking, including teammates’ requests' },
} as const;

/** Host-only: how much the shared agent may do on this computer without asking. */
export function AccessPicker({ sessionId }: { sessionId: string | null }) {
  const stored = useApp((s) => (sessionId ? s.access[sessionId] : undefined) ?? 'ask');
  const pending = useExecutionState(execution.getNewChatAccess);
  const level: AccessLevel = sessionId ? stored : pending;
  const Icon = level === 'ask' ? Lock : ACCESS[level].icon;
  const web = Boolean(useExecutionState(execution.getWebSearchChoices)[sessionId ?? 'new']);
  const webSupported = useExecutionState(execution.webSearchSupported);
  return (
    <Menu
      label="Agent access"
      side="top"
      align="end"
      width={300}
      items={[
        ...(['ask', 'auto', 'full'] as const).map((id) => ({
          id, label: ACCESS[id].label, icon: ACCESS[id].icon, description: ACCESS[id].description, checked: id === level, danger: id === 'full',
          onSelect: () => void (sessionId ? execution.setAccessLevel(sessionId, id) : execution.chooseNewChatAccess(id)),
        })),
        { id: 'sep', separator: true as const },
        {
          id: 'web', label: 'Allow web search', icon: Globe, checked: web && webSupported,
          description: webSupported ? 'The model’s provider searches the web itself, so searches aren’t approved one by one. Replies cite their sources.' : 'This provider doesn’t offer its own web search. Choose Muse, GPT or Claude to use it.',
          disabled: (webSupported ? false : 'Not available for this model') as string | false,
          onSelect: () => execution.setWebSearch(sessionId, !web),
        },
      ]}
      trigger={(t) => (
        <button type="button" {...t} aria-label={`Agent access: ${ACCESS[level].label}`} className={cx('composer-pick composer-access-pick', level === 'full' && 'is-full')} data-tip="Agent access" data-tip-side="top">
          <Icon size={14} strokeWidth={1.8} aria-hidden />
          <span>{ACCESS[level].short}</span>
          <ChevronDown size={13} aria-hidden />
        </button>
      )}
    />
  );
}

/* ---------------------------------------------------------------- Saved prompts */

export interface SavedPrompt { id: string; label: string; text: string }
const STARTER_PROMPTS: SavedPrompt[] = [
  { id: 'review', label: 'Review the current diff', text: 'Review the current changes for correctness and edge cases. List concrete problems with file and line, most severe first. Don’t change any files yet.' },
  { id: 'tests', label: 'Write tests first', text: 'Before changing behavior, add failing tests that describe the expected result, then make them pass with the smallest change.' },
  { id: 'explain', label: 'Explain for a teammate', text: 'Summarize what this session has done so far for a teammate who just joined: objective, decisions, current state and what’s next.' },
];
const promptsKey = () => `multai.prompts.v1:${useApp.getState().account?.id ?? 'signed-out'}`;
export function readPrompts(): SavedPrompt[] {
  try {
    const raw = localStorage.getItem(promptsKey());
    const value = raw ? JSON.parse(raw) as unknown : null;
    return Array.isArray(value) ? value.filter((p): p is SavedPrompt => typeof p?.id === 'string' && typeof p.label === 'string' && typeof p.text === 'string' && p.text.length <= DRAFT_LIMIT).slice(0, 50) : STARTER_PROMPTS;
  } catch { return STARTER_PROMPTS; }
}
function writePrompts(prompts: SavedPrompt[]): boolean {
  try { localStorage.setItem(promptsKey(), JSON.stringify(prompts.slice(0, 50))); return true; } catch { useApp.getState().toast('Prompts couldn’t be saved on this device.', 'error'); return false; }
}

export function SavedPrompts({ text, onInsert }: { text: string; onInsert: (text: string) => void }) {
  const accountId = useApp((s) => s.account?.id);
  const [prompts, setPrompts] = useState(readPrompts);
  const [managing, setManaging] = useState(false);
  useEffect(() => { setPrompts(readPrompts()); setManaging(false); }, [accountId]);
  const save = () => {
    const body = text.trim();
    if (!body) return;
    if (body.length > DRAFT_LIMIT) { useApp.getState().toast('Shorten the draft before saving it as a prompt.', 'error'); return; }
    const label = body.split('\n')[0]!.slice(0, 48) + (body.length > 48 ? '…' : '');
    const next = [{ id: crypto.randomUUID(), label, text: body }, ...prompts.filter((p) => p.text !== body)].slice(0, 50);
    if (writePrompts(next)) { setPrompts(next); useApp.getState().toast('Prompt saved.', 'success'); }
  };
  const remove = (id: string) => { const next = prompts.filter((p) => p.id !== id); if (writePrompts(next)) setPrompts(next); };
  return (
    <>
      <Menu
        label="Saved prompts"
        side="top"
        align="start"
        width={300}
        items={[
          ...prompts.map((p) => ({ id: p.id, label: p.label, onSelect: () => onInsert(p.text) })),
          ...(prompts.length ? [{ id: 'sep', separator: true as const }] : []),
          { id: 'save', label: 'Save this draft as a prompt', icon: Plus, disabled: (text.trim() ? false : 'Write something first') as string | false, onSelect: save },
          ...(prompts.length ? [{ id: 'manage', label: 'Manage prompts…', icon: Settings2, onSelect: () => setManaging(true) }] : []),
        ]}
        trigger={(t) => <IconButton {...t} size="sm" icon={BookMarked} label="Saved prompts" tipSide="top" />}
      />
      <Dialog open={managing} onClose={() => setManaging(false)} title="Saved prompts" description="Saved on this device for your account. Choosing one inserts it into your draft.">
        <div className="dialog-body">
          <ul className="prompt-list">
            {prompts.map((p) => (
              <li key={p.id}>
                <div className="prompt-item">
                  <strong className="truncate">{p.label}</strong>
                  <span className="field-help prompt-text">{p.text}</span>
                </div>
                <IconButton size="sm" icon={Trash2} label={`Delete “${p.label}”`} onClick={() => remove(p.id)} />
              </li>
            ))}
            {!prompts.length && <li className="field-help">No saved prompts. Write a draft and choose “Save this draft as a prompt”.</li>}
          </ul>
          <div className="form-actions"><Button variant="primary" icon={Check} onClick={() => setManaging(false)}>Done</Button></div>
        </div>
      </Dialog>
    </>
  );
}
