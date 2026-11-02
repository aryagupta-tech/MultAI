// The paired owner controller on a phone. It never holds desktop or provider credentials: it signs
// requests the desktop host checks and carries out itself. Every request stays "waiting" until the
// host acknowledges it, and expires after two minutes, so an old tap is never run after a reconnect.
import {ApiClient, ApiError, backoff} from './client.js';
import {randomSecret} from './canonical.js';
import {buildEnvelope, exportPublic, generatePhoneKeys, keyThumbprint, normalizePairingCode, openPreview, signControl, verificationCode, type ControlKind, type ControlTargets, type SealedPreview, type SignedControl} from './control.js';
import {acceptanceSchema, controlRequestResponse, controlSessionSchema, controllerStatusSchema, eventPageSchema, pairingClaimSchema, type ControlRequest, type ControllerStatus} from './wire.js';
import {z} from 'zod';
import type {KeyStore, PlainStore, SecureStore} from './storage.js';

const KEYS = {credential: 'controller.credential', pairing: 'controller.pairingId', claim: 'controller.pendingClaim', ledger: 'controller.ledger'};

export interface ControllerPlatform {
  /** Android: Keystore storage for the credential. Browser: null (HttpOnly cookie set by the service). */
  secure: SecureStore | null;
  plain: PlainStore;
  keys: KeyStore;
  platform: 'android' | 'ios' | 'web';
  deviceName(): string;
}

export interface LedgerEntry {
  requestId: string; sessionId: string; kind: ControlKind; label: string; signed: SignedControl;
  status: ControlRequest['status'] | 'sending' | 'unsent'; code: string | null; message: string | null; createdAt: number;
}
export type ControllerState =
  | {status: 'unpaired'; reason?: 'revoked' | 'expired' | 'declined' | 'unpaired'}
  | {status: 'claimed'; pairingId: string; verificationCode: string; hostName: string; ownerName: string}
  | {status: 'paired'; info: ControllerStatus};

const FINAL = new Set(['accepted', 'rejected', 'expired', 'canceled']);

export class Controller {
  private state: ControllerState = {status: 'unpaired'};
  private readonly listeners = new Set<(state: ControllerState) => void>();
  private readonly ledgerListeners = new Set<(ledger: LedgerEntry[]) => void>();
  /** Service time minus local time, from the last status answer; signatures use service time. */
  private offset = 0;
  private generation = 0;
  private claimCredential: string | null = null;
  constructor(private readonly api: ApiClient, private readonly platform: ControllerPlatform) {}

  get current(): ControllerState {return this.state;}
  subscribe(listener: (state: ControllerState) => void): () => void {this.listeners.add(listener); listener(this.state); return () => this.listeners.delete(listener);}
  onLedger(listener: (ledger: LedgerEntry[]) => void): () => void {this.ledgerListeners.add(listener); listener(this.ledger()); return () => this.ledgerListeners.delete(listener);}
  private set(state: ControllerState) {this.state = state; for (const listener of this.listeners) listener(state);}
  now(): number {return Date.now() + this.offset;}

  private async credential(): Promise<string | null> {
    return this.platform.secure ? this.platform.secure.get(KEYS.credential) : null;
  }
  private async auth() {
    const token = await this.credential();
    if (this.platform.secure && !token) throw new ApiError(403, 'controller_required', 'Pair this phone from the desktop first.');
    return {type: 'controller' as const, token};
  }
  get pairingId(): string | null {return this.platform.plain.get(KEYS.pairing);}

