// Share a read-only replay of this session: a link anyone can open in a browser, without MultAI, until
// it expires or the host revokes it. Screenshots, commands and account details are left out.
import { useEffect, useState } from 'react';
import { Copy, Link2, Trash2 } from 'lucide-react';
import { getBridge } from '../bridge/client';
import { useApp } from '../model/store';
import { describe } from '../live/controller';
import { Button, Dialog, IconButton, Segmented, Spinner } from '../ui/primitives';

const DAY = 86_400;
const api = () => getBridge()?.service ?? null;
const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function ReplayDialog({ sessionId, open, onClose }: { sessionId: string; open: boolean; onClose: () => void }) {
  const [expiry, setExpiry] = useState<'1' | '7' | '30'>('7');
  const [created, setCreated] = useState<{ link: string; expiresAt: string } | null>(null);
  const [links, setLinks] = useState<{ id: string; createdAt: string; expiresAt: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useApp.getState().toast;
  const load = async () => {
    const result = await api()?.listReplays(sessionId);
    if (result?.ok) setLinks(result.value.replays); else setLinks([]);
  };
  useEffect(() => { if (open) { setCreated(null); void load(); } }, [open, sessionId]);
  const copy = async (link: string) => {
    try { await navigator.clipboard.writeText(link); toast('Replay link copied.', 'success'); }
    catch { toast('Couldn’t copy. Select the link and copy it.', 'error'); }
  };
  const create = async () => {
    setBusy(true);
    try {
      const result = await api()!.createReplay(sessionId, Number(expiry) * DAY);
      if (!result.ok) { toast(describe(result.error), 'error'); return; }
      setCreated(result.value);
      await copy(result.value.link);
      await load();
    } finally { setBusy(false); }
  };
  const revoke = async (id: string) => {
    const result = await api()!.revokeReplay(sessionId, id);
    if (!result.ok) toast(describe(result.error), 'error');
    else toast('Link revoked. It stops working right away.', 'info');
    await load();
  };
  return (
    <Dialog open={open} onClose={onClose} title="Share a watch link" width={540}
      description="A read-only link anyone can open in a browser, no app or account needed. While the session is going they watch it live; afterwards they can play it back step by step. Screenshots, commands and account details are left out.">
      <div className="dialog-body">
        <div className="replay-create">
          <span className="field-label">Link works for</span>
          <Segmented label="Link expiry" size="sm" value={expiry} onChange={setExpiry} options={[{ value: '1', label: '1 day' }, { value: '7', label: '7 days' }, { value: '30', label: '30 days' }]} />
          <span className="spacer" />
          <Button variant="primary" icon={Link2} disabled={busy} onClick={() => void create()}>Create link</Button>
        </div>
        {created && (
          <div className="invite-link replay-link">
            <input readOnly value={created.link} aria-label="Replay link" onFocus={(e) => e.currentTarget.select()} />
            <IconButton size="sm" icon={Copy} label="Copy link" onClick={() => void copy(created.link)} />
          </div>
        )}
        {created && <p className="field-help">Copied. It follows the session live and works until {when(created.expiresAt)}. Anyone with the link can watch, so share it only with people you mean to.</p>}
        <h3 className="skill-group-title">Active links</h3>
        {links === null ? <p className="field-help"><Spinner /> Loading…</p> : links.length === 0 ? <p className="field-help">No active links.</p> : (
          <ul className="prompt-list">
            {links.map((link) => (
              <li key={link.id}>
                <div className="prompt-item"><strong>Created {when(link.createdAt)}</strong><span className="field-help">Expires {when(link.expiresAt)}</span></div>
                <Button size="sm" variant="ghost" icon={Trash2} onClick={() => void revoke(link.id)}>Revoke</Button>
              </li>
            ))}
          </ul>
        )}
        <div className="form-actions"><Button variant="primary" onClick={onClose}>Done</Button></div>
      </div>
    </Dialog>
  );
}
