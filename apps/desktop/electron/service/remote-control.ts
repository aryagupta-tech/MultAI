// The original host's side of phone owner control. Pairings the host confirmed are kept here,
// OS-encrypted, with the phone keys the host saw itself. Every request from a phone is verified with
// that key and re-checked against what this computer actually holds (the waiting approval and its
// fingerprint, the session generation, the exact queue) before the host does it with its own
// authority. The service relays requests; it cannot create one this host would accept.
import {z} from 'zod';
import {encode} from 'uqr';
import {keyThumbprint, sealPreview, verificationCode, verifyControl, type ControlEnvelope, type PublicJwk, type SealedPreview} from '@multai/companion-core';
import type {ApprovalBroker} from '../inference/approvals';
import type {HostCoordinator} from '../inference/coordinator';
import type {HostRunChange} from '../../src/bridge/execution';
import type {ControllerApi, PairedPhone, PairingOffer, PairingReview} from '../../src/bridge/controller';
import type {Result} from '../../src/bridge/contract';
import {toError} from './account';

const uuid = z.uuid();
const jwk = z.object({kty: z.literal('EC'), crv: z.literal('P-256'), x: z.string().regex(/^[A-Za-z0-9_-]{43}$/u), y: z.string().regex(/^[A-Za-z0-9_-]{43}$/u)});
const pairingSchema = z.object({
  id: uuid, status: z.enum(['awaiting_device', 'awaiting_confirmation', 'active', 'declined', 'revoked']), sessionIds: z.array(uuid).max(20), grantSeconds: z.number().int(),
  deviceName: z.string().max(120).nullable(), platform: z.enum(['android', 'ios', 'web']).nullable(), keyThumbprint: z.string().nullable(),
  signingKey: jwk.nullable(), encryptionKey: jwk.nullable(), codeExpiresAt: z.string(), createdAt: z.string(),
  confirmedAt: z.string().nullable(), expiresAt: z.string().nullable(), revokedAt: z.string().nullable(), revokedBy: z.string().nullable(), lastSeenAt: z.string().nullable(),
});
type ServicePairing = z.infer<typeof pairingSchema>;
const requestSchema = z.object({id: uuid, pairingId: uuid, sessionId: uuid, envelope: z.unknown(), signature: z.string().regex(/^[A-Za-z0-9_-]{86}$/u)});
const sessionSchema = z.object({session: z.object({runtimeGeneration: z.number().int().positive(), status: z.enum(['inactive', 'paused', 'running']), capabilities: z.object({execute: z.boolean()})})});

/** What this host trusts about a phone. Written only when the host confirms it on this computer. */
export interface TrustedPhone {pairingId: string; deviceName: string; platform: string; signingKey: PublicJwk; encryptionKey: PublicJwk; thumbprint: string; sessionIds: string[]; expiresAt: number; confirmedAt: number}
export interface TrustStore {load(): Promise<TrustedPhone[]>; save(value: TrustedPhone[]): Promise<void>}

export interface RemoteControlOptions {
  request: (method: string, path: string, body?: unknown) => Promise<unknown>;
  /** Changes when the signed-in account changes; work for an older account is dropped. */
  accountGeneration: () => number;
  trust: (accountKey: string) => TrustStore;
  identity: () => Promise<{userId: string; deviceId: string}>;
  coordinator: Pick<HostCoordinator, 'run' | 'stop' | 'conflictContext' | 'selection' | 'lockedActions'>;
  approvals: Pick<ApprovalBroker, 'waiting' | 'decideExact' | 'access'>;
  now?: () => number;
  onChange?: () => void;
  log?: (message: string) => void;
}

export class RemoteControlError extends Error {constructor(readonly code: string, message: string) {super(message);}}
type Outcome = {outcome: 'accepted' | 'rejected'; code: string; message?: string};
const refuse = (code: string, message: string): Outcome => ({outcome: 'rejected', code, message});

