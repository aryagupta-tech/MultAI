// Settings → Tools (MCP): stdio servers the host adds. Their tools are offered to the agent in Build
// mode, and every call waits for the host's approval like a command. Env values (tokens) are stored
// encrypted and never shown again; leaving one empty keeps it.
import { useEffect, useRef, useState } from 'react';
import { Pencil, Plug, Plus, Trash2 } from 'lucide-react';
import { getBridge } from '../bridge/client';
import type { McpServerInfo } from '../bridge/execution';
import { useApp } from '../model/store';
import { describe } from '../live/controller';
import { Button, Dialog, IconButton, Spinner, Switch } from '../ui/primitives';

const api = () => getBridge()?.inference ?? null;
const blank: McpServerInfo = { id: '', name: '', command: '', args: [], env: {}, enabled: true };

/** One argument per line keeps paths with spaces intact. */
const argsText = (args: string[]) => args.join('\n');
const envText = (env: Record<string, string>) => Object.keys(env).map((key) => `${key}=`).join('\n');
function parseEnv(text: string): Record<string, string> {
  return Object.fromEntries(text.split(/\r?\n/u).filter((line) => line.trim()).map((line) => {
    const at = line.indexOf('=');
    return at < 0 ? [line.trim(), ''] : [line.slice(0, at).trim(), line.slice(at + 1)];
  }));
}

