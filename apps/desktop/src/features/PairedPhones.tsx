// Settings → Paired phones: the owner pairs a phone to control this computer's agent remotely. This
// computer starts the pairing, shows a one-use code, and confirms the exact phone (its name and the six
// digits both screens show) and which sessions it may control. The phone never gets this computer's
// sign-in, files, terminal or model keys; every request it sends is checked and carried out here.
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Smartphone, Trash2, ShieldCheck, History} from 'lucide-react';
import {getBridge} from '../bridge/client';
import type {ControllerBridge,PairedPhone, PairingOffer, PairingReview} from '../bridge/controller';
import {useApp} from '../model/store';
import {describe} from '../live/controller';
import {Button, Spinner} from '../ui/primitives';

const api = () => getBridge()?.controller ?? null;
const GRANTS = [{seconds: 86_400, label: '1 day'}, {seconds: 7 * 86_400, label: '7 days'}, {seconds: 30 * 86_400, label: '30 days'}];
const PERMISSIONS = ['Start an instruction you pick on the phone', 'Stop the agent', 'Steer a queued direction into a running agent', 'Approve or reject the exact waiting action', 'Resolve conflicting directions'];
const when = (iso: string | null) => iso ? new Date(iso).toLocaleString(undefined, {dateStyle: 'medium', timeStyle: 'short'}) : '—';