export class RemoteControlHost implements ControllerApi {
  private trusted: TrustedPhone[] = [];
  private store: TrustStore | null = null;
  private running = false;
  private loop: Promise<void> | null = null;
  private heartbeat: NodeJS.Timeout | undefined;
  /** Requests issued before this moment are never executed: not after launch, sign-in, sleep or a reconnect. */
  private since = 0;
  private generation = -1;
  private loopToken = 0;
  private readonly runs = new Map<string, {status: HostRunChange['status'] | 'idle'; at: number}>();
  private readonly handled = new Map<string, Outcome>();
  private readonly generations = new Map<string, number>();
  private sleeping = false;
  private serial: Promise<unknown> = Promise.resolve();
  private readonly now: () => number;
  constructor(private readonly options: RemoteControlOptions) {this.now = options.now ?? Date.now;}

  // ---------------------------------------------------------------- Lifecycle

  /** Starts (or restarts) for the current account. Old requests are never picked up. */
  async start(force = false): Promise<void> {
    // Sign-in state is reported repeatedly; only a new account (or a wake-up) restarts the listener.
    if (!force && this.running && this.generation === this.options.accountGeneration()) return;
    this.stopLoop();
    const identity = await this.options.identity();
    this.generation = this.options.accountGeneration();
    this.store = this.options.trust(`${identity.userId}:${identity.deviceId}`);
    this.trusted = (await this.store.load()).filter(phone => phone.expiresAt > this.now());
    this.since = this.now();
    this.sleeping = false;
    this.handled.clear();
    this.running = true;
    this.loop = this.poll(++this.loopToken);
    this.heartbeat = setInterval(() => void this.publishAll().catch(() => undefined), 15_000);
    this.heartbeat.unref?.();
    void this.publishAll().catch(() => undefined);
  }
  private stopLoop() {
    this.running = false;
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = undefined;
  }
  /** Sign-out or account change: forget everything in memory; the encrypted trust list stays per account. */
  async stop(): Promise<void> {
    this.stopLoop();
    await this.publishAll('signing_out').catch(() => undefined);
    this.trusted = [];
    this.store = null;
    await this.loop?.catch(() => undefined);
    this.loop = null;
  }
  async suspend(): Promise<void> {
    this.sleeping = true;
    this.stopLoop();
    await this.publishAll('asleep').catch(() => undefined);
  }
  async resume(): Promise<void> {if (this.store) await this.start(true);}
  covers(sessionId: string): boolean {return this.trusted.some(phone => phone.sessionIds.includes(sessionId) && phone.expiresAt > this.now());}

  runChanged(change: HostRunChange): void {
    this.runs.set(change.sessionId, {status: change.status, at: this.now()});
    if (this.covers(change.sessionId)) void this.publish(change.sessionId).catch(() => undefined);
  }
  approvalsChanged(sessionIds: string[]): void {
    for (const sessionId of new Set(sessionIds)) if (this.covers(sessionId)) void this.publish(sessionId).catch(() => undefined);
  }

  private stale(generation: number, token: number) {return !this.running || token !== this.loopToken || generation !== this.options.accountGeneration();}
  private async poll(token: number): Promise<void> {
    const generation = this.generation;
    let failures = 0;
    while (!this.stale(generation, token)) {
      if (!this.trusted.length) {await new Promise(resolve => setTimeout(resolve, 3_000)); continue;}
      try {
        const raw = await this.options.request('GET', '/v1/host/control-requests?wait=10');
        failures = 0;
        const requests = z.object({requests: z.array(requestSchema).max(20)}).parse(raw).requests;
        for (const item of requests) {
          if (this.stale(generation, token)) return;
          await this.process(item);
        }
      } catch {
        failures++;
        await new Promise(resolve => setTimeout(resolve, Math.min(30_000, 1_000 * 2 ** Math.min(failures, 5))));
      }
    }
  }

  // ---------------------------------------------------------------- Requests

