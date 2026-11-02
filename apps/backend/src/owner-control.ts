// Paired owner controllers. The original host pairs a phone with a short-lived one-use code, sees the
// phone's name and key fingerprint, and confirms it. The phone then signs each request with a key that
// never leaves it; this service checks the binding to the session's current state, and the host verifies
// the signature again with the key it stored itself, re-checks everything and executes with its own
// authority. A controller is never a native account and cannot reach execution routes.
import {createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify as verifySignature} from 'node:crypto';
import type {FastifyInstance, FastifyReply, FastifyRequest} from 'fastify';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {CollaborationService, requireOriginalHost, type SessionRow} from './collaboration.js';
import {assertActor, transaction, type Database} from './db.js';
import {ApiError} from './errors.js';
import {directionFingerprint, pendingDirections, priorSteeringConflict, redact} from './execution.js';
import {readAcceptance} from './acceptance.js';
import type {Actor} from './types.js';

const uuid = z.uuid();
const hex64 = z.string().regex(/^[a-f0-9]{64}$/u);
const secret = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const plain = (max: number) => z.string().trim().min(1).max(max).refine(value => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value));

/** Sorted-key JSON. Identical in packages/companion-core and the desktop host. */
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export const CONTROL_DOMAIN = 'multai-control-v1\n';
export const PAIR_DOMAIN = 'multai-pair-v1\n';
export const MAX_REQUEST_LIFETIME_MS = 120_000;
/** A phone clock may run a little ahead of the service's. */
const CLOCK_SKEW_MS = 30_000;

const jwkSchema = z.object({kty: z.literal('EC'), crv: z.literal('P-256'), x: z.string().regex(/^[A-Za-z0-9_-]{43}$/u), y: z.string().regex(/^[A-Za-z0-9_-]{43}$/u)}).strict();
export type PublicJwk = z.infer<typeof jwkSchema>;
const publicPart = (key: PublicJwk) => ({crv: key.crv, kty: key.kty, x: key.x, y: key.y});
/** One fingerprint over both phone keys, shown on both screens before the host confirms. */
export function keyThumbprint(signingKey: PublicJwk, encryptionKey: PublicJwk): string {
  return digest(stable({enc: publicPart(encryptionKey), sign: publicPart(signingKey)}));
}
/** Six digits both screens show; a substituted key changes them. */
export function verificationCode(pairingId: string, thumbprint: string): string {
  const value = createHash('sha256').update(`${PAIR_DOMAIN}${pairingId}\n${thumbprint}`).digest().readUInt32BE(0) % 1_000_000;
  const text = value.toString().padStart(6, '0');
  return `${text.slice(0, 3)} ${text.slice(3)}`;
}

const target = {
  start: z.object({instructionId: uuid, queueFingerprint: hex64}).strict(),
  resolve: z.object({instructionId: uuid, queueFingerprint: hex64, resolution: plain(8000)}).strict(),
  stop: z.object({}).strict(),
  steer: z.object({instructionId: uuid}).strict(),
  approve: z.object({actionId: uuid, actionFingerprint: hex64}).strict(),
  reject: z.object({actionId: uuid, actionFingerprint: hex64}).strict(),
};
const common = {v: z.literal(1), pairingId: uuid, requestId: uuid, sessionId: uuid, runGeneration: z.number().int().positive().max(2_147_483_647), issuedAt: z.number().int().positive(), expiresAt: z.number().int().positive()};
export const envelopeSchema = z.discriminatedUnion('kind', [
  z.object({...common, kind: z.literal('start'), target: target.start}).strict(),
  z.object({...common, kind: z.literal('resolve'), target: target.resolve}).strict(),
  z.object({...common, kind: z.literal('stop'), target: target.stop}).strict(),
  z.object({...common, kind: z.literal('steer'), target: target.steer}).strict(),
  z.object({...common, kind: z.literal('approve'), target: target.approve}).strict(),
  z.object({...common, kind: z.literal('reject'), target: target.reject}).strict(),
]);
export type ControlEnvelope = z.infer<typeof envelopeSchema>;
const signatureSchema = z.string().regex(/^[A-Za-z0-9_-]{86}$/u);

export function controlBytes(envelope: ControlEnvelope): Buffer {
  return Buffer.from(`${CONTROL_DOMAIN}${stable(envelope)}`, 'utf8');
}
export function verifyControl(envelope: ControlEnvelope, signature: string, key: PublicJwk): boolean {
  try {
    const publicKey = createPublicKey({key: publicPart(key), format: 'jwk'});
    return verifySignature('sha256', controlBytes(envelope), {key: publicKey, dsaEncoding: 'ieee-p1363'}, Buffer.from(signature, 'base64url'));
  } catch {return false;}
}

const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** 12 Crockford base32 characters: 60 random bits, valid for five minutes and one claim. */
function pairingCode(): string {
  const bytes = randomBytes(12);
  return [...bytes].map(byte => CODE_ALPHABET[byte & 31]).join('');
}
export function normalizeCode(raw: string): string | null {
  const value = raw.toUpperCase().replace(/[\s-]/gu, '').replace(/O/gu, '0').replace(/[IL]/gu, '1');
  return /^[0-9A-HJKMNP-TV-Z]{12}$/u.test(value) ? value : null;
}
const formatCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
const equal = (a: string, b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));

interface PairingRow {
  id: string; owner_id: string; host_device_id: string; code_hash: string | null; code_expires_at: Date;
  status: 'awaiting_device' | 'awaiting_confirmation' | 'active' | 'declined' | 'revoked';
  session_ids: string[]; grant_seconds: number; claim_request_id: string | null; claim_fingerprint: string | null;
  device_name: string | null; device_platform: 'android' | 'ios' | 'web' | null; signing_key: PublicJwk | null; encryption_key: PublicJwk | null;
  key_thumbprint: string | null; token_hash: string | null; claimed_at: Date | null; confirmed_at: Date | null; expires_at: Date | null;
  revoked_at: Date | null; revoked_by: string | null; last_seen_at: Date | null; created_at: Date;
}
interface RequestRow {
  id: string; pairing_id: string; session_id: string; kind: ControlEnvelope['kind']; envelope: ControlEnvelope; fingerprint: string; signature: string;
  run_generation: number; issued_at: Date; expires_at: Date; status: 'pending' | 'delivered' | 'accepted' | 'rejected' | 'expired' | 'canceled';
  result_code: string | null; result_message: string | null; delivered_at: Date | null; acknowledged_at: Date | null; created_at: Date;
}
export interface Controller {pairingId: string; ownerId: string; hostDeviceId: string; sessionIds: string[]; status: PairingRow['status']}