function Qr({modules, label}: {modules: boolean[][]; label: string}) {
  const size = modules.length;
  const path = useMemo(() => modules.flatMap((row, y) => row.map((on, x) => on ? `M${x} ${y}h1v1h-1z` : '')).join(''), [modules]);
  return (
    <svg className="phone-qr" viewBox={`0 0 ${size} ${size}`} role="img" aria-label={label} shapeRendering="crispEdges">
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

export function PairedPhones() {
  const account=useApp(state=>state.account?.id);
  return <PairedPhonesContent key={account??'signed-out'}/>;
}
function PairedPhonesContent() {
  const account=useApp(state=>state.account?.id);
  const scope=useRef({generation:0,alive:true});
  const current=(generation:number)=>scope.current.alive&&scope.current.generation===generation&&useApp.getState().account?.id===account;
  const pending=useRef<number|null>(null),listRequest=useRef(0),auditRequest=useRef(0);
  const [error,setError]=useState(''),[loadError,setLoadError]=useState('');
  const sessions = useApp((s) => s.sessions);
  const details = useApp((s) => s.details);
  const activeId = useApp((s) => s.activeId);
  const toast = useApp.getState().toast;
  const hosted = useMemo(() => sessions.filter((session) => !session.archived && details[session.id]?.capabilities.configure === true), [sessions, details]);
  const [phones, setPhones] = useState<PairedPhone[] | null>(null);
  const [chosen, setChosen] = useState<string[]>([]);
  const [grant, setGrant] = useState(7 * 86_400);
  const [offer, setOffer] = useState<PairingOffer | null>(null);
  const [review, setReview] = useState<PairingReview | null>(null);
  const [busy, setBusy] = useState(false);
  const [audit, setAudit] = useState<{id: string; rows: {event: string; at: string; detail: string}[]} | null>(null);
  const [now, setNow] = useState(Date.now());
  const offerRef = useRef<string | null>(null);

  const load = useCallback(async () => {
    const generation=scope.current.generation,request=++listRequest.current;
    try{
      const bridge=api();if(!bridge)throw new Error('Phone pairing is unavailable.');
      const result=await bridge.listPhones();
      if(!current(generation)||request!==listRequest.current)return;
      if(!result.ok)throw new Error(describe(result.error));
      setPhones(result.value);setLoadError('');
    }catch(failure){if(current(generation)&&request===listRequest.current)setLoadError(failure instanceof Error?failure.message:'Couldn’t load paired phones.');}
  }, [account]);
  useEffect(() => {
    scope.current.alive=true;
    void load();const stop=api()?.onChange(()=>void load());
    return()=>{scope.current.alive=false;scope.current.generation++;offerRef.current=null;stop?.();};
  }, [load]);
  const defaulted=useRef(false);
  useEffect(() => {
    if(defaulted.current)return;
    if(activeId&&hosted.some(session=>session.id===activeId)){setChosen([activeId]);defaulted.current=true;}
  }, [account,activeId,hosted]);

  // Poll one request at a time. A canceled or replaced offer cannot return from a late response.
  useEffect(() => {
    if(!offer)return;
    offerRef.current=offer.id;let stopped=false,inFlight=false;
    const generation=scope.current.generation;
    const clock=setInterval(()=>setNow(Date.now()),1000);
    const tick=async()=>{
      if(inFlight||stopped)return;inFlight=true;
      try{
        const bridge=api();if(!bridge)throw new Error('Phone pairing is unavailable.');
        const result=await bridge.reviewPairing(offer.id);
        if(stopped||!current(generation)||offerRef.current!==offer.id)return;
        if(!result.ok)throw new Error(describe(result.error));
        setError('');setReview(result.value);
        if(result.value.status==='active'){offerRef.current=null;setOffer(null);setReview(null);void load();}
        if(['active','declined','revoked'].includes(result.value.status)){clearInterval(timer);clearInterval(clock);}
      }catch(failure){if(!stopped&&current(generation)&&offerRef.current===offer.id)setError(failure instanceof Error?failure.message:'Couldn’t refresh this pairing.');}
      finally{inFlight=false;}
    };
    const timer=setInterval(()=>void tick(),1500);void tick();
    return()=>{stopped=true;clearInterval(timer);clearInterval(clock);if(offerRef.current===offer.id)offerRef.current=null;};
  },[offer,account,load]);

  const perform=async(task:(bridge:ControllerBridge,generation:number)=>Promise<void>)=>{
    const generation=scope.current.generation;if(pending.current===generation||!current(generation))return;
    pending.current=generation;setBusy(true);setError('');
    try{const bridge=api();if(!bridge)throw new Error('Phone pairing is unavailable.');await task(bridge,generation);}
    catch(failure){if(current(generation)){const message=failure instanceof Error?failure.message:'The phone action failed. Try again.';setError(message);toast(message,'error');}}
    finally{if(pending.current===generation)pending.current=null;if(current(generation))setBusy(false);}
  };
  const start = ()=>perform(async(bridge,generation)=>{
    const allowed=chosen.filter(id=>hosted.some(session=>session.id===id));
    if(!allowed.length)throw new Error('Choose a session hosted on this computer.');
    const result=await bridge.createPairing(allowed,grant);
    if(!current(generation))return;
    if(!result.ok)throw new Error(describe(result.error));
    setNow(Date.now());setReview(null);setOffer(result.value);
  });
  const cancel = (decline:boolean)=>perform(async(bridge,generation)=>{
    if(decline&&offer){const result=await bridge.declinePairing(offer.id);if(!result.ok)throw new Error(describe(result.error));}
    if(!current(generation))return;
    offerRef.current=null;setOffer(null);setReview(null);
  });
  const confirm = ()=>perform(async(bridge,generation)=>{
    if(!offer||review?.status!=='awaiting_confirmation')return;
    const result=await bridge.confirmPairing(offer.id,review.sessionIds);
    if(!current(generation)||offerRef.current!==offer.id)return;
    if(!result.ok)throw new Error(describe(result.error));
    toast(`${result.value.deviceName} can now control the selected sessions.`,'info');
    offerRef.current=null;setOffer(null);setReview(null);void load();
  });
  const revoke = (phone:PairedPhone)=>perform(async(bridge,generation)=>{
    const result=await bridge.revokePairing(phone.id);
    if(!current(generation))return;
    void load();
    if(!result.ok)throw new Error(`${phone.deviceName} is no longer trusted here, but the service couldn’t be told yet: ${describe(result.error)}`);
    toast(`${phone.deviceName} was removed. Its requests are refused from now on.`,'info');
  });
  const showAudit = async(phone:PairedPhone)=>{
    const request=++auditRequest.current,generation=scope.current.generation;
    if(audit?.id===phone.id){setAudit(null);return;}
    try{
      const bridge=api();if(!bridge)throw new Error('Phone pairing is unavailable.');
      const result=await bridge.audit(phone.id);
      if(!current(generation)||request!==auditRequest.current)return;
      if(!result.ok)throw new Error(describe(result.error));
      setAudit({id:phone.id,rows:result.value});
    }catch(failure){if(current(generation)&&request===auditRequest.current)setError(failure instanceof Error?failure.message:'Couldn’t load phone history.');}
  };
  const titleOf = (id: string) => sessions.find((s) => s.id === id)?.title ?? 'Session';
  const left = offer ? Math.max(0, Math.round((Date.parse(offer.codeExpiresAt) - now) / 1000)) : 0;

  if (!api()) return <p className="settings-note">Phone pairing is available in the desktop app.</p>;
  return (
    <div className="phones">
      {error&&<p className="phones-warn" role="alert">{error}</p>}
      <p className="settings-note">Control this computer’s agent from your phone, in the MultAI Android app or a phone browser. The phone can only ask; this computer checks every request and does it itself. Your files, terminal, model keys and sign-in never leave this computer.</p>

      {!offer && (
        <div className="phones-new">
          <fieldset className="phones-sessions">
            <legend>Sessions this phone may control</legend>
            {hosted.length === 0 && <p className="settings-note">Start a session on this computer first.</p>}
            {hosted.slice(0, 20).map((session) => (
              <label key={session.id} className="phones-check">
                <input type="checkbox" disabled={busy} checked={chosen.includes(session.id)} onChange={(event) => {defaulted.current=true;setChosen((list) => event.target.checked ? [...list, session.id] : list.filter((id) => id !== session.id));}} />
                <span>{session.title}</span>
              </label>
            ))}
          </fieldset>
          <label className="phones-grant">Owner access lasts
            <select value={grant} disabled={busy} onChange={(event) => setGrant(Number(event.target.value))}>
              {GRANTS.map((option) => <option key={option.seconds} value={option.seconds}>{option.label}</option>)}
            </select>
          </label>
          <Button variant="primary" icon={Smartphone} disabled={busy || !chosen.some(id=>hosted.some(session=>session.id===id))} onClick={() => void start()}>Pair a phone</Button>
        </div>
      )}

      {offer && (!review || review.status === 'awaiting_device') && (
        <div className="phones-offer" aria-live="polite">
          <Qr modules={offer.qr} label="Pairing code as a QR code. Scan it with the phone’s camera." />
          <div className="phones-offer-text">
            <h4>Scan with the phone’s camera, or enter the code</h4>
            <p className="phones-code" aria-label={`Pairing code ${offer.code.split('').join(' ')}`}>{offer.code}</p>
            <p className="settings-note">In MultAI on the phone, choose <b>Pair as owner</b>. The code works once and expires in {Math.floor(left / 60)}:{String(left % 60).padStart(2, '0')}.</p>
            {left === 0 && <p className="phones-warn">This code expired. Start again.</p>}
            <Button variant="ghost" disabled={busy} onClick={() => void cancel(true)}>Cancel</Button>
          </div>
        </div>
      )}

      {offer && review?.status === 'awaiting_confirmation' && (
        <div className="phones-confirm" role="alertdialog" aria-labelledby="phones-confirm-title">
          <h4 id="phones-confirm-title"><ShieldCheck size={16} aria-hidden /> Confirm this phone</h4>
          <dl>
            <dt>Phone</dt><dd>{review.deviceName ?? 'Unnamed phone'} · {review.platform === 'android' ? 'Android app' : review.platform === 'ios' ? 'iPhone browser' : 'Phone browser'}</dd>
            <dt>Check digits</dt><dd className="phones-sas">{review.verificationCode ?? '—'}</dd>
            <dt>Sessions</dt><dd>{review.sessionIds.map(titleOf).join(', ')}</dd>
            <dt>For</dt><dd>{GRANTS.find((g) => g.seconds === review.grantSeconds)?.label ?? `${Math.round(review.grantSeconds / 3600)} hours`}, until you remove it</dd>
          </dl>
          <p className="settings-note">Only confirm if the phone in your hand shows the same six digits. It will be able to:</p>
          <ul className="phones-perms">{PERMISSIONS.map((item) => <li key={item}>{item}</li>)}</ul>
          <p className="settings-note">It can’t open a terminal, browse files, see model keys or use this computer’s sign-in.</p>
          <div className="phones-actions">
            <Button variant="primary" disabled={busy || !review.verificationCode} onClick={() => void confirm()}>Confirm phone</Button>
            <Button variant="danger" disabled={busy} onClick={() => void cancel(true)}>Decline</Button>
          </div>
        </div>
      )}

      {offer && review && ['declined', 'revoked'].includes(review.status) && (
        <div className="phones-offer"><p className="settings-note">This pairing ended. Start again if you meant to pair.</p><Button disabled={busy} onClick={() => void cancel(false)}>Done</Button></div>
      )}

      <h4 className="phones-heading">Paired phones</h4>
      {loadError&&<p className="phones-warn" role="alert">{loadError} <Button size="sm" onClick={()=>void load()}>Retry</Button></p>}
      {phones === null ? !loadError&&<Spinner /> : phones.length === 0 ? <p className="settings-note">No phones are paired.</p> : (
        <ul className="phones-list">
          {phones.map((phone) => (
            <li key={phone.id} className={phone.status !== 'active' ? 'is-inactive' : undefined}>
              <div className="phones-row">
                <Smartphone size={16} aria-hidden />
                <div className="phones-meta">
                  <b>{phone.deviceName}</b>
                  <span>{phone.status === 'active' ? `Until ${when(phone.expiresAt)} · last seen ${when(phone.lastSeenAt)}` : phone.status === 'untrusted' ? 'Not confirmed on this computer: its requests are refused' : `Removed ${when(phone.revokedAt)}${phone.revokedBy === 'expiry' ? ' (expired)' : phone.revokedBy === 'controller' ? ' from the phone' : ''}`}</span>
                  <span>{phone.sessionIds.map(titleOf).join(', ')}</span>
                </div>
                <Button size="sm" variant="ghost" icon={History} onClick={() => void showAudit(phone)} aria-expanded={audit?.id === phone.id}>History</Button>
                {phone.status !== 'revoked' && <Button size="sm" variant="danger" icon={Trash2} disabled={busy} onClick={() => void revoke(phone)}>Remove</Button>}
              </div>
              {audit?.id === phone.id && (
                <ol className="phones-audit">{audit.rows.length ? audit.rows.map((row, index) => <li key={index}><time>{when(row.at)}</time> {row.detail}</li>) : <li>No activity yet.</li>}</ol>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