  private async process(item: z.infer<typeof requestSchema>): Promise<void> {
    const previous = this.handled.get(item.id);
    const outcome = previous ?? await this.decide(item).catch((): Outcome => refuse('host_error', 'The desktop couldn’t complete this request.'));
    this.handled.set(item.id, outcome);
    if (this.handled.size > 500) this.handled.delete(this.handled.keys().next().value!);
    await this.options.request('POST', `/v1/host/control-requests/${item.id}/ack`, {outcome: outcome.outcome, code: outcome.code, ...(outcome.message ? {message: outcome.message} : {})}).catch(() => undefined);
    this.options.onChange?.();
    void this.publish(item.sessionId).catch(() => undefined);
  }

  /** Independent checks, in order. The service already checked most of these; the host does not rely on it. */
  async decide(item: {id: string; pairingId: string; sessionId: string; envelope: unknown; signature: string}): Promise<Outcome> {
    const phone = this.trusted.find(entry => entry.pairingId === item.pairingId);
    if (!phone) return refuse('unknown_phone', 'This desktop doesn’t trust that phone.');
    if (phone.expiresAt <= this.now()) return refuse('pairing_expired', 'This phone’s owner access expired.');
    const envelope = item.envelope as ControlEnvelope;
    if (!envelope || typeof envelope !== 'object' || envelope.requestId !== item.id || envelope.pairingId !== phone.pairingId || envelope.sessionId !== item.sessionId) return refuse('request_mismatch', 'The request doesn’t match its envelope.');
    if (!await verifyControl({envelope, signature: item.signature}, phone.signingKey)) return refuse('bad_signature', 'The phone’s signature didn’t verify on the desktop.');
    if (!phone.sessionIds.includes(envelope.sessionId)) return refuse('session_scope', 'That phone isn’t paired for this session.');
    const now = this.now();
    if (envelope.expiresAt <= now) return refuse('expired', 'The request expired before the desktop received it.');
    if (envelope.issuedAt < this.since - 5_000) return refuse('issued_before_reconnect', 'The desktop reconnected after this was sent. Review the current state and try again.');
    if (envelope.expiresAt - envelope.issuedAt > 120_000) return refuse('expired', 'The request lasted too long.');
    const session = sessionSchema.parse(await this.options.request('GET', `/v1/sessions/${envelope.sessionId}`)).session;
    if (!session.capabilities.execute) return refuse('host_required', 'This computer is not the session’s original host.');
    this.generations.set(envelope.sessionId, session.runtimeGeneration);
    if (session.runtimeGeneration !== envelope.runGeneration) return refuse('stale_generation', 'The session changed on the desktop since the phone looked.');
    switch (envelope.kind) {
      case 'approve': case 'reject': {
        const decided = this.options.approvals.decideExact(envelope.target.actionId, envelope.sessionId, envelope.target.actionFingerprint, envelope.kind === 'approve');
        if (decided === 'changed') return refuse('action_changed', 'The action changed. Review the new one.');
        if (decided === 'unavailable') return refuse('approval_unavailable', 'That approval was already decided, stopped or expired.');
        return {outcome: 'accepted', code: envelope.kind === 'approve' ? 'approved' : 'rejected_action'};
      }
      case 'stop': {
        if (session.status !== 'running') return refuse('not_running', 'The agent wasn’t running.');
        await this.options.coordinator.stop(envelope.sessionId);
        return {outcome: 'accepted', code: 'stopped'};
      }
      case 'steer': {
        if (session.status !== 'running') return refuse('not_running', 'The agent isn’t running.');
        await this.options.request('POST', `/v1/sessions/${envelope.sessionId}/instructions/${envelope.target.instructionId}/steer`, {});
        return {outcome: 'accepted', code: 'steered'};
      }
      case 'start': case 'resolve': {
        if (session.status === 'running') return refuse('session_active', 'The agent is already working.');
        const context = await this.options.coordinator.conflictContext(envelope.sessionId);
        if (context.fingerprint !== envelope.target.queueFingerprint) return refuse('queue_changed', 'The pending directions changed. Review them again.');
        if (!context.pending.some(row => row.id === envelope.target.instructionId)) return refuse('instruction_unavailable', 'That instruction is no longer pending.');
        if (envelope.kind === 'start' && context.requiresReview) return refuse('instruction_conflict', 'Several people have pending directions. Resolve them first.');
        const selection = await this.options.coordinator.selection();
        if (!selection) return refuse('no_model', 'Choose a model on the desktop first.');
        await this.options.coordinator.run({sessionId: envelope.sessionId, instructionId: envelope.target.instructionId, connectionId: selection.connectionId, model: selection.model,
          ...(envelope.kind === 'resolve' ? {resolution: envelope.target.resolution, resolutionFingerprint: envelope.target.queueFingerprint} : {})});
        return {outcome: 'accepted', code: 'started'};
      }
    }
  }

