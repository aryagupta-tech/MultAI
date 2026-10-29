import { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, CircleAlert, Eye, EyeOff, KeyRound, Loader2, Lock, MessageSquareText, RefreshCw, Trash2, X } from 'lucide-react';
import type { ConnectionSummary, InferenceConnectionsApi, InferenceModel } from '../bridge/inference';
import type { ServiceError } from '../bridge/contract';
import { getSelection } from '../live/execution';
import { Button, cx } from '../ui/primitives';
import {
  KEY_MAX, MAX_CONNECTIONS, NAME_MAX, PROVIDERS, URL_MAX, canSubmit, formErrors, hostOf, statusLabel, toInput,
  type ApiProvider, type FormState,
} from './connectionForm';
import '../styles/connections.css';
import {ChatGPTPlanUsage,ChatGPTPlanWelcome,isChatGPTUsageLimit} from './ChatGPTPlanUsage';

// AI connection setup: ChatGPT sign-in or API keys, model choice and removal.

type Method = 'chatgpt' | 'api';
type Notice = { text: string; tone: 'error' | 'warn' } | null;

const PROVIDER_BADGE: Record<ConnectionSummary['provider'], string> = { chatgpt: 'GPT', openai: 'OAI', anthropic: 'CL', kimi: 'KI', compatible: 'API' };
const emptyForm = (provider: ApiProvider = 'openai'): FormState => ({ provider, name: '', apiKey: '', baseUrl: '' });

function noticeFrom(error: ServiceError): Notice {
  // Removal succeeded locally even when remote revocation couldn't be confirmed: that's a warning.
  return { text: error.message, tone: error.code === 'remote_revocation_unconfirmed' ? 'warn' : 'error' };
}