const controllerDenied = (code = 'controller_revoked', message = 'This phone is no longer paired. Pair it again from the desktop.') => new ApiError(403, code, message);

/** What the original host reports for a paired phone. Shape-checked here; the host stays the authority. */
const hostStateSchema = z.object({
  v: z.literal(1),
  host: z.enum(['online', 'asleep', 'signing_out']),
  runtimeGeneration: z.number().int().positive(),
  run: z.object({status: z.enum(['idle', 'starting', 'running', 'blocked', 'completed', 'failed', 'stopped']), runId: uuid.nullable(), at: z.number().int().nonnegative()}).strict(),
  approval: z.object({actionId: uuid, fingerprint: hex64, kind: z.enum(['file_write', 'shell', 'external']), summary: z.string().max(2000), path: z.string().max(1024).nullable(), newFile: z.boolean().nullable(), reason: z.string().max(500), expiresAt: z.number().int().positive(),
    preview: z.object({iv: z.string().max(32), salt: z.string().max(64), ephemeral: jwkSchema, data: z.string().max(24_000), pairingId: uuid}).strict().array().max(5).nullable()}).strict().nullable(),
  access: z.enum(['ask', 'auto', 'full']),
  model: z.string().max(200).nullable(),
  locked: z.number().int().min(0).max(100),
}).strict();

export class OwnerControlService extends CollaborationService {
  constructor(db: Database, private readonly publicOrigin: string) {super(db);}

  private async hostSession(client: PoolClient, actor: Actor, sessionId: string) {
    const authorized = await this.authorize(client, actor, uuid.parse(sessionId));
    requireOriginalHost(authorized, actor);
    return authorized.session;
  }
  private async audit(client: PoolClient, pairingId: string, event: string, detail: Record<string, unknown> = {}, sessionId: string | null = null) {
    await client.query('INSERT INTO controller_audit(id,pairing_id,session_id,event,detail) VALUES($1,$2,$3,$4,$5)', [randomUUID(), pairingId, sessionId, event, JSON.stringify(detail)]);
  }
  /** Expired grants are revoked durably on first sight, so every path agrees. */
  private async expire(client: PoolClient, row: PairingRow) {
    if (row.status === 'active' && row.expires_at && row.expires_at.getTime() <= Date.now()) {
      await client.query("UPDATE controller_pairings SET status='revoked',revoked_at=now(),revoked_by='expiry' WHERE id=$1", [row.id]);
      await client.query("UPDATE control_requests SET status='expired' WHERE pairing_id=$1 AND status IN ('pending','delivered')", [row.id]);
      await this.audit(client, row.id, 'pairing.expired');
      row.status = 'revoked'; row.revoked_by = 'expiry';
    }
  }
  private pairingView(row: PairingRow) {
    return {
      id: row.id, status: row.status, sessionIds: row.session_ids, grantSeconds: row.grant_seconds,
      deviceName: row.device_name, platform: row.device_platform,
      keyThumbprint: row.key_thumbprint, signingKey: row.signing_key, encryptionKey: row.encryption_key,
      verificationCode: row.key_thumbprint ? verificationCode(row.id, row.key_thumbprint) : null,
      codeExpiresAt: row.code_expires_at.toISOString(), createdAt: row.created_at.toISOString(),
      claimedAt: row.claimed_at?.toISOString() ?? null, confirmedAt: row.confirmed_at?.toISOString() ?? null,
      expiresAt: row.expires_at?.toISOString() ?? null, revokedAt: row.revoked_at?.toISOString() ?? null, revokedBy: row.revoked_by,
      lastSeenAt: row.last_seen_at?.toISOString() ?? null,
    };
  }

  // ---------------------------------------------------------------- Host: pairing and devices