  // ---------------------------------------------------------------- What the phone sees

  private async publishAll(host: 'online' | 'asleep' | 'signing_out' = 'online') {
    const sessions = [...new Set(this.trusted.flatMap(phone => phone.sessionIds))].slice(0, 20);
    for (const sessionId of sessions) await this.publish(sessionId, host).catch(() => undefined);
  }
  private publish(sessionId: string, host: 'online' | 'asleep' | 'signing_out' = this.sleeping ? 'asleep' : 'online'): Promise<void> {
    // One report at a time keeps the service's view in order.
    const next = this.serial.then(async () => {
      const state = await this.state(sessionId, host);
      await this.options.request('PUT', `/v1/sessions/${sessionId}/control-state`, {state});
    });
    this.serial = next.catch(() => undefined);
    return next;
  }
  async state(sessionId: string, host: 'online' | 'asleep' | 'signing_out') {
    let generation = this.generations.get(sessionId);
    if (!generation || host === 'online') {
      const session = sessionSchema.parse(await this.options.request('GET', `/v1/sessions/${sessionId}`)).session;
      generation = session.runtimeGeneration;
      this.generations.set(sessionId, generation);
    }
    const waiting = this.options.approvals.waiting(sessionId)[0];
    const run = this.runs.get(sessionId);
    const phones = this.trusted.filter(phone => phone.sessionIds.includes(sessionId));
    let preview: SealedPreview[] | null = null;
    if (waiting?.approval.kind === 'file_write' && waiting.preview) {
      // Only the paired phones can read a proposed file change; the service relays ciphertext.
      preview = await Promise.all(phones.slice(0, 5).map(phone => sealPreview(waiting.preview!.slice(0, 6_000), phone.encryptionKey, {pairingId: phone.pairingId, actionId: waiting.approval.id, fingerprint: waiting.fingerprint})));
    }
    const locked = await this.options.coordinator.lockedActions(sessionId).then(list => list.length).catch(() => 0);
    const selection = await this.options.coordinator.selection().catch(() => null);
    const status = waiting ? 'blocked' : run?.status === 'running' ? 'running' : run && run.status !== 'idle' ? run.status : 'idle';
    return {
      v: 1 as const, host, runtimeGeneration: generation,
      run: {status, runId: null, at: run?.at ?? 0},
      approval: waiting ? {
        actionId: waiting.approval.id, fingerprint: waiting.fingerprint, kind: waiting.approval.kind, reason: waiting.approval.reason.slice(0, 500), expiresAt: Date.parse(waiting.approval.expiresAt),
        summary: (waiting.approval.kind === 'file_write' ? `${waiting.approval.newFile ? 'Create' : 'Change'} ${waiting.approval.path}` : waiting.approval.command).slice(0, 2000),
        path: waiting.approval.kind === 'file_write' ? waiting.approval.path.slice(0, 1024) : null,
        newFile: waiting.approval.kind === 'file_write' ? waiting.approval.newFile : null,
        preview,
      } : null,
      access: this.options.approvals.access(sessionId),
      model: selection ? (selection.modelName ?? selection.model).slice(0, 200) : null,
      locked: Math.min(100, locked),
    };
  }

  // ---------------------------------------------------------------- Pairing (renderer API)

