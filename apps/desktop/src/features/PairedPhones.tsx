// Settings → Paired phones: the owner pairs a phone to control this computer's agent remotely. This
// computer starts the pairing, shows a one-use code, and confirms the exact phone (its name and the six
// digits both screens show) and which sessions it may control. The phone never gets this computer's
// sign-in, files, terminal or model keys; every request it sends is checked and carried out here.
import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {Smartphone, Trash2, ShieldCheck, History} from 'lucide-react';
import {getBridge} from '../bridge/client';
import type {PairedPhone, PairingOffer, PairingReview} from '../bridge/controller';
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
  const sessions = useApp((s) => s.sessions);
  const details = useApp((s) => s.details);
  const activeId = useApp((s) => s.activeId);
  const toast = useApp.getState().toast;
  const hosted = useMemo(() => sessions.filter((session) => !session.archived && details[session.id]?.capabilities.configure !== false), [sessions, details]);
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
    const result = await api()?.listPhones();
    if (result?.ok) setPhones(result.value); else if (result) {setPhones([]); toast(describe(result.error), 'error');}
  }, [toast]);
  useEffect(() => {void load(); return api()?.onChange(() => void load());}, [load]);
  useEffect(() => {if (!chosen.length && activeId && hosted.some((s) => s.id === activeId)) setChosen([activeId]);}, [activeId, hosted, chosen.length]);

  // While a code is showing, watch for the phone to claim it.
  useEffect(() => {
    if (!offer) return;
    offerRef.current = offer.id;
    const tick = async () => {
      setNow(Date.now());
      const result = await api()?.reviewPairing(offer.id);
      if (!result?.ok || offerRef.current !== offer.id) return;
      setReview(result.value);
      if (result.value.status !== 'awaiting_device') clearInterval(timer);
    };
    const timer = setInterval(() => void tick(), 1500);
    void tick();
    return () => clearInterval(timer);
  }, [offer]);

  const start = async () => {
    if (!chosen.length) return;
    setBusy(true);
    const result = await api()?.createPairing(chosen, grant);
    setBusy(false);
    if (!result?.ok) {if (result) toast(describe(result.error), 'error'); return;}
    setReview(null); setOffer(result.value);
  };
  const cancel = async (decline: boolean) => {
    if (decline && offer) await api()?.declinePairing(offer.id);
    offerRef.current = null; setOffer(null); setReview(null);
  };
  const confirm = async () => {
    if (!offer || !review) return;
    setBusy(true);
    const result = await api()?.confirmPairing(offer.id, review.sessionIds);
    setBusy(false);
    if (!result?.ok) {if (result) toast(describe(result.error), 'error'); return;}
    toast(`${result.value.deviceName} can now control the selected sessions.`, 'info');
    offerRef.current = null; setOffer(null); setReview(null); void load();
  };
  const revoke = async (phone: PairedPhone) => {
    const result = await api()?.revokePairing(phone.id);
    if (result && !result.ok) toast(`${phone.deviceName} is no longer trusted here, but the service couldn’t be told yet: ${describe(result.error)}`, 'error');
    else toast(`${phone.deviceName} was removed. Its requests are refused from now on.`, 'info');
    void load();
  };
  const showAudit = async (phone: PairedPhone) => {
    if (audit?.id === phone.id) {setAudit(null); return;}
    const result = await api()?.audit(phone.id);
    if (result?.ok) setAudit({id: phone.id, rows: result.value});
  };
  const titleOf = (id: string) => sessions.find((s) => s.id === id)?.title ?? 'Session';
  const left = offer ? Math.max(0, Math.round((Date.parse(offer.codeExpiresAt) - now) / 1000)) : 0;

  if (!api()) return <p className="settings-note">Phone pairing is available in the desktop app.</p>;
  return (
    <div className="phones">
      <p className="settings-note">Control this computer’s agent from your phone, in the MultAI Android app or a phone browser. The phone can only ask; this computer checks every request and does it itself. Your files, terminal, model keys and sign-in never leave this computer.</p>

      {!offer && (
        <div className="phones-new">
          <fieldset className="phones-sessions">
            <legend>Sessions this phone may control</legend>
            {hosted.length === 0 && <p className="settings-note">Start a session on this computer first.</p>}
            {hosted.slice(0, 20).map((session) => (
              <label key={session.id} className="phones-check">
                <input type="checkbox" checked={chosen.includes(session.id)} onChange={(event) => setChosen((list) => event.target.checked ? [...list, session.id] : list.filter((id) => id !== session.id))} />
                <span>{session.title}</span>
              </label>
            ))}
          </fieldset>
          <label className="phones-grant">Owner access lasts
            <select value={grant} onChange={(event) => setGrant(Number(event.target.value))}>
              {GRANTS.map((option) => <option key={option.seconds} value={option.seconds}>{option.label}</option>)}
            </select>
          </label>
          <Button variant="primary" icon={Smartphone} disabled={busy || !chosen.length} onClick={() => void start()}>Pair a phone</Button>
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
            <Button variant="ghost" onClick={() => void cancel(true)}>Cancel</Button>
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
            <Button variant="danger" onClick={() => void cancel(true)}>Decline</Button>
          </div>
        </div>
      )}

      {offer && review && ['declined', 'revoked'].includes(review.status) && (
        <div className="phones-offer"><p className="settings-note">This pairing ended. Start again if you meant to pair.</p><Button onClick={() => void cancel(false)}>Done</Button></div>
      )}

      <h4 className="phones-heading">Paired phones</h4>
      {phones === null ? <Spinner /> : phones.length === 0 ? <p className="settings-note">No phones are paired.</p> : (
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
                {phone.status !== 'revoked' && <Button size="sm" variant="danger" icon={Trash2} onClick={() => void revoke(phone)}>Remove</Button>}
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
