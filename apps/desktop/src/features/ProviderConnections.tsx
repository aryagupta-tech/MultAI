import {useEffect, useState} from 'react';
import type {AddConnectionInput, ConnectionSummary, InferenceConnectionsApi, InferenceModel} from '../bridge/inference';
import {Button} from '../ui/primitives';
import {ChatGPTPlanUsage,ChatGPTPlanWelcome,isChatGPTUsageLimit} from './ChatGPTPlanUsage';

export function ProviderConnections({api, onSelect}: {api: InferenceConnectionsApi; onSelect?(connectionId: string, model: InferenceModel): void}) {
  const [connections,setConnections] = useState<ConnectionSummary[]>([]);
  const [provider,setProvider] = useState<AddConnectionInput['provider']>('openai');
  const [name,setName] = useState('');
  const [apiKey,setApiKey] = useState('');
  const [baseUrl,setBaseUrl] = useState('');
  const [models,setModels] = useState<Record<string,InferenceModel[]>>({});
  const [busy,setBusy] = useState<string | null>(null);
  const [error,setError] = useState('');
  const [usageLimited,setUsageLimited]=useState(false);
  const report=(failure:{code:string;message:string})=>{setError(failure.message);setUsageLimited(isChatGPTUsageLimit(failure.code));};
  useEffect(() => {
    let active = true;
    void api.list().then(result => {if (active) {if (result.ok) setConnections(result.value); else setError(result.error.message);}});
    const unsubscribe = api.onConnectionsChange(next => {setConnections(next); setModels({});});
    return () => {active = false; unsubscribe();};
  },[api]);
  async function add() {
    setBusy('add'); setError(''); setUsageLimited(false);
    try {
      const result = await api.add({provider,apiKey,...(name.trim() ? {name: name.trim()} : {}),...(provider === 'compatible' ? {baseUrl: baseUrl.trim()} : {})});
      // Do not retain entered secrets after either accepted or rejected submission.
      if (!result.ok) report(result.error);
      else {setName(''); const listed = await api.list(); if (listed.ok) setConnections(listed.value);}
    } catch {setError('The app could not save this connection. Try again.');}
    finally {setApiKey(''); setBusy(null);}
  }
  async function chatgpt(id?: string) {
    setBusy('chatgpt'); setError(''); setUsageLimited(false);
    try {const result = await api.connectChatGPT(id); if (!result.ok) report(result.error); else {const listed = await api.list(); if (listed.ok) setConnections(listed.value);}}
    catch {setError('The app could not complete ChatGPT sign-in. Try again.');}
    finally {setBusy(null);}
  }
  async function discover(id: string) {
    setBusy(id); setError(''); setUsageLimited(false);
    try {const result = await api.models(id); if (result.ok) setModels(previous => ({...previous,[id]: result.value})); else report(result.error);}
    catch {setError('The app could not load this model catalog. Try again.');}
    finally {setBusy(null);}
  }
  async function remove(id: string) {
    setBusy(id); setError(''); setUsageLimited(false);
    try {const result = await api.remove(id); if (!result.ok) report(result.error); const listed = await api.list(); if (listed.ok) setConnections(listed.value);}
    catch {setError('The app could not remove this connection. Try again.');}
    finally {setBusy(null);}
  }
  return <section aria-label="AI connections" style={{display:'grid',gap:16}}>
    <div>
      <h3>Connect your AI</h3>
      <p className="muted">AI credentials stay encrypted on this computer. Connecting or choosing a model does not start a task.</p>
    </div>
    <div style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
      <Button onClick={() => void chatgpt()} disabled={busy !== null}>Continue with ChatGPT</Button>
      {busy === 'chatgpt' && <Button variant="ghost" onClick={() => void api.cancelChatGPT()}>Cancel sign-in</Button>}
    </div>
    <p className="muted">ChatGPT plan usage requires an eligible account and your permission in the browser. Your Google collaboration account stays separate.</p>
    <form onSubmit={event => {event.preventDefault(); void add();}} style={{display:'grid',gap:10}}>
      <label>Provider <select value={provider} onChange={event => setProvider(event.target.value as AddConnectionInput['provider'])} disabled={busy !== null}>
        <option value="openai">OpenAI API</option><option value="anthropic">Claude API</option><option value="kimi">Kimi API</option><option value="compatible">Compatible API</option>
      </select></label>
      <label>Connection name <input value={name} onChange={event => setName(event.target.value)} maxLength={80} placeholder="Optional" autoComplete="off" /></label>
      {provider === 'compatible' && <label>API base URL <input value={baseUrl} onChange={event => setBaseUrl(event.target.value)} placeholder="https://provider.example/v1" type="url" required autoComplete="off" /></label>}
      <label>API key <input type="password" value={apiKey} onChange={event => setApiKey(event.target.value)} autoComplete="off" spellCheck={false} required maxLength={8192} disabled={busy !== null} /></label>
      <Button type="submit" disabled={busy !== null || !apiKey.trim()}>Save API connection</Button>
    </form>
    {error && <p role="alert" style={{color:'var(--danger, #e99090)'}}>{error}</p>}
    {usageLimited&&<ChatGPTPlanUsage api={api} limited/>}
    <div style={{display:'grid',gap:12}}>{connections.length === 0 ? <p className="muted">No AI connections saved on this account and computer.</p> : connections.map(connection => <article key={connection.id} style={{border:'1px solid var(--border)',borderRadius:10,padding:12,display:'grid',gap:8}}>
      <div><strong>{connection.name}</strong>{connection.accountLabel && <span className="muted"> · {connection.accountLabel}</span>}</div>
      <small className="muted">{connection.status === 'ready' ? 'Configured' : connection.status === 'sign-in-required' ? 'Sign-in required' : 'ChatGPT plan permission required'} · {connection.baseUrl}</small>
      <div style={{display:'flex',gap:8,flexWrap:'wrap'}}>
        {connection.provider === 'chatgpt' && connection.status !== 'ready' ? <Button size="sm" onClick={() => void chatgpt(connection.id)} disabled={busy !== null}>Reconnect ChatGPT</Button> : <Button size="sm" onClick={() => void discover(connection.id)} disabled={busy !== null}>Load available models</Button>}
        <Button size="sm" variant="ghost" onClick={() => void remove(connection.id)} disabled={busy !== null}>Remove</Button>
      </div>
      {connection.provider==='chatgpt'&&connection.status==='ready'&&<ChatGPTPlanUsage api={api} active={false}/>}
      {models[connection.id] && (models[connection.id]!.length ? <label>Model <select defaultValue="" onChange={event => {const model = models[connection.id]?.find(item => item.id === event.target.value); if (model) onSelect?.(connection.id,model);}}>
        <option value="" disabled>Choose a model</option>{models[connection.id]!.map(model => <option key={model.id} value={model.id}>{model.name}</option>)}
      </select></label> : <p className="muted">This provider returned no available models.</p>)}
    </article>)}</div>
    <ChatGPTPlanWelcome api={api} connections={connections}/>
  </section>;
}