  private requireStore(): TrustStore {
    if (!this.store) throw new RemoteControlError('signed_out', 'Sign in on this computer first.');
    return this.store;
  }
  async createPairing(sessionIds: string[], grantSeconds: number): Promise<PairingOffer> {
    this.requireStore();
    const raw = await this.options.request('POST', '/v1/controller-pairings', {sessionIds, grantSeconds});
    const created = z.object({pairing: pairingSchema.extend({code: z.string(), link: z.url()})}).parse(raw).pairing;
    const qr = encode(created.link, {ecc: 'M', border: 2});
    return {id: created.id, code: created.code, link: created.link, codeExpiresAt: created.codeExpiresAt, sessionIds: created.sessionIds, qr: qr.data.map(row => row.map(Boolean))};
  }
  /** The host computes the fingerprint and six digits from the keys it received, never trusting the service's copy. */
  async reviewPairing(id: string): Promise<PairingReview> {
    const pairing = pairingSchema.parse((await this.options.request('GET', `/v1/controller-pairings/${uuid.parse(id)}`) as {pairing: unknown}).pairing);
    const review: PairingReview = {id: pairing.id, status: pairing.status, sessionIds: pairing.sessionIds, grantSeconds: pairing.grantSeconds, deviceName: pairing.deviceName, platform: pairing.platform, codeExpiresAt: pairing.codeExpiresAt, verificationCode: null};
    if (pairing.signingKey && pairing.encryptionKey) {
      const thumbprint = await keyThumbprint(pairing.signingKey, pairing.encryptionKey);
      review.verificationCode = await verificationCode(pairing.id, thumbprint);
    }
    return review;
  }
  async confirmPairing(id: string, sessionIds: string[]): Promise<PairedPhone> {
    const store = this.requireStore();
    const pairing = pairingSchema.parse((await this.options.request('GET', `/v1/controller-pairings/${uuid.parse(id)}`) as {pairing: unknown}).pairing);
    if (pairing.status !== 'awaiting_confirmation' || !pairing.signingKey || !pairing.encryptionKey) throw new RemoteControlError('pairing_unavailable', 'This phone isn’t waiting for confirmation. Start pairing again.');
    const thumbprint = await keyThumbprint(pairing.signingKey, pairing.encryptionKey);
    const confirmed = pairingSchema.parse((await this.options.request('POST', `/v1/controller-pairings/${pairing.id}/confirm`, {keyThumbprint: thumbprint, sessionIds}) as {pairing: unknown}).pairing);
    const phone: TrustedPhone = {pairingId: confirmed.id, deviceName: confirmed.deviceName ?? 'Phone', platform: confirmed.platform ?? 'web', signingKey: pairing.signingKey, encryptionKey: pairing.encryptionKey, thumbprint,
      sessionIds: confirmed.sessionIds, expiresAt: Date.parse(confirmed.expiresAt ?? '') || this.now() + confirmed.grantSeconds * 1000, confirmedAt: this.now()};
    this.trusted = [...this.trusted.filter(entry => entry.pairingId !== phone.pairingId), phone];
    await store.save(this.trusted);
    void this.publishAll().catch(() => undefined);
    this.options.onChange?.();
    return this.view(confirmed, phone);
  }
  async declinePairing(id: string): Promise<null> {
    await this.options.request('POST', `/v1/controller-pairings/${uuid.parse(id)}/decline`);
    return null;
  }
  async revokePairing(id: string): Promise<null> {
    const store = this.requireStore();
    // Local trust goes first: even if the service is unreachable, this host stops honoring the phone now.
    this.trusted = this.trusted.filter(entry => entry.pairingId !== uuid.parse(id));
    await store.save(this.trusted);
    this.options.onChange?.();
    await this.options.request('DELETE', `/v1/controller-pairings/${id}`).catch(error => {this.options.log?.('Revocation will be retried by the service on next contact.'); throw error;});
    return null;
  }
  async listPhones(): Promise<PairedPhone[]> {
    const store = this.requireStore();
    const pairings = z.object({pairings: z.array(pairingSchema)}).parse(await this.options.request('GET', '/v1/controller-pairings')).pairings;
    // A pairing the service shows as active but this host never confirmed is not trusted here.
    const before = this.trusted.length;
    this.trusted = this.trusted.filter(phone => phone.expiresAt > this.now() && pairings.some(item => item.id === phone.pairingId && item.status === 'active'));
    if (this.trusted.length !== before) await store.save(this.trusted);
    return pairings.filter(item => item.status === 'active' || item.status === 'revoked').slice(0, 20).map(item => this.view(item, this.trusted.find(phone => phone.pairingId === item.id)));
  }
  async audit(id: string): Promise<{event: string; at: string; detail: string}[]> {
    const rows = z.object({audit: z.array(z.object({event: z.string(), at: z.string(), detail: z.unknown()}))}).parse(await this.options.request('GET', `/v1/controller-pairings/${uuid.parse(id)}/audit`)).audit;
    return rows.slice(0, 100).map(row => ({event: row.event, at: row.at, detail: describeAudit(row.event, row.detail)}));
  }
  private view(item: ServicePairing, phone?: TrustedPhone): PairedPhone {
    return {id: item.id, deviceName: item.deviceName ?? 'Phone', platform: item.platform ?? 'web', status: item.status === 'active' && phone ? 'active' : item.status === 'active' ? 'untrusted' : 'revoked',
      sessionIds: item.sessionIds, expiresAt: item.expiresAt, lastSeenAt: item.lastSeenAt, revokedAt: item.revokedAt, revokedBy: item.revokedBy, confirmedAt: item.confirmedAt};
  }
}

