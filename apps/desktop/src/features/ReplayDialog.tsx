// Share a read-only replay of this session: a link anyone can open in a browser, without MultAI, until
// it expires or the host revokes it. Screenshots, commands and account details are left out.
import { useEffect, useRef, useState } from 'react';
import { Copy, Link2, Trash2 } from 'lucide-react';
import { getBridge } from '../bridge/client';
import {copyText} from '../bridge/clipboard';
import { useApp } from '../model/store';
import { describe } from '../live/controller';
import { Button, Dialog, IconButton, Segmented, Spinner } from '../ui/primitives';

const DAY = 86_400;
const api = () => getBridge()?.service ?? null;
const when = (iso: string) => new Date(iso).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

type ReplayDialogProps={sessionId:string;open:boolean;onClose:()=>void};
export function ReplayDialog(props:ReplayDialogProps){
  const account=useApp(state=>state.account?.id);
  return <ReplayContent key={JSON.stringify([account,props.sessionId,props.open])} {...props}/>;
}
function ReplayContent({ sessionId, open, onClose }: ReplayDialogProps) {
  const [expiry, setExpiry] = useState<'1' | '7' | '30'>('7');
  const [created, setCreated] = useState<{ id:string; link: string; expiresAt: string } | null>(null);
  const [links, setLinks] = useState<{ id: string; createdAt: string; expiresAt: string }[] | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useApp.getState().toast;
  const account=useApp(state=>state.account?.id);
  const view=useRef({generation:0,active:open});
  const pending=useRef<number|null>(null),listing=useRef(0);
  const [error,setError]=useState(''),[copied,setCopied]=useState(false);
  const current=(generation:number)=>view.current.active&&view.current.generation===generation&&useApp.getState().account?.id===account;
  const load = async (generation=view.current.generation) => {
    const request=++listing.current;
    try{
      const service=api();if(!service)throw new Error('The desktop connection is unavailable.');
      const result=await service.listReplays(sessionId);
      if(!current(generation)||request!==listing.current)return;
      if(!result.ok)throw new Error(describe(result.error));
      setLinks(result.value.replays);setError('');
    }catch(failure){if(current(generation)&&request===listing.current){setLinks(null);setError(failure instanceof Error?failure.message:'Couldn’t load watch links. Try again.');}}
  };
  useEffect(() => {
    view.current.active=open;
    if(open)void load();
    return()=>{view.current.active=false;view.current.generation++;};
  },[]);
  const copy = async (link: string,generation=view.current.generation) => {
    try { await copyText(link);if(current(generation)){setCopied(true);toast('Replay link copied.', 'success');} }
    catch {if(current(generation)){setCopied(false);toast('Couldn’t copy. Select the link and copy it.', 'error');}}
  };
  const perform=async(task:(generation:number)=>Promise<void>)=>{
    const generation=view.current.generation;
    if(pending.current===generation)return;
    if(!current(generation))return;
    pending.current=generation;setBusy(true);setError('');
    try{await task(generation);}catch(failure){if(current(generation)){const message=failure instanceof Error?failure.message:'The watch link could not be updated. Try again.';setError(message);toast(message,'error');}}
    finally{if(pending.current===generation)pending.current=null;if(current(generation))setBusy(false);}
  };
  const create = () => perform(async generation=>{
    const service=api();if(!service)throw new Error('The desktop connection is unavailable.');
    const result=await service.createReplay(sessionId,Number(expiry)*DAY);
    if(!current(generation))return;
    if(!result.ok)throw new Error(describe(result.error));
    setCreated(result.value);setCopied(false);
    await copy(result.value.link,generation);
    if(current(generation))await load(generation);
  });
  const revoke = (id:string) => perform(async generation=>{
    const service=api();if(!service)throw new Error('The desktop connection is unavailable.');
    const result=await service.revokeReplay(sessionId,id);
    if(!current(generation))return;
    if(!result.ok)throw new Error(describe(result.error));
    // A link the user just revoked must not remain in the share field.
    if(created?.id===id){setCreated(null);setCopied(false);}
    toast('Link revoked. It stops working right away.','info');
    await load(generation);
  });
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
        {created && <p className="field-help">{copied?'Copied. ':''}It follows the session live and works until {when(created.expiresAt)}. Anyone with the link can watch, so share it only with people you mean to.</p>}
        <h3 className="skill-group-title">Active links</h3>
        {error&&<p role="alert" className="tone-danger">{error} <Button size="sm" disabled={busy} onClick={()=>void load()}>Retry</Button></p>}
        {links === null ? !error&&<p className="field-help"><Spinner /> Loading…</p> : links.length === 0 ? <p className="field-help">No active links.</p> : (
          <ul className="prompt-list">
            {links.map((link) => (
              <li key={link.id}>
                <div className="prompt-item"><strong>Created {when(link.createdAt)}</strong><span className="field-help">Expires {when(link.expiresAt)}</span></div>
                <Button size="sm" variant="ghost" icon={Trash2} disabled={busy} onClick={() => void revoke(link.id)}>Revoke</Button>
              </li>
            ))}
          </ul>
        )}
        <div className="form-actions"><Button variant="primary" onClick={onClose}>Done</Button></div>
      </div>
    </Dialog>
  );
}