  /** Claims a desktop pairing code. A retry after a lost answer resends the very same claim. */
  async claim(rawCode: string): Promise<ControllerState> {
    const code = normalizePairingCode(rawCode);
    if (!code) throw new ApiError(400, 'pairing_code_invalid', 'Enter the 12-character code shown on the desktop.', 'invalid');
    let pending = this.pendingClaim();
    if (!pending || pending.code !== code) {
      await this.reset();
      const keys = await generatePhoneKeys();
      await this.platform.keys.save(keys);
      pending = {code, requestId: crypto.randomUUID(), credential: randomSecret(), deviceName: this.platform.deviceName().slice(0, 80)};
      // Android keeps the credential in the Keystore. A browser holds it only in memory until the service
      // sets it as an HttpOnly cookie; a reload during the claim means starting the pairing again.
      if (this.platform.secure) await this.platform.secure.set(KEYS.credential, pending.credential);
      else this.claimCredential = pending.credential;
      this.platform.plain.set(KEYS.claim, JSON.stringify({...pending, credential: null}));
    }
    const keys = await this.platform.keys.load();
    if (!keys) throw new ApiError(500, 'keys_missing', 'This phone couldn’t keep its pairing key. Start again.', 'invalid');
    const signingKey = await exportPublic(keys.signing.publicKey), encryptionKey = await exportPublic(keys.encryption.publicKey);
    const credential = this.platform.secure ? await this.platform.secure.get(KEYS.credential) : this.claimCredential;
    if (!credential) {this.platform.plain.remove(KEYS.claim); throw new ApiError(409, 'pairing_restart', 'Pairing was interrupted. Start pairing again on the desktop.', 'invalid');}
    const result = await this.api.request('POST', '/v1/controller/claim', {body: {code, requestId: pending.requestId, credential, deviceName: pending.deviceName, platform: this.platform.platform, signingKey, encryptionKey}, schema: pairingClaimSchema});
    // The phone computes the six digits itself; the desktop shows the digits for the key it received.
    const local = await verificationCode(result.pairing.id, await keyThumbprint(signingKey, encryptionKey));
    if (local !== result.pairing.verificationCode) {await this.reset(); throw new ApiError(409, 'pairing_key_mismatch', 'The pairing check failed. Start again on the desktop.', 'invalid');}
    this.platform.plain.remove(KEYS.claim);
    this.claimCredential = null;
    this.platform.plain.set(KEYS.pairing, result.pairing.id);
    this.set({status: 'claimed', pairingId: result.pairing.id, verificationCode: local, hostName: result.pairing.hostName, ownerName: result.pairing.ownerName});
    return this.state;
  }
  private pendingClaim(): {code: string; requestId: string; credential: string; deviceName: string} | null {
    try {
      const value = this.platform.plain.get(KEYS.claim);
      const parsed = value ? JSON.parse(value) as {code: string; requestId: string; credential: string | null; deviceName: string} : null;
      return parsed ? {...parsed, credential: ''} : null;
    } catch {return null;}
  }

  /** Refreshes the pairing: waiting for desktop confirmation, active, or gone. */
  async refresh(): Promise<ControllerState> {
    const generation = this.generation;
    if (!this.pairingId) {this.set({status: 'unpaired'}); return this.state;}
    try {
      const sent = Date.now();
      const status = await this.api.request('GET', '/v1/controller/status', {auth: await this.auth(), schema: controllerStatusSchema});
      if (generation !== this.generation) return this.state;
      this.offset = status.serverTime - Math.round((sent + Date.now()) / 2);
      if (status.pairing.status === 'awaiting_confirmation') this.set({status: 'claimed', pairingId: status.pairing.id, verificationCode: status.pairing.verificationCode, hostName: status.pairing.hostName, ownerName: status.pairing.ownerName});
      else this.set({status: 'paired', info: status});
    } catch (error) {
      if (error instanceof ApiError && error.status === 403 && /^controller_(revoked|expired|required|declined)$/u.test(error.code)) {
        await this.reset();
        this.set({status: 'unpaired', reason: error.code === 'controller_expired' ? 'expired' : 'revoked'});
        return this.state;
      }
      throw error;
    }
    return this.state;
  }

  async sessionDetail(sessionId: string) {return this.api.request('GET', `/v1/controller/sessions/${sessionId}`, {auth: await this.auth(), schema: controlSessionSchema});}
  async events(sessionId: string, after: number) {return this.api.request('GET', `/v1/controller/sessions/${sessionId}/events?after=${after}`, {auth: await this.auth(), schema: eventPageSchema});}
  async acceptance(sessionId: string) {return this.api.request('GET', `/v1/controller/sessions/${sessionId}/acceptance`, {auth: await this.auth(), schema: acceptanceSchema});}

  async decryptPreview(previews: SealedPreview[] | null, binding: {actionId: string; fingerprint: string}): Promise<string | null> {
    const mine = previews?.find(item => item.pairingId === this.pairingId);
    const keys = await this.platform.keys.load();
    if (!mine || !keys) return null;
    try {return await openPreview(mine, keys.encryption.privateKey, binding);} catch {return null;}
  }

  // ---------------------------------------------------------------- Signed requests

  ledger(): LedgerEntry[] {
    try {return z.array(z.any()).parse(JSON.parse(this.platform.plain.get(KEYS.ledger) ?? '[]')) as LedgerEntry[];} catch {return [];}
  }
  private saveLedger(entries: LedgerEntry[]) {
    const trimmed = entries.sort((a, b) => b.createdAt - a.createdAt).slice(0, 40);
    this.platform.plain.set(KEYS.ledger, JSON.stringify(trimmed));
    for (const listener of this.ledgerListeners) listener(trimmed);
  }
  private update(requestId: string, change: Partial<LedgerEntry>) {
    this.saveLedger(this.ledger().map(entry => entry.requestId === requestId ? {...entry, ...change} : entry));
  }
  /** An identical request still waiting is reused, so repeated taps send one request. */
  openRequest(sessionId: string, kind: ControlKind, target: object): LedgerEntry | undefined {
    const key = JSON.stringify(target);
    return this.ledger().find(entry => entry.sessionId === sessionId && entry.kind === kind && JSON.stringify(entry.signed.envelope.target) === key && !FINAL.has(entry.status) && entry.signed.envelope.expiresAt > this.now());
  }