export function AiConnections({ api, onSelect }: { api: InferenceConnectionsApi; onSelect?(connectionId: string, model: InferenceModel): void }) {
  const [connections, setConnections] = useState<ConnectionSummary[] | null>(null);
  const [method, setMethod] = useState<Method>('chatgpt');
  const [form, setForm] = useState<FormState>(emptyForm());
  const [touched, setTouched] = useState<Partial<Record<keyof FormState, boolean>>>({});
  const [showKey, setShowKey] = useState(false);
  const [models, setModels] = useState<Record<string, InferenceModel[]>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice>(null);
  const [usageLimited,setUsageLimited]=useState(false);
  const report=(failure:ServiceError)=>{setNotice(noticeFrom(failure));setUsageLimited(isChatGPTUsageLimit(failure.code));};
  const [selection, setSelection] = useState(getSelection);
  const mounted = useRef(true);
  const id = useId();

  const refresh = async () => {
    const listed = await api.list();
    if (!mounted.current) return;
    if (listed.ok) setConnections(listed.value);
    else { setConnections((c) => c ?? []); setNotice(noticeFrom(listed.error)); }
  };

  useEffect(() => {
    mounted.current = true;
    void refresh();
    const unsubscribe = api.onConnectionsChange((next) => {
      if (!mounted.current) return;
      setConnections(next);
      // Catalogs belong to the previous connection set; drop any that no longer apply.
      setModels((m) => Object.fromEntries(Object.entries(m).filter(([cid]) => next.some((c) => c.id === cid && c.status === 'ready'))));
    });
    const onSelection = () => { if (mounted.current) setSelection(getSelection()); };
    window.addEventListener('multai:selection-changed', onSelection);
    return () => {
      mounted.current = false;
      unsubscribe();
      window.removeEventListener('multai:selection-changed', onSelection);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api]);

  const errors = formErrors(form);
  const full = (connections?.length ?? 0) >= MAX_CONNECTIONS;
  const set = (patch: Partial<FormState>) => setForm((f) => ({ ...f, ...patch }));

  async function add() {
    if (!canSubmit(form) || busy) return;
    setBusy('add');
    setNotice(null);
    setUsageLimited(false);
    try {
      const result = await api.add(toInput(form));
      if (!mounted.current) return;
      if (result.ok) {
        setForm(emptyForm(form.provider));
        setTouched({});
        await refresh();
      } else {
        report(result.error);
      }
    } catch {
      if (mounted.current) setNotice({ text: 'The app couldn’t save this connection. Try again.', tone: 'error' });
    } finally {
      // Never keep an entered secret around after a submission, whatever the outcome.
      if (mounted.current) { setForm((f) => ({ ...f, apiKey: '' })); setShowKey(false); setBusy(null); }
    }
  }

  async function chatgpt(connectionId?: string) {
    if (busy) return;
    setBusy(connectionId ? `chatgpt:${connectionId}` : 'chatgpt');
    setNotice(null);
    setUsageLimited(false);
    try {
      const result = await api.connectChatGPT(connectionId);
      if (!mounted.current) return;
      if (!result.ok) { if (result.error.code !== 'canceled') report(result.error); }
      else await refresh();
    } catch {
      if (mounted.current) setNotice({ text: 'The app couldn’t complete ChatGPT sign-in. Try again.', tone: 'error' });
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  async function discover(connectionId: string) {
    if (busy) return;
    setBusy(`models:${connectionId}`);
    setNotice(null);
    setUsageLimited(false);
    try {
      const result = await api.models(connectionId);
      if (!mounted.current) return;
      if (result.ok) setModels((m) => ({ ...m, [connectionId]: result.value }));
      else report(result.error);
    } catch {
      if (mounted.current) setNotice({ text: 'The app couldn’t load this model list. Try again.', tone: 'error' });
    } finally {
      if (mounted.current) setBusy(null);
    }
  }

  async function remove(connectionId: string) {
    if (busy) return;
    setBusy(`remove:${connectionId}`);
    setNotice(null);
    setUsageLimited(false);
    try {
      const result = await api.remove(connectionId);
      if (!mounted.current) return;
      if (!result.ok) report(result.error);
      setModels((m) => { const next = { ...m }; delete next[connectionId]; return next; });
      await refresh();
    } catch {
      if (mounted.current) setNotice({ text: 'The app couldn’t remove this connection. Try again.', tone: 'error' });
    } finally {
      if (mounted.current) { setBusy(null); setConfirmRemove(null); }
    }
  }

  const provider = PROVIDERS.find((p) => p.id === form.provider) ?? PROVIDERS[0]!;
  const show = (field: keyof FormState) => Boolean(touched[field]) || (field === 'apiKey' && Boolean(form.apiKey));

  return (
    <section className="conn" aria-label="AI connections">
      <div className="conn-methods" role="radiogroup" aria-label="How to connect">
        {([
          ['chatgpt', MessageSquareText, 'ChatGPT account', 'Use your ChatGPT plan. Signs in through your browser.'],
          ['api', KeyRound, 'API key', 'OpenAI, Claude, Kimi or a compatible provider.'],
        ] as const).map(([value, Icon, title, desc]) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={method === value}
            className={cx('conn-method', method === value && 'is-selected')}
            onClick={() => setMethod(value)}
            disabled={busy === 'chatgpt' && value !== 'chatgpt'}
          >
            <span className="conn-method-icon"><Icon size={16} strokeWidth={1.8} aria-hidden /></span>
            <span className="conn-method-text"><span className="conn-method-title">{title}</span><span className="conn-method-desc">{desc}</span></span>
            <span className="conn-radio" aria-hidden>{method === value && <Check size={10} strokeWidth={3} />}</span>
          </button>
        ))}
      </div>

      {method === 'chatgpt' ? (
        <div className="conn-panel">
          {busy === 'chatgpt' ? (
            <div className="conn-waiting" role="status">
              <Loader2 size={16} className="spin" aria-hidden />
              <span>Waiting for ChatGPT in your browser…</span>
              <Button size="sm" variant="ghost" onClick={() => void api.cancelChatGPT()}>Cancel</Button>
            </div>
          ) : (
            <>
              <p className="conn-note">You’ll approve access in your browser. Plan usage needs an eligible ChatGPT account. Your Google sign-in for MultAI stays separate.</p>
              <Button variant="primary" className="btn-block" onClick={() => void chatgpt()} disabled={busy !== null || full}>Continue with ChatGPT</Button>
            </>
          )}
        </div>
      ) : (
        <form className="conn-panel" noValidate onSubmit={(e) => { e.preventDefault(); void add(); }}>
          <div className="conn-field">
            <span className="conn-label" id={`${id}-prov`}>Provider</span>
            <div className="conn-providers" role="radiogroup" aria-labelledby={`${id}-prov`}>
              {PROVIDERS.map((p) => (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={form.provider === p.id}
                  className={cx('conn-provider', form.provider === p.id && 'is-selected')}
                  onClick={() => set({ provider: p.id })}
                  disabled={busy !== null}
                >
                  {p.label}
                </button>
              ))}
            </div>
            <span className="conn-help">{form.provider === 'compatible' ? 'Any OpenAI-compatible API over HTTPS.' : `Connects to ${provider.host}.`}</span>
          </div>

          {form.provider === 'compatible' && (
            <label className="conn-field">
              <span className="conn-label">API base URL</span>
              <input
                value={form.baseUrl}
                onChange={(e) => set({ baseUrl: e.target.value })}
                onBlur={() => setTouched((t) => ({ ...t, baseUrl: true }))}
                placeholder="https://provider.example/v1"
                type="url"
                inputMode="url"
                autoComplete="off"
                spellCheck={false}
                maxLength={URL_MAX}
                disabled={busy !== null}
                aria-invalid={Boolean(show('baseUrl') && errors.baseUrl)}
                aria-describedby={`${id}-url-err`}
              />
              {show('baseUrl') && errors.baseUrl && <span className="conn-error" id={`${id}-url-err`}>{errors.baseUrl}</span>}
            </label>
          )}

          <label className="conn-field">
            <span className="conn-label">API key</span>
            <span className="conn-secret">
              <input
                value={form.apiKey}
                onChange={(e) => set({ apiKey: e.target.value })}
                onBlur={() => setTouched((t) => ({ ...t, apiKey: true }))}
                type={showKey ? 'text' : 'password'}
                placeholder={provider.keyHint}
                autoComplete="off"
                spellCheck={false}
                maxLength={KEY_MAX + 1}
                disabled={busy !== null}
                aria-invalid={Boolean(show('apiKey') && errors.apiKey)}
                aria-describedby={`${id}-key-err`}
              />
              <button type="button" className="conn-eye" aria-label={showKey ? 'Hide key' : 'Show key'} aria-pressed={showKey} onClick={() => setShowKey((v) => !v)}>
                {showKey ? <EyeOff size={15} aria-hidden /> : <Eye size={15} aria-hidden />}
              </button>
            </span>
            {show('apiKey') && errors.apiKey && <span className="conn-error" id={`${id}-key-err`}>{errors.apiKey}</span>}
          </label>

          <label className="conn-field">
            <span className="conn-label">Name <span className="conn-optional">optional</span></span>
            <input
              value={form.name}
              onChange={(e) => set({ name: e.target.value })}
              placeholder={form.provider === 'compatible' ? 'Compatible API' : provider.label}
              autoComplete="off"
              maxLength={NAME_MAX + 1}
              disabled={busy !== null}
              aria-invalid={Boolean(errors.name)}
            />
            {errors.name && <span className="conn-error">{errors.name}</span>}
          </label>

          <Button type="submit" variant="primary" className="btn-block" disabled={busy !== null || !canSubmit(form) || full}>
            {busy === 'add' ? 'Saving…' : 'Save connection'}
          </Button>
        </form>
      )}

      {full && <p className="conn-help">You’ve reached {MAX_CONNECTIONS} connections. Remove one to add another.</p>}

      {notice && (
        <div className={cx('conn-notice', `is-${notice.tone}`)} role="alert">
          <CircleAlert size={14} aria-hidden />
          <span>{notice.text}</span>
          <button type="button" aria-label="Dismiss" onClick={() => setNotice(null)}><X size={12} /></button>
        </div>
      )}
      {usageLimited&&<ChatGPTPlanUsage api={api} limited/>}

      <div className="conn-list-head">
        <span>Your connections</span>
        {connections && connections.length > 0 && <span className="conn-count">{connections.length}</span>}
      </div>

      {connections === null ? (
        <div className="conn-empty" role="status"><Loader2 size={14} className="spin" aria-hidden /> Loading connections…</div>
      ) : connections.length === 0 ? (
        <div className="conn-empty">No connections yet. Add one above, or set it up later from Settings.</div>
      ) : (
        <ul className="conn-list">
          {connections.map((c) => {
            const status = statusLabel(c.status);
            const inUse = selection?.connectionId === c.id;
            const list = models[c.id];
            return (
              <li key={c.id} className={cx('conn-item', inUse && 'is-in-use')}>
                <div className="conn-item-head">
                  <span className={cx('conn-badge', `is-${c.provider}`)} aria-hidden>{PROVIDER_BADGE[c.provider]}</span>
                  <div className="conn-item-main">
                    <span className="conn-item-name" title={c.name}>{c.name}</span>
                    <span className="conn-item-sub">{c.accountLabel ? `${c.accountLabel} · ` : ''}{hostOf(c.baseUrl)}</span>
                  </div>
                  {inUse && <span className="conn-pill is-accent">In use</span>}
                  <span className={cx('conn-pill', `is-${status.tone}`)}>{status.text}</span>
                </div>

                {inUse && selection && <p className="conn-in-use">Model: <strong>{selection.modelName ?? selection.model}</strong></p>}
                {c.provider==='chatgpt'&&c.status==='ready'&&<ChatGPTPlanUsage api={api} active={inUse}/>}

                {list && (list.length ? (
                  <label className="conn-model">
                    <span className="sr-only">Model for {c.name}</span>
                    <select
                      value={inUse ? selection?.model ?? '' : ''}
                      onChange={(e) => {
                        const model = list.find((m) => m.id === e.target.value);
                        if (model) onSelect?.(c.id, model);
                      }}
                    >
                      <option value="" disabled>Choose a model…</option>
                      {list.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
                    </select>
                    <ChevronDown size={14} aria-hidden />
                  </label>
                ) : <p className="conn-help">This provider didn’t return any models you can use.</p>)}

                {confirmRemove === c.id ? (
                  <div className="conn-confirm" role="group" aria-label={`Remove ${c.name}?`}>
                    <span>Remove “{c.name}”? Its saved credentials are deleted from this computer.</span>
                    <div className="conn-actions">
                      <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(null)} disabled={busy !== null}>Keep</Button>
                      <Button size="sm" variant="danger" icon={Trash2} onClick={() => void remove(c.id)} disabled={busy !== null}>
                        {busy === `remove:${c.id}` ? 'Removing…' : 'Remove'}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <div className="conn-actions">
                    {c.provider === 'chatgpt' && c.status !== 'ready' ? (
                      <Button size="sm" variant="secondary" icon={RefreshCw} onClick={() => void chatgpt(c.id)} disabled={busy !== null}>
                        {busy === `chatgpt:${c.id}` ? 'Waiting for browser…' : 'Reconnect'}
                      </Button>
                    ) : (
                      <Button size="sm" variant="secondary" onClick={() => void discover(c.id)} disabled={busy !== null}>
                        {busy === `models:${c.id}` ? 'Loading models…' : list ? 'Refresh models' : inUse ? 'Change model' : 'Choose a model'}
                      </Button>
                    )}
                    <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(c.id)} disabled={busy !== null}>Remove</Button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <p className="conn-privacy"><Lock size={12} aria-hidden /> Credentials are encrypted on this computer and never shown to teammates. Connecting or choosing a model never starts a task.</p>
      <ChatGPTPlanWelcome api={api} connections={connections??[]}/>
    </section>
  );
}