function describeAudit(event: string, detail: unknown): string {
  const d = (detail ?? {}) as {kind?: string; code?: string; by?: string; deviceName?: string};
  switch (event) {
    case 'pairing.created': return 'Pairing code created on this desktop';
    case 'pairing.claimed': return `Claimed by ${d.deviceName ?? 'a phone'}`;
    case 'pairing.confirmed': return 'Confirmed on this desktop';
    case 'pairing.declined': return 'Declined on this desktop';
    case 'pairing.revoked': return d.by === 'controller' ? 'Removed from the phone' : 'Removed on this desktop';
    case 'pairing.expired': return 'Owner access expired';
    case 'request.submitted': return `Phone asked to ${d.kind ?? 'act'}`;
    case 'request.accepted': return `Desktop did ${d.kind ?? 'it'} (${d.code ?? 'ok'})`;
    case 'request.rejected': return `Desktop refused ${d.kind ?? 'it'} (${d.code ?? 'refused'})`;
    default: return event;
  }
}

const controllerSchemas = {
  createPairing: z.tuple([z.array(uuid).min(1).max(20), z.number().int().min(3600).max(2_592_000)]),
  reviewPairing: z.tuple([uuid]), confirmPairing: z.tuple([uuid, z.array(uuid).min(1).max(20)]), declinePairing: z.tuple([uuid]),
  revokePairing: z.tuple([uuid]), listPhones: z.tuple([]), audit: z.tuple([uuid]),
} satisfies Record<keyof ControllerApi, z.ZodType>;
/** Every renderer argument is validated before the host acts. */
export async function routeController(host: ControllerApi, op: unknown, args: unknown): Promise<Result<unknown>> {
  if (typeof op !== 'string' || !Object.hasOwn(controllerSchemas, op)) return {ok: false, error: {code: 'invalid_request', message: 'Unknown phone operation.'}};
  const parsed = controllerSchemas[op as keyof ControllerApi].safeParse(args);
  if (!parsed.success) return {ok: false, error: {code: 'invalid_request', message: 'Phone pairing fields are invalid.'}};
  try {
    const call = host[op as keyof ControllerApi] as (...values: unknown[]) => Promise<unknown>;
    return {ok: true, value: await call.apply(host, parsed.data as unknown[])};
  } catch (error) {return {ok: false, error: error instanceof RemoteControlError ? {code: error.code, message: error.message} : toError(error)};}
}