  async send<K extends ControlKind>(input: {sessionId: string; runGeneration: number; kind: K; target: ControlTargets[K]; label: string}): Promise<LedgerEntry> {
    const pairingId = this.pairingId;
    if (!pairingId || this.state.status !== 'paired') throw new ApiError(403, 'controller_required', 'Pair this phone from the desktop first.', 'invalid');
    const existing = this.openRequest(input.sessionId, input.kind, input.target);
    if (existing && existing.signed.envelope.runGeneration === input.runGeneration) return this.deliver(existing);
    const keys = await this.platform.keys.load();
    if (!keys) throw new ApiError(500, 'keys_missing', 'This phone lost its pairing key. Pair it again.', 'invalid');
    const envelope = buildEnvelope({pairingId, sessionId: input.sessionId, runGeneration: input.runGeneration, kind: input.kind, target: input.target, now: this.now()});
    const signed = await signControl(envelope, keys.signing.privateKey);
    const entry: LedgerEntry = {requestId: envelope.requestId, sessionId: input.sessionId, kind: input.kind, label: input.label.slice(0, 200), signed, status: 'sending', code: null, message: null, createdAt: Date.now()};
    this.saveLedger([entry, ...this.ledger()]);
    return this.deliver(entry);
  }
  /** Sends (or resends after a lost answer) the same signed request until it is accepted or expires. */
  private async deliver(entry: LedgerEntry): Promise<LedgerEntry> {
    for (let attempt = 0; ; attempt++) {
      try {
        const result = await this.api.request('POST', '/v1/controller/requests', {auth: await this.auth(), body: entry.signed, schema: controlRequestResponse});
        this.update(entry.requestId, {status: result.request.status, code: result.request.code, message: result.request.message});
        return {...entry, status: result.request.status};
      } catch (error) {
        if (!(error instanceof ApiError)) throw error;
        if (error.uncertain && entry.signed.envelope.expiresAt > this.now() + 2_000 && attempt < 4) {
          this.update(entry.requestId, {status: 'sending'});
          await new Promise(resolve => setTimeout(resolve, backoff(attempt, 800, 5_000)));
          continue;
        }
        const status = error.uncertain ? 'unsent' : 'rejected';
        this.update(entry.requestId, {status, code: error.code, message: error.message});
        throw error;
      }
    }
  }
  /** Checks requests that are still waiting, including ones from before a reload or process death. */
  async poll(): Promise<LedgerEntry[]> {
    const open = this.ledger().filter(entry => !FINAL.has(entry.status));
    for (const entry of open) {
      if (entry.status === 'sending' || entry.status === 'unsent') {
        // Never re-sign: resend the exact signed request only while it is still valid.
        if (entry.signed.envelope.expiresAt > this.now()) {await this.deliver(entry).catch(() => undefined); continue;}
      }
      try {
        const result = await this.api.request('GET', `/v1/controller/requests/${entry.requestId}`, {auth: await this.auth(), schema: controlRequestResponse});
        this.update(entry.requestId, {status: result.request.status, code: result.request.code, message: result.request.message});
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) this.update(entry.requestId, {status: entry.signed.envelope.expiresAt > this.now() ? 'unsent' : 'expired', code: 'not_received'});
        else if (!(error instanceof ApiError && error.uncertain)) throw error;
      }
    }
    return this.ledger();
  }

  async unpair(): Promise<void> {
    try {await this.api.request('POST', '/v1/controller/unpair', {auth: await this.auth(), body: {}});} catch {/* Local removal always works. */}
    await this.reset();
    this.set({status: 'unpaired', reason: 'unpaired'});
  }
  /** Forgets every local trace of a pairing: keys, credential, cookie and pending requests. */
  async reset(): Promise<void> {
    this.generation++;
    await this.platform.keys.clear().catch(() => undefined);
    if (this.platform.secure) await this.platform.secure.remove(KEYS.credential);
    else await this.api.request('POST', '/v1/controller/forget', {body: {}}).catch(() => undefined);
    this.platform.plain.remove(KEYS.pairing);
    this.platform.plain.remove(KEYS.claim);
    this.platform.plain.remove(KEYS.ledger);
    this.claimCredential = null;
    for (const listener of this.ledgerListeners) listener([]);
  }
}