  async createPairing(actor: Actor, input: unknown) {
    const body = z.object({sessionIds: z.array(uuid).min(1).max(20), grantSeconds: z.number().int().min(3600).max(2_592_000).default(604_800)}).strict().parse(input);
    const sessionIds = [...new Set(body.sessionIds)].sort();
    return transaction(this.db, async client => {
      await assertActor(client, actor);
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [`controller-pairing:${actor.userId}:${actor.deviceId}`]);
      for (const id of sessionIds) await this.hostSession(client, actor, id);
      const open = await client.query<{count: number}>(`SELECT count(*)::int AS count FROM controller_pairings WHERE owner_id=$1 AND host_device_id=$2
        AND (status='active' OR (status IN ('awaiting_device','awaiting_confirmation') AND code_expires_at>now()-interval '10 minutes'))`, [actor.userId, actor.deviceId]);
      if (open.rows[0]!.count >= 10) throw new ApiError(409, 'pairing_capacity', 'Remove a paired phone before pairing another.');
      const id = randomUUID(), code = pairingCode();
      const result = await client.query<PairingRow>(`INSERT INTO controller_pairings(id,owner_id,host_device_id,code_hash,code_expires_at,session_ids,grant_seconds)
        VALUES($1,$2,$3,$4,now()+interval '5 minutes',$5,$6) RETURNING *`, [id, actor.userId, actor.deviceId, digest(code), sessionIds, body.grantSeconds]);
      await this.audit(client, id, 'pairing.created', {sessionIds, grantSeconds: body.grantSeconds});
      // The code travels in the fragment, which browsers never send to a server.
      return {pairing: {...this.pairingView(result.rows[0]!), code: formatCode(code), link: `${this.publicOrigin}/app/#pair=${code}`}};
    });
  }
  private async ownPairing(client: PoolClient, actor: Actor, id: string) {
    await assertActor(client, actor);
    const found = await client.query<PairingRow>('SELECT * FROM controller_pairings WHERE id=$1 AND owner_id=$2 AND host_device_id=$3 FOR UPDATE', [uuid.parse(id), actor.userId, actor.deviceId]);
    if (!found.rows[0]) throw new ApiError(404, 'pairing_not_found', 'That paired phone was not found on this computer.');
    await this.expire(client, found.rows[0]);
    return found.rows[0];
  }
  async listPairings(actor: Actor) {
    return transaction(this.db, async client => {
      await assertActor(client, actor);
      const rows = await client.query<PairingRow>(`SELECT * FROM controller_pairings WHERE owner_id=$1 AND host_device_id=$2
        AND (status IN ('active','awaiting_confirmation') OR created_at>now()-interval '30 days') ORDER BY created_at DESC LIMIT 50`, [actor.userId, actor.deviceId]);
      for (const row of rows.rows) await this.expire(client, row);
      return {pairings: rows.rows.map(row => this.pairingView(row))};
    });
  }
  async getPairing(actor: Actor, id: string) {
    return transaction(this.db, async client => ({pairing: this.pairingView(await this.ownPairing(client, actor, id))}));
  }
  async confirmPairing(actor: Actor, id: string, input: unknown) {
    const body = z.object({keyThumbprint: hex64, sessionIds: z.array(uuid).min(1).max(20)}).strict().parse(input);
    return transaction(this.db, async client => {
      const row = await this.ownPairing(client, actor, id);
      if (row.status === 'active' && row.key_thumbprint === body.keyThumbprint) return {pairing: this.pairingView(row)};
      if (row.status !== 'awaiting_confirmation' || row.code_expires_at.getTime() + 600_000 <= Date.now()) throw new ApiError(409, 'pairing_unavailable', 'This pairing is no longer waiting. Start pairing again.');
      if (!row.key_thumbprint || !equal(row.key_thumbprint, body.keyThumbprint)) throw new ApiError(409, 'pairing_key_changed', 'The phone’s key changed. Start pairing again.');
      const sessions = [...new Set(body.sessionIds)].sort();
      if (sessions.some(sessionId => !row.session_ids.includes(sessionId))) throw new ApiError(409, 'pairing_scope', 'A phone can only be confirmed for the sessions offered when pairing started.');
      for (const sessionId of sessions) await this.hostSession(client, actor, sessionId);
      const updated = await client.query<PairingRow>(`UPDATE controller_pairings SET status='active',session_ids=$2,confirmed_at=now(),expires_at=now()+grant_seconds*interval '1 second'
        WHERE id=$1 RETURNING *`, [row.id, sessions]);
      await this.audit(client, row.id, 'pairing.confirmed', {sessionIds: sessions, deviceName: row.device_name});
      return {pairing: this.pairingView(updated.rows[0]!)};
    });
  }
  async declinePairing(actor: Actor, id: string) {
    return transaction(this.db, async client => {
      const row = await this.ownPairing(client, actor, id);
      if (row.status === 'declined') return {pairing: this.pairingView(row)};
      if (!['awaiting_device', 'awaiting_confirmation'].includes(row.status)) throw new ApiError(409, 'pairing_unavailable', 'Remove an active phone instead.');
      const updated = await client.query<PairingRow>("UPDATE controller_pairings SET status='declined',token_hash=NULL WHERE id=$1 RETURNING *", [row.id]);
      await this.audit(client, row.id, 'pairing.declined');
      return {pairing: this.pairingView(updated.rows[0]!)};
    });
  }
  async revokePairing(actor: Actor, id: string) {
    return transaction(this.db, async client => {
      const row = await this.ownPairing(client, actor, id);
      if (row.status !== 'revoked') await this.revoke(client, row, 'host');
      return {revoked: true};
    });
  }
  private async revoke(client: PoolClient, row: PairingRow, by: 'host' | 'controller') {
    await client.query("UPDATE controller_pairings SET status='revoked',revoked_at=now(),revoked_by=$2,token_hash=NULL WHERE id=$1", [row.id, by]);
    await client.query("UPDATE control_requests SET status='canceled',result_code='pairing_revoked' WHERE pairing_id=$1 AND status IN ('pending','delivered')", [row.id]);
    await this.audit(client, row.id, 'pairing.revoked', {by});
  }
  async pairingAudit(actor: Actor, id: string) {
    return transaction(this.db, async client => {
      const row = await this.ownPairing(client, actor, id);
      const rows = await client.query<{event: string; session_id: string | null; detail: unknown; created_at: Date}>('SELECT event,session_id,detail,created_at FROM controller_audit WHERE pairing_id=$1 ORDER BY created_at DESC,id LIMIT 200', [row.id]);
      return {audit: rows.rows.map(item => ({event: item.event, sessionId: item.session_id, detail: item.detail, at: item.created_at.toISOString()}))};
    });
  }

  // ---------------------------------------------------------------- Host: state and requests

  async putHostState(actor: Actor, sessionId: string, input: unknown) {
    const state = hostStateSchema.parse((input as {state?: unknown} | null)?.state);
    return transaction(this.db, async client => {
      await assertActor(client, actor);
      const session = await this.hostSession(client, actor, sessionId);
      await client.query(`INSERT INTO host_control_state(session_id,host_device_id,state,updated_at) VALUES($1,$2,$3,now())
        ON CONFLICT(session_id) DO UPDATE SET host_device_id=EXCLUDED.host_device_id,state=EXCLUDED.state,updated_at=now()`, [session.id, actor.deviceId, JSON.stringify(state)]);
      return {saved: true};
    });
  }
  private async openForHost(actor: Actor) {
    return transaction(this.db, async client => {
      await assertActor(client, actor);
      await client.query(`UPDATE control_requests r SET status='expired' FROM controller_pairings p WHERE p.id=r.pairing_id AND p.owner_id=$1 AND p.host_device_id=$2
        AND r.status IN ('pending','delivered') AND r.expires_at<=now()`, [actor.userId, actor.deviceId]);
      const rows = await client.query<RequestRow>(`UPDATE control_requests r SET status='delivered',delivered_at=COALESCE(r.delivered_at,now())
        FROM controller_pairings p WHERE p.id=r.pairing_id AND p.owner_id=$1 AND p.host_device_id=$2 AND p.status='active' AND p.expires_at>now()
          AND r.status IN ('pending','delivered') AND r.expires_at>now()
          AND r.id IN (SELECT r2.id FROM control_requests r2 JOIN controller_pairings p2 ON p2.id=r2.pairing_id WHERE p2.owner_id=$1 AND p2.host_device_id=$2 AND r2.status IN ('pending','delivered') ORDER BY r2.created_at,r2.id LIMIT 20)
        RETURNING r.*`, [actor.userId, actor.deviceId]);
      return rows.rows.sort((a, b) => a.created_at.getTime() - b.created_at.getTime() || a.id.localeCompare(b.id))
        .map(row => ({id: row.id, pairingId: row.pairing_id, sessionId: row.session_id, envelope: row.envelope, signature: row.signature}));
    });
  }
  /** Long-poll: answers as soon as a request is waiting, or after `wait` seconds with none. */
  async hostRequests(actor: Actor, input: unknown, closed: () => boolean) {
    const {wait} = z.object({wait: z.coerce.number().int().min(0).max(10).default(0)}).strict().parse(input ?? {});
    const deadline = Date.now() + wait * 1000;
    for (;;) {
      const requests = await this.openForHost(actor);
      if (requests.length || Date.now() >= deadline || closed()) return {requests};
      await new Promise(resolve => setTimeout(resolve, 400));
    }
  }
  async acknowledge(actor: Actor, requestId: string, input: unknown) {
    const body = z.object({outcome: z.enum(['accepted', 'rejected']), code: z.string().regex(/^[a-z_]{1,64}$/u), message: plain(500).optional()}).strict().parse(input);
    return transaction(this.db, async client => {
      await assertActor(client, actor);
      const initial = await client.query<{session_id: string}>(`SELECT r.session_id FROM control_requests r JOIN controller_pairings p ON p.id=r.pairing_id
        WHERE r.id=$1 AND p.owner_id=$2 AND p.host_device_id=$3`, [uuid.parse(requestId), actor.userId, actor.deviceId]);
      if (!initial.rows[0]) throw new ApiError(404, 'control_request_not_found', 'Control request not found.');
      const session = await this.hostSession(client, actor, initial.rows[0].session_id);
      const found = await client.query<RequestRow & {device_name: string | null}>(`SELECT r.*,p.device_name FROM control_requests r JOIN controller_pairings p ON p.id=r.pairing_id WHERE r.id=$1 FOR UPDATE OF r`, [requestId]);
      const row = found.rows[0]!;
      if (row.status === 'accepted' || row.status === 'rejected') {
        if (row.status !== body.outcome) throw new ApiError(409, 'control_acknowledged', 'This request was already acknowledged differently.');
        return {status: row.status};
      }
      // The host is the authority on what happened: a request canceled by Stop that the host had
      // already carried out is still recorded as accepted.
      await client.query('UPDATE control_requests SET status=$2,result_code=$3,result_message=$4,acknowledged_at=now() WHERE id=$1', [row.id, body.outcome, body.code, body.message ? redact(body.message) : null]);
      await this.audit(client, row.pairing_id, `request.${body.outcome}`, {requestId: row.id, kind: row.kind, code: body.code}, session.id);
      const event = {requestId: row.id, kind: row.kind, outcome: body.outcome, code: body.code, via: 'paired_phone', deviceName: (row.device_name ?? 'Paired phone').slice(0, 120)};
      try {await this.append(client, session, actor, 'control.acknowledged', event);}
      catch (error) {if (!(error instanceof ApiError && error.code === 'session_capacity')) throw error;}
      return {status: body.outcome};
    });
  }

  // ---------------------------------------------------------------- Phone

  async claim(input: unknown) {
    const body = z.object({
      code: z.string().min(12).max(20), requestId: uuid, credential: secret, deviceName: plain(80),
      platform: z.enum(['android', 'ios', 'web']), signingKey: jwkSchema, encryptionKey: jwkSchema,
    }).strict().parse(input);
    const code = normalizeCode(body.code);
    if (!code) throw new ApiError(400, 'pairing_code_invalid', 'Enter the 12-character code shown on the desktop.');
    const thumbprint = keyThumbprint(body.signingKey, body.encryptionKey);
    const fingerprint = digest(stable({credential: digest(body.credential), deviceName: body.deviceName, platform: body.platform, thumbprint}));
    return transaction(this.db, async client => {
      const found = await client.query<PairingRow>('SELECT * FROM controller_pairings WHERE code_hash=$1 FOR UPDATE', [digest(code)]);
      const row = found.rows[0];
      const unavailable = () => new ApiError(404, 'pairing_code_unavailable', 'This pairing code is wrong, expired or already used. Start pairing again on the desktop.');
      if (!row) throw unavailable();
      if (row.status !== 'awaiting_device') {
        // A lost response: the same phone retries the same claim and learns the same result.
        if (row.claim_request_id === body.requestId && row.claim_fingerprint === fingerprint && row.status === 'awaiting_confirmation') return this.claimView(client, row);
        throw unavailable();
      }
      if (row.code_expires_at.getTime() <= Date.now()) throw unavailable();
      const used = await client.query('SELECT 1 FROM controller_pairings WHERE token_hash=$1', [digest(body.credential)]);
      if (used.rowCount) throw new ApiError(409, 'controller_credential_used', 'Start pairing again.');
      const updated = await client.query<PairingRow>(`UPDATE controller_pairings SET status='awaiting_confirmation',claim_request_id=$2,claim_fingerprint=$3,device_name=$4,device_platform=$5,
        signing_key=$6,encryption_key=$7,key_thumbprint=$8,token_hash=$9,claimed_at=now() WHERE id=$1 RETURNING *`,
      [row.id, body.requestId, fingerprint, redact(body.deviceName), body.platform, JSON.stringify(publicPart(body.signingKey)), JSON.stringify(publicPart(body.encryptionKey)), thumbprint, digest(body.credential)]);
      await this.audit(client, row.id, 'pairing.claimed', {deviceName: redact(body.deviceName), platform: body.platform, keyThumbprint: thumbprint});
      return this.claimView(client, updated.rows[0]!);
    });
  }
  private async claimView(client: PoolClient, row: PairingRow) {
    const owner = await client.query<{display_name: string}>('SELECT display_name FROM users WHERE id=$1', [row.owner_id]);
    const host = await client.query<{name: string}>('SELECT name FROM devices WHERE id=$1', [row.host_device_id]);
    return {pairing: {id: row.id, status: row.status, verificationCode: verificationCode(row.id, row.key_thumbprint!), ownerName: owner.rows[0]?.display_name ?? 'Owner', hostName: host.rows[0]?.name ?? 'Desktop', sessionCount: row.session_ids.length}};
  }
  /** Lookup by credential, then lock the pairing; every phone operation revalidates it. */
  async controller(client: PoolClient, credential: string, allowPending = false): Promise<Controller & {row: PairingRow}> {
    const found = await client.query<PairingRow>(`SELECT p.* FROM controller_pairings p JOIN devices d ON d.id=p.host_device_id
      WHERE p.token_hash=$1 AND d.revoked_at IS NULL FOR UPDATE OF p`, [digest(secret.parse(credential))]);
    const row = found.rows[0];
    if (!row) throw controllerDenied();
    await this.expire(client, row);
    if (row.status === 'awaiting_confirmation' && allowPending) return {pairingId: row.id, ownerId: row.owner_id, hostDeviceId: row.host_device_id, sessionIds: row.session_ids, status: row.status, row};
    if (row.status === 'awaiting_confirmation') throw new ApiError(403, 'controller_pending', 'Confirm this phone on the desktop first.');
    if (row.status !== 'active') throw row.revoked_by === 'expiry' ? controllerDenied('controller_expired', 'This phone’s owner access expired. Pair it again from the desktop.') : controllerDenied();
    if (!row.last_seen_at || Date.now() - row.last_seen_at.getTime() > 60_000) await client.query('UPDATE controller_pairings SET last_seen_at=now() WHERE id=$1', [row.id]);
    return {pairingId: row.id, ownerId: row.owner_id, hostDeviceId: row.host_device_id, sessionIds: row.session_ids, status: row.status, row};
  }
  /** Lock order matches the rest of the service: the session first, then the pairing. */
  private async scopedSession(client: PoolClient, credential: string, sessionId: string) {
    uuid.parse(sessionId);
    const scope = await client.query<{session_ids: string[]}>('SELECT session_ids FROM controller_pairings WHERE token_hash=$1', [digest(secret.parse(credential))]);
    if (!scope.rows[0]) throw controllerDenied();
    if (!scope.rows[0].session_ids.includes(sessionId)) throw new ApiError(403, 'controller_scope', 'This phone isn’t paired for that session.');
    const found = await client.query<SessionRow>('SELECT * FROM sessions WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [sessionId]);
    const controller = await this.controller(client, credential);
    const session = found.rows[0];
    if (!session || !controller.sessionIds.includes(sessionId) || session.owner_id !== controller.ownerId || session.host_device_id !== controller.hostDeviceId) throw new ApiError(403, 'controller_scope', 'This phone isn’t paired for that session.');
    return {controller, session};
  }

  async status(credential: string) {
    return transaction(this.db, async client => {
      const controller = await this.controller(client, credential, true);
      const owner = await client.query<{display_name: string}>('SELECT display_name FROM users WHERE id=$1', [controller.ownerId]);
      const host = await client.query<{name: string}>('SELECT name FROM devices WHERE id=$1', [controller.hostDeviceId]);
      const sessions = controller.status === 'active' ? await client.query<SessionRow & {updated: Date | null; state: unknown}>(`SELECT s.*,h.updated_at AS updated,h.state FROM sessions s
        LEFT JOIN host_control_state h ON h.session_id=s.id AND h.host_device_id=s.host_device_id
        WHERE s.id=ANY($1) AND s.deleted_at IS NULL AND s.owner_id=$2 AND s.host_device_id=$3 ORDER BY s.updated_at DESC`, [controller.sessionIds, controller.ownerId, controller.hostDeviceId]) : {rows: []};
      const row = controller.row;
      return {
        serverTime: Date.now(),
        pairing: {id: row.id, status: row.status, deviceName: row.device_name, expiresAt: row.expires_at?.toISOString() ?? null, verificationCode: verificationCode(row.id, row.key_thumbprint!), ownerName: owner.rows[0]?.display_name ?? 'Owner', hostName: host.rows[0]?.name ?? 'Desktop'},
        sessions: sessions.rows.map(session => ({id: session.id, title: session.title ?? 'Untitled session', mode: session.mode, status: session.status, runtimeGeneration: session.runtime_generation, lastSequence: session.event_sequence, updatedAt: session.updated_at.toISOString(),
          host: session.updated ? {state: session.state, ageMs: Math.max(0, Date.now() - session.updated.getTime())} : null})),
      };
    });
  }
  async sessionDetail(credential: string, sessionId: string) {
    return transaction(this.db, async client => {
      const {session} = await this.scopedSession(client, credential, sessionId);
      const state = await client.query<{state: unknown; updated_at: Date}>('SELECT state,updated_at FROM host_control_state WHERE session_id=$1 AND host_device_id=$2', [session.id, session.host_device_id]);
      const pending = await pendingDirections(client, session.id);
      const previousDirection = await priorSteeringConflict(client, session.id);
      const people = await client.query<{user_id: string; role: string; name: string}>(`SELECT p.user_id,p.role,COALESCE(p.display_name,u.display_name) AS name FROM session_participants p JOIN users u ON u.id=p.user_id
        WHERE p.session_id=$1 AND p.revoked_at IS NULL ORDER BY p.admitted_at,p.user_id`, [session.id]);
      // The exact action the service holds for the running run; paths are workspace-relative.
      const action = await client.query<{id: string; fingerprint: string; descriptor: {operation: Record<string, unknown>; expiresAt: number}; generation: number}>(`SELECT a.id,a.fingerprint,a.descriptor,r.generation FROM execution_actions a JOIN execution_runs r ON r.id=a.run_id
        WHERE r.session_id=$1 AND r.status='running' AND a.status='pending' AND a.expires_at>now() ORDER BY a.created_at DESC LIMIT 1`, [session.id]);
      // The name each person gave when joining (or their account name); the owner is marked as the host.
      const names = new Map(people.rows.map(row => [row.user_id, row.name.slice(0, 60)]));
      const label = (userId: string) => {
        const name = names.get(userId);
        if (userId === session.owner_id) return name ? `${name} (host)`.slice(0, 60) : 'Host';
        return name ?? `Teammate ${userId.replace(/-/gu, '').slice(0, 4).toUpperCase()}`;
      };
      const a = action.rows[0];
      const operation = a?.descriptor.operation as {kind: string; relativePath?: string; contentHash?: string; expectedContentHash?: string | null; commandText?: string | null; argv?: string[]; tool?: string; arguments?: unknown} | undefined;
      return {
        serverTime: Date.now(),
        session: {id: session.id, title: session.title ?? 'Untitled session', mode: session.mode, status: session.status, runtimeGeneration: session.runtime_generation, lastSequence: session.event_sequence},
        host: state.rows[0] ? {state: state.rows[0].state, ageMs: Math.max(0, Date.now() - state.rows[0].updated_at.getTime())} : null,
        participants: people.rows.map(row => ({userId: row.user_id, role: row.role, label: label(row.user_id)})),
        queue: {
          fingerprint: directionFingerprint(session.id, pending),
          requiresReview: new Set(pending.map(row => row.authorId)).size > 1 || Boolean(previousDirection),
          pending: pending.slice(0, 100).map(row => ({id: row.id, authorId: row.authorId, author: label(row.authorId), text: row.text.slice(0, 4000), revision: row.revision})),
          ...(previousDirection ? {previousDirection: {id: previousDirection.id, author: label(previousDirection.authorId), text: previousDirection.text.slice(0, 4000)}} : {}),
        },
        pendingAction: a && operation ? {
          actionId: a.id, fingerprint: a.fingerprint, runGeneration: a.generation, kind: operation.kind, expiresAt: a.descriptor.expiresAt,
          ...(operation.kind === 'file_write' ? {path: operation.relativePath, contentHash: operation.contentHash, newFile: operation.expectedContentHash === null} : {}),
          ...(operation.kind === 'shell' ? {command: redact(operation.commandText ?? (operation.argv ?? []).join(' ')).slice(0, 8000)} : {}),
          ...(operation.kind === 'external' ? {command: redact(`${operation.tool ?? 'tool'} ${JSON.stringify(operation.arguments ?? {})}`).slice(0, 4000)} : {}),
        } : null,
      };
    });
  }
  async events(credential: string, sessionId: string, input: unknown) {
    const {after} = z.object({after: z.coerce.number().int().min(0).max(100_000).default(0)}).strict().parse(input ?? {});
    return transaction(this.db, async client => {
      const {session} = await this.scopedSession(client, credential, sessionId);
      if (after > session.event_sequence) throw new ApiError(409, 'cursor_ahead', 'The replay cursor is ahead of this session.');
      const rows = await client.query<{id: string; sequence: number; type: string; actor_id: string | null; payload: unknown; created_at: Date}>('SELECT id,sequence,type,actor_id,payload,created_at FROM shared_events WHERE session_id=$1 AND sequence>$2 ORDER BY sequence LIMIT 100', [session.id, after]);
      return {events: rows.rows.map(row => ({id: row.id, sessionId: session.id, sequence: row.sequence, type: row.type, actorId: row.actor_id, payload: row.payload, createdAt: row.created_at.toISOString()})), cursor: rows.rows.at(-1)?.sequence ?? after};
    });
  }
  async acceptance(credential: string, sessionId: string) {
    return transaction(this.db, async client => {
      const {session} = await this.scopedSession(client, credential, sessionId);
      return readAcceptance(client, session);
    });
  }
  async submit(credential: string, input: unknown) {
    const body = z.object({envelope: envelopeSchema, signature: signatureSchema}).strict().parse(input);
    const envelope = body.envelope;
    const fingerprint = digest(stable(envelope));
    const now = Date.now();
    return transaction(this.db, async client => {
      const {controller, session} = await this.scopedSession(client, credential, envelope.sessionId);
      if (envelope.pairingId !== controller.pairingId) throw new ApiError(403, 'controller_scope', 'This request belongs to a different pairing.');
      const previous = await client.query<RequestRow>('SELECT * FROM control_requests WHERE id=$1', [envelope.requestId]);
      if (previous.rows[0]) {
        const prior = previous.rows[0];
        if (prior.pairing_id !== controller.pairingId || prior.fingerprint !== fingerprint) throw new ApiError(409, 'idempotency_conflict', 'This request identity was already used for a different request.');
        return {request: this.requestView(prior)};
      }
      if (!verifyControl(envelope, body.signature, controller.row.signing_key!)) throw new ApiError(403, 'control_signature_invalid', 'This request was not signed by the paired phone.');
      if (envelope.expiresAt <= now || envelope.expiresAt - envelope.issuedAt > MAX_REQUEST_LIFETIME_MS || envelope.issuedAt > now + CLOCK_SKEW_MS || envelope.expiresAt <= envelope.issuedAt) {
        throw new ApiError(409, 'control_expired', 'This request expired. Review the current state and try again.');
      }
      if (envelope.runGeneration !== session.runtime_generation) throw new ApiError(409, 'stale_generation', 'The session changed on the desktop. Review the current state and try again.');
      const open = await client.query<{count: number}>("SELECT count(*)::int AS count FROM control_requests WHERE pairing_id=$1 AND status IN ('pending','delivered') AND expires_at>now()", [controller.pairingId]);
      if (open.rows[0]!.count >= 20) throw new ApiError(429, 'control_capacity', 'Wait for the desktop to answer earlier requests.');
      await this.checkTarget(client, session, envelope);
      await client.query(`INSERT INTO control_requests(id,pairing_id,session_id,kind,envelope,fingerprint,signature,run_generation,issued_at,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,to_timestamp($9/1000.0),to_timestamp($10/1000.0))`,
      [envelope.requestId, controller.pairingId, session.id, envelope.kind, JSON.stringify(envelope), fingerprint, body.signature, envelope.runGeneration, envelope.issuedAt, envelope.expiresAt]);
      await this.audit(client, controller.pairingId, 'request.submitted', {requestId: envelope.requestId, kind: envelope.kind}, session.id);
      const created = await client.query<RequestRow>('SELECT * FROM control_requests WHERE id=$1', [envelope.requestId]);
      return {request: this.requestView(created.rows[0]!)};
    });
  }
  /** The service's own view of the binding. The host checks it again against what it actually holds. */
  private async checkTarget(client: PoolClient, session: SessionRow, envelope: ControlEnvelope) {
    switch (envelope.kind) {
      case 'approve': case 'reject': {
        const found = await client.query<{fingerprint: string; status: string; generation: number; expires_at: Date}>(`SELECT a.fingerprint,a.status,r.generation,a.expires_at FROM execution_actions a JOIN execution_runs r ON r.id=a.run_id
          WHERE a.id=$1 AND r.session_id=$2 AND r.status='running'`, [envelope.target.actionId, session.id]);
        const action = found.rows[0];
        if (!action || action.status !== 'pending' || action.expires_at.getTime() <= Date.now()) throw new ApiError(409, 'action_unavailable', 'That action is no longer waiting for approval.');
        if (action.fingerprint !== envelope.target.actionFingerprint) throw new ApiError(409, 'action_changed', 'The action changed. Review the new one before deciding.');
        if (action.generation !== envelope.runGeneration) throw new ApiError(409, 'stale_generation', 'The run changed on the desktop.');
        return;
      }
      case 'start': case 'resolve': {
        if (session.status === 'running') throw new ApiError(409, 'session_active', 'The agent is already working. Steer or stop it instead.');
        const pending = await pendingDirections(client, session.id);
        if (!pending.some(row => row.id === envelope.target.instructionId)) throw new ApiError(409, 'instruction_unavailable', 'Choose a pending instruction.');
        if (directionFingerprint(session.id, pending) !== envelope.target.queueFingerprint) throw new ApiError(409, 'stale_resolution', 'The pending directions changed. Review them again.');
        const conflict = new Set(pending.map(row => row.authorId)).size > 1 || Boolean(await priorSteeringConflict(client, session.id));
        if (envelope.kind === 'start' && conflict) throw new ApiError(409, 'instruction_conflict', 'Several people have pending directions. Resolve the conflict first.');
        return;
      }
      case 'steer': {
        if (session.status !== 'running') throw new ApiError(409, 'not_running', 'The agent isn’t working right now. Start the instruction instead.');
        const found = await client.query("SELECT 1 FROM instruction_queue WHERE id=$1 AND session_id=$2 AND status='pending'", [envelope.target.instructionId, session.id]);
        if (!found.rowCount) throw new ApiError(409, 'instruction_unavailable', 'Choose a pending instruction.');
        return;
      }
      case 'stop':
        if (session.status !== 'running') throw new ApiError(409, 'not_running', 'The agent isn’t running.');
        return;
    }
  }
  private requestView(row: RequestRow) {
    const status = (row.status === 'pending' || row.status === 'delivered') && row.expires_at.getTime() <= Date.now() ? 'expired' : row.status;
    return {id: row.id, sessionId: row.session_id, kind: row.kind, status, code: row.result_code, message: row.result_message,
      createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString(), deliveredAt: row.delivered_at?.toISOString() ?? null, acknowledgedAt: row.acknowledged_at?.toISOString() ?? null};
  }
  async requestStatus(credential: string, requestId: string) {
    return transaction(this.db, async client => {
      const controller = await this.controller(client, credential);
      const found = await client.query<RequestRow>('SELECT * FROM control_requests WHERE id=$1 AND pairing_id=$2', [uuid.parse(requestId), controller.pairingId]);
      if (!found.rows[0]) throw new ApiError(404, 'control_request_not_found', 'Control request not found.');
      return {request: this.requestView(found.rows[0])};
    });
  }
  async recentRequests(credential: string, input: unknown) {
    const {sessionId} = z.object({sessionId: uuid}).strict().parse(input ?? {});
    return transaction(this.db, async client => {
      const controller = await this.controller(client, credential);
      const rows = await client.query<RequestRow>('SELECT * FROM control_requests WHERE pairing_id=$1 AND session_id=$2 ORDER BY created_at DESC LIMIT 20', [controller.pairingId, sessionId]);
      return {requests: rows.rows.map(row => this.requestView(row))};
    });
  }
  async unpair(credential: string) {
    return transaction(this.db, async client => {
      const controller = await this.controller(client, credential, true);
      await this.revoke(client, controller.row, 'controller');
      return {revoked: true};
    });
  }
}

