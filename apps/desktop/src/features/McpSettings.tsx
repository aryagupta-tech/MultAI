// Settings → Tools (MCP): stdio servers the host adds. Their tools are offered to the agent in Build
// mode, and every call waits for the host's approval like a command. Env values (tokens) are stored
// encrypted and never shown again; leaving one empty keeps it.
import { useEffect, useState } from 'react';
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
  return Object.fromEntries(text.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const at = line.indexOf('=');
    return at < 0 ? [line, ''] : [line.slice(0, at).trim(), line.slice(at + 1)];
  }));
}

export function McpSettings() {
  const [servers, setServers] = useState<McpServerInfo[] | null>(null);
  const [editing, setEditing] = useState<{ server: McpServerInfo; args: string; env: string } | null>(null);
  const [tested, setTested] = useState<Record<string, string[] | 'testing' | undefined>>({});
  const [busy, setBusy] = useState(false);
  const toast = useApp.getState().toast;
  const load = async () => {
    const result = await api()?.mcpServers();
    if (result?.ok) setServers(result.value); else if (result) { setServers([]); toast(describe(result.error), 'error'); }
  };
  useEffect(() => { void load(); }, []);
  if (!api()) return <p className="settings-note">MCP servers need the desktop app.</p>;

  const save = async (server: McpServerInfo) => {
    setBusy(true);
    try {
      const result = await api()!.mcpSave(server);
      if (!result.ok) { toast(describe(result.error), 'error'); return false; }
      await load();
      return result.value;
    } finally { setBusy(false); }
  };
  const test = async (id: string) => {
    setTested((s) => ({ ...s, [id]: 'testing' }));
    const result = await api()!.mcpTest(id);
    if (result.ok) setTested((s) => ({ ...s, [id]: result.value }));
    else { setTested((s) => ({ ...s, [id]: undefined })); toast(describe(result.error), 'error'); }
  };

  return (
    <>
      <p className="settings-note">Add MCP servers that run on this computer to give the agent more tools, like a database, a browser or your issue tracker. Their tools are offered in Build mode, and the agent must get your approval for every call, even with Auto access. Only servers you add here are used; a repository can’t add any.</p>
      {servers === null ? <p className="settings-note"><Spinner /> Loading…</p> : (
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
                <Button size="sm" variant="ghost" disabled={tools === 'testing'} onClick={() => void test(server.id)}>Test</Button>
                <Switch label={`Use ${server.name}`} checked={server.enabled} onChange={(enabled) => void save({ ...server, enabled })} />
                <IconButton size="sm" icon={Pencil} label={`Edit ${server.name}`} onClick={() => setEditing({ server, args: argsText(server.args), env: envText(server.env) })} />
                <IconButton size="sm" icon={Trash2} label={`Remove ${server.name}`} onClick={() => void api()!.mcpDelete(server.id).then(load)} />
              </li>
            );
          })}
          {!servers.length && <li className="field-help">No MCP servers yet.</li>}
        </ul>
      )}
      <div className="form-actions"><Button icon={Plus} onClick={() => setEditing({ server: blank, args: '', env: '' })}>Add server</Button></div>
      <Dialog open={Boolean(editing)} onClose={() => setEditing(null)} title={editing?.server.id ? `Edit ${editing.server.name}` : 'Add an MCP server'} width={560}
        description="A server that speaks MCP over stdio. It starts in the chat’s folder with your PATH and only the variables below.">
        {editing && (
          <form className="dialog-body" onSubmit={(e) => {
            e.preventDefault();
            const server = { ...editing.server, args: editing.args.split('\n').map((line) => line.trim()).filter(Boolean), env: parseEnv(editing.env) };
            void save(server).then((saved) => { if (saved) { setEditing(null); void test(saved.id); } });
          }}>
            <label className="field">
              <span className="field-label">Name</span>
              <input value={editing.server.name} maxLength={24} placeholder="github" onChange={(e) => setEditing({ ...editing, server: { ...editing.server, name: e.target.value.toLowerCase().replace(/[^a-z0-9-]/gu, '-') } })} />
            </label>
            <label className="field">
              <span className="field-label">Command</span>
              <input className="mono" value={editing.server.command} placeholder="npx" onChange={(e) => setEditing({ ...editing, server: { ...editing.server, command: e.target.value } })} />
            </label>
            <label className="field">
              <span className="field-label">Arguments, one per line</span>
              <textarea className="mono" rows={3} value={editing.args} placeholder={'-y\n@modelcontextprotocol/server-github'} onChange={(e) => setEditing({ ...editing, args: e.target.value })} />
            </label>
            <label className="field">
              <span className="field-label">Environment variables, NAME=value per line</span>
              <textarea className="mono" rows={3} value={editing.env} placeholder="GITHUB_TOKEN=…" onChange={(e) => setEditing({ ...editing, env: e.target.value })} />
              <span className="field-help">Stored encrypted on this computer. Saved values aren’t shown again; leave one as NAME= to keep it.</span>
            </label>
            <div className="form-actions">
              <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
              <Button variant="primary" type="submit" disabled={busy || !editing.server.name || !editing.server.command.trim()}>Save and test</Button>
            </div>
          </form>
        )}
      </Dialog>
    </>
  );
}