export function McpSettings() {
  const account=useApp(state=>state.account?.id);
  return <McpSettingsContent key={account??'signed-out'}/>;
}
function McpSettingsContent() {
  const account=useApp(state=>state.account?.id);
  const scope=useRef({active:true,generation:0,pending:false}),listing=useRef(0);
  const [servers, setServers] = useState<McpServerInfo[] | null>(null);
  const [editing, setEditing] = useState<{ server: McpServerInfo; args: string; env: string } | null>(null);
  const [tested, setTested] = useState<Record<string, string[] | 'testing' | undefined>>({});
  const [busy, setBusy] = useState(false);
  const [error,setError]=useState(''),[loadError,setLoadError]=useState('');
  const toast = useApp.getState().toast;
  const current=(generation:number)=>scope.current.active&&scope.current.generation===generation&&useApp.getState().account?.id===account;
  const load = async () => {
    const generation=scope.current.generation,request=++listing.current;
    try{
      const bridge=api();if(!bridge)throw new Error('The desktop connection is unavailable.');
      const result=await bridge.mcpServers();
      if(!current(generation)||request!==listing.current)return;
      if(!result.ok)throw new Error(describe(result.error));
      setServers(result.value);setLoadError('');
    }catch(failure){if(current(generation)&&request===listing.current)setLoadError(failure instanceof Error?failure.message:'Couldn’t load MCP servers.');}
  };
  useEffect(() => {
    scope.current.active=true;void load();
    return()=>{scope.current.active=false;scope.current.generation++;};
  }, []);
  if (!api()) return <p className="settings-note">MCP servers need the desktop app.</p>;

  const perform=async<T,>(task:(generation:number)=>Promise<T>):Promise<T|false>=>{
    const generation=scope.current.generation;
    if(scope.current.pending||!current(generation))return false;
    scope.current.pending=true;setBusy(true);setError('');
    try{return await task(generation);}
    catch(failure){if(current(generation)){const message=failure instanceof Error?failure.message:'The MCP server could not be updated.';setError(message);toast(message,'error');}return false;}
    finally{if(scope.current.generation===generation)scope.current.pending=false;if(current(generation))setBusy(false);}
  };
  const save = (server:McpServerInfo)=>perform(async generation=>{
    const bridge=api();if(!bridge)throw new Error('The desktop connection is unavailable.');
    const result=await bridge.mcpSave(server);
    if(!current(generation))return false;
    if(!result.ok)throw new Error(describe(result.error));
    setTested((state)=>({...state,[result.value.id]:undefined}));
    await load();return current(generation)?result.value:false;
  });
  const test = (id: string) => perform(async generation=>{
    setTested((state)=>({...state,[id]:'testing'}));
    try{
      const bridge=api();if(!bridge)throw new Error('The desktop connection is unavailable.');
      const result=await bridge.mcpTest(id);
      if(!current(generation))return;
      if(!result.ok)throw new Error(describe(result.error));
      setTested((state)=>({...state,[id]:result.value}));
    }catch(failure){if(current(generation))setTested((state)=>({...state,[id]:undefined}));throw failure;}
  });
  const remove=(id:string)=>perform(async generation=>{
    const bridge=api();if(!bridge)throw new Error('The desktop connection is unavailable.');
    const result=await bridge.mcpDelete(id);
    if(!current(generation))return;
    if(!result.ok)throw new Error(describe(result.error));
    setTested((state)=>({...state,[id]:undefined}));await load();
  });

  return (
    <>
      <p className="settings-note">Connect local MCP servers to add tools in Build mode. Every tool call asks for your approval.</p>
      {error&&!editing&&<p className="tone-danger" role="alert">{error}</p>}
      {loadError&&<p className="tone-danger" role="alert">{loadError} <Button size="sm" onClick={()=>void load()}>Retry</Button></p>}
      {servers === null ? !loadError&&<p className="settings-note"><Spinner /> Loading…</p> : (
        <ul className="prompt-list mcp-list">
          {servers.map((server) => {
            const tools = tested[server.id];
            return (
              <li key={server.id}>
                <Plug size={14} aria-hidden className="tone-muted" />
                <div className="prompt-item">
                  <strong className="mono">{server.name}</strong>
                  <span className="field-help mono truncate">{[server.command, ...server.args].join(' ')}</span>
                  {tools === 'testing' && <span className="field-help"><Spinner /> Starting the server…</span>}
                  {Array.isArray(tools) && <span className="field-help">{tools.length ? `${tools.length} tool${tools.length === 1 ? '' : 's'}: ${tools.join(', ')}` : 'Started, but it offers no tools.'}</span>}
                </div>
                <Button size="sm" variant="ghost" disabled={busy} onClick={() => void test(server.id)}>Test</Button>
                <fieldset disabled={busy} style={{border:0,padding:0,margin:0,minWidth:0}}>
                  <Switch label={`Use ${server.name}`} checked={server.enabled} onChange={(enabled) => void save({ ...server, enabled })} />
                </fieldset>
                <IconButton size="sm" icon={Pencil} label={`Edit ${server.name}`} disabled={busy} onClick={() => setEditing({ server, args: argsText(server.args), env: envText(server.env) })} />
                <IconButton size="sm" icon={Trash2} label={`Remove ${server.name}`} disabled={busy} onClick={() => void remove(server.id)} />
              </li>
            );
          })}
          {!servers.length && <li className="field-help">No MCP servers yet.</li>}
        </ul>
      )}
      <div className="form-actions"><Button icon={Plus} disabled={busy} onClick={() => setEditing({ server: blank, args: '', env: '' })}>Add server</Button></div>
      <Dialog open={Boolean(editing)} onClose={() => setEditing(null)} title={editing?.server.id ? `Edit ${editing.server.name}` : 'Add an MCP server'} width={560}
        description="Use the stdio command from the server’s setup instructions.">
        {editing && (
          <form className="dialog-body" onSubmit={(e) => {
            e.preventDefault();
            const server = { ...editing.server, args: editing.args.split(/\r?\n/u).filter((line) => line.trim()), env: parseEnv(editing.env) };
            void save(server).then((saved) => { if (saved) { setEditing(null); void test(saved.id); } });
          }}>
            <label className="field">
              <span className="field-label">Name</span>
              <input required disabled={busy} value={editing.server.name} maxLength={24} placeholder="github" onChange={(e) => setEditing({ ...editing, server: { ...editing.server, name: e.target.value.toLowerCase().replace(/[^a-z0-9-]/gu, '-') } })} />
            </label>
            <label className="field">
              <span className="field-label">Command</span>
              <input required disabled={busy} className="mono" value={editing.server.command} placeholder="npx" onChange={(e) => setEditing({ ...editing, server: { ...editing.server, command: e.target.value } })} />
            </label>
            <details>
              <summary className="field-label">Arguments and environment</summary>
              <div className="field">
            <label className="field">
              <span className="field-label">Arguments, one per line</span>
              <textarea disabled={busy} className="mono" rows={3} value={editing.args} placeholder={'-y\n@modelcontextprotocol/server-github'} onChange={(e) => setEditing({ ...editing, args: e.target.value })} />
            </label>
            <label className="field">
              <span className="field-label">Environment, NAME=value per line</span>
              <textarea disabled={busy} className="mono" rows={3} value={editing.env} placeholder="GITHUB_TOKEN=…" onChange={(e) => setEditing({ ...editing, env: e.target.value })} />
              <span className="field-help">Values are encrypted. Leave NAME= to keep a saved value; remove its line to delete it.</span>
            </label>
              </div>
            </details>
            <div className="form-actions">
              <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              <Button variant="primary" type="submit" disabled={busy || !editing.server.name || !editing.server.command.trim()}>Save and test</Button>
            </div>
            {error&&<p className="tone-danger" role="alert">{error}</p>}
          </form>
        )}
      </Dialog>
    </>
  );
}