// ---------------------------------------------------------------- Routes

export const CONTROLLER_COOKIE = 'multai_controller';
export function readCookie(request: FastifyRequest, name: string): string | undefined {
  for (const part of (request.headers.cookie ?? '').split(';')) {
    const [key, ...value] = part.trim().split('=');
    if (key === name) return value.join('=');
  }
  return undefined;
}
export function cookieHeader(publicOrigin: string, name: string, value: string, path: string, maxAge: number): string {
  const secure = publicOrigin.startsWith('https:') ? '; Secure' : '';
  return `${name}=${value}; Path=${path}; Max-Age=${maxAge}; HttpOnly; SameSite=Strict${secure}`;
}
/**
 * Cookie-authenticated browser calls must come from this origin's own page. They carry a custom header
 * (another site cannot add one without a CORS preflight, which these routes never grant), and when the
 * browser says where a request came from (Origin, Sec-Fetch-Site) it must be this origin. Browsers omit
 * Origin on same-origin GETs, so its absence alone is not a refusal.
 */
export function requireSameOriginClient(request: FastifyRequest, publicOrigin: string) {
  const origin = request.headers.origin, site = request.headers['sec-fetch-site'];
  if (request.headers['x-multai-client'] !== 'web' || (origin !== undefined && origin !== publicOrigin) || (site !== undefined && site !== 'same-origin')) {
    throw new ApiError(403, 'origin_denied', 'Open MultAI from its own address.');
  }
  if (origin === undefined && request.method !== 'GET' && request.method !== 'HEAD') throw new ApiError(403, 'origin_denied', 'Open MultAI from its own address.');
}

export async function registerOwnerControlRoutes(app: FastifyInstance, service: OwnerControlService, authenticate: (request: FastifyRequest) => Promise<Actor>, publicOrigin: string) {
  const params = (request: FastifyRequest) => z.object({id: uuid.optional(), sessionId: uuid.optional()}).parse(request.params);
  // Host (native desktop account on the original host device).
  app.post('/v1/controller-pairings', async (request, reply) => reply.code(201).send(await service.createPairing(await authenticate(request), request.body)));
  app.get('/v1/controller-pairings', async request => service.listPairings(await authenticate(request)));
  app.get('/v1/controller-pairings/:id', async request => service.getPairing(await authenticate(request), params(request).id!));
  app.post('/v1/controller-pairings/:id/confirm', async request => service.confirmPairing(await authenticate(request), params(request).id!, request.body));
  app.post('/v1/controller-pairings/:id/decline', async request => service.declinePairing(await authenticate(request), params(request).id!));
  app.delete('/v1/controller-pairings/:id', async request => service.revokePairing(await authenticate(request), params(request).id!));
  app.get('/v1/controller-pairings/:id/audit', async request => service.pairingAudit(await authenticate(request), params(request).id!));
  app.put('/v1/sessions/:sessionId/control-state', {config: {rateLimit: {max: 240, timeWindow: '1 minute'}}}, async request => service.putHostState(await authenticate(request), params(request).sessionId!, request.body));
  app.get('/v1/host/control-requests', {config: {rateLimit: {max: 240, timeWindow: '1 minute'}}}, async request => {
    const actor = await authenticate(request);
    let closed = false;
    request.raw.once('close', () => {closed = true;});
    return service.hostRequests(actor, request.query, () => closed);
  });
  app.post('/v1/host/control-requests/:id/ack', async request => service.acknowledge(await authenticate(request), params(request).id!, request.body));

  // Phone: Authorization: Controller <credential> (Android app), or this origin's HttpOnly cookie (browser).
  const credential = (request: FastifyRequest) => {
    const header = /^Controller ([A-Za-z0-9_-]{43})$/u.exec(request.headers.authorization ?? '');
    if (header) return header[1]!;
    const cookie = readCookie(request, CONTROLLER_COOKIE);
    if (cookie && /^[A-Za-z0-9_-]{43}$/u.test(cookie)) {requireSameOriginClient(request, publicOrigin); return cookie;}
    throw controllerDenied('controller_required', 'Pair this phone from the desktop first.');
  };
  app.post('/v1/controller/claim', {config: {rateLimit: {max: 10, timeWindow: '1 minute'}}}, async (request: FastifyRequest, reply: FastifyReply) => {
    const web = request.headers['x-multai-client'] === 'web';
    if (web) requireSameOriginClient(request, publicOrigin);
    const result = await service.claim(request.body);
    if (web) {
      const body = request.body as {credential: string};
      // The browser keeps the credential only as an HttpOnly cookie, out of reach of page scripts.
      reply.header('set-cookie', cookieHeader(publicOrigin, CONTROLLER_COOKIE, body.credential, '/v1/controller', 30 * 86_400));
    }
    return result;
  });
  app.get('/v1/controller/status', async request => service.status(credential(request)));
  app.get('/v1/controller/sessions/:sessionId', async request => service.sessionDetail(credential(request), params(request).sessionId!));
  app.get('/v1/controller/sessions/:sessionId/events', async request => service.events(credential(request), params(request).sessionId!, request.query));
  app.get('/v1/controller/sessions/:sessionId/acceptance', async request => service.acceptance(credential(request), params(request).sessionId!));
  app.post('/v1/controller/requests', {config: {rateLimit: {max: 30, timeWindow: '1 minute'}}}, async (request, reply) => reply.code(201).send(await service.submit(credential(request), request.body)));
  app.get('/v1/controller/requests', async request => service.recentRequests(credential(request), request.query));
  app.get('/v1/controller/requests/:id', async request => service.requestStatus(credential(request), params(request).id!));
  app.post('/v1/controller/unpair', async (request, reply) => {
    const result = await service.unpair(credential(request));
    reply.header('set-cookie', cookieHeader(publicOrigin, CONTROLLER_COOKIE, '', '/v1/controller', 0));
    return result;
  });
  app.post('/v1/controller/forget', async (request, reply) => {
    // Clears a dead browser credential (revoked, expired or declined) without needing it to be valid.
    requireSameOriginClient(request, publicOrigin);
    reply.header('set-cookie', cookieHeader(publicOrigin, CONTROLLER_COOKIE, '', '/v1/controller', 0));
    return {forgotten: true};
  });
}
