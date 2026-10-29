import { createHash, randomBytes } from 'node:crypto';
import os from 'node:os';
import { shell } from 'electron';
import { z } from 'zod';
import type { AuthState, Result, ServiceError, ServiceHealth } from '../../src/bridge/contract';
import type { WireMe } from '../../src/bridge/wire';
import { CredentialStore, type CredentialRecord } from './credentials';

const REQUEST_TIMEOUT_MS = 15_000;
const REFRESH_MARGIN_MS = 60_000;

const errorBody = z.object({ error: z.object({ code: z.string().max(100), message: z.string().max(500) }) });
const tokenBundle = z.object({
  accessToken: z.string().min(1).max(200),
  refreshToken: z.string().min(1).max(200),
  expiresIn: z.number().int().positive().max(86_400),
  deviceId: z.uuid(),
  deviceSecret: z.string().min(1).max(200).optional(),
});
const meSchema = z.object({ id: z.uuid(), displayName: z.string().max(120), workspaceId: z.uuid(), deviceId: z.uuid() });
const startSchema = z.object({ flowId: z.uuid(), authorizationUrl: z.url(), expiresAt: z.string() });

export class ApiFailure extends Error {
  constructor(readonly error: ServiceError) {
    super(error.message);
  }
}

const base64url = (b: Buffer) => b.toString('base64url');

/** True when a fetch failure means the request never reached the server. */
function neverSent(error: unknown): boolean {
  const code = (error as { cause?: { code?: string } })?.cause?.code;
  return code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EAI_AGAIN' || code === 'ENETUNREACH' || code === 'EHOSTUNREACH';
}

interface PendingFlow {
  flowId: string;
  verifier: string;
  expiresAt: number;
}

/**
 * Owns this computer's collaboration identity for one service origin: sign-in, token
 * refresh, authorized requests and sign-out. Tokens never leave this object.
 */
export class Account {
  private readonly store: CredentialStore;
  private pending: PendingFlow | null = null;
  private refreshing: Promise<string> | null = null;
  private me: WireMe | null = null;
  /** Bumped on every sign-in/out so late responses from an old identity are discarded. */
  private generation = 0;

  constructor(readonly origin: string, private readonly onChange: (state: AuthState) => void) {
    this.store = new CredentialStore(origin);
  }

  /* ------------------------------------------------------------ status */

  async health(): Promise<ServiceHealth> {
    try {
      const res = await fetch(new URL('/health/ready', this.origin), { signal: AbortSignal.timeout(5_000) });
      const body = (await res.json().catch(() => ({}))) as { database?: string; identity?: string };
      return {
        origin: this.origin,
        reachable: true,
        database: body.database === 'ready' ? 'ready' : 'unavailable',
        identity: body.identity === 'configured_unverified' || body.identity === 'not_configured' ? body.identity : 'unknown',
      };
    } catch {
      return { origin: this.origin, reachable: false, database: 'unknown', identity: 'unknown' };
    }
  }

  async state(): Promise<AuthState> {
    if (this.pending) return { status: 'signing-in', expiresAt: new Date(this.pending.expiresAt).toISOString() };
    const record = await this.store.load();
    if (!record.active) return { status: 'signed-out' };
    if (!this.me) {
      try {
        this.me = meSchema.parse(await this.request('GET', '/v1/me'));
      } catch (e) {
        if (e instanceof ApiFailure && e.error.status === 401) return { status: 'signed-out' };
        // Offline: we still hold credentials, but can't show who we are yet.
        return { status: 'signed-out', error: e instanceof ApiFailure ? e.error : { code: 'offline', message: 'The collaboration service is unreachable.' } };
      }
    }
    return { status: 'signed-in', me: this.me, persisted: this.store.encrypted };
  }

  private async emit(): Promise<void> {
    this.onChange(await this.state());
  }

  /* ------------------------------------------------------------ sign-in */

  async signIn(): Promise<Result<null>> {
    const verifier = base64url(randomBytes(64));
    const challenge = base64url(createHash('sha256').update(verifier).digest());
    let start: z.infer<typeof startSchema>;
    try {
      start = startSchema.parse(await this.send('POST', '/v1/auth/google/start', { codeChallenge: challenge }));
    } catch (e) {
      return { ok: false, error: toError(e) };
    }
    const url = new URL(start.authorizationUrl);
    if (url.protocol !== 'https:' || url.hostname !== 'accounts.google.com') {
      return { ok: false, error: { code: 'unexpected_provider', message: 'The service returned an unexpected sign-in address.' } };
    }
    // A new flow replaces only our own previous pending flow, never an active identity.
    this.pending = { flowId: start.flowId, verifier, expiresAt: Date.parse(start.expiresAt) || Date.now() + 5 * 60_000 };
    await this.emit();
    await shell.openExternal(url.toString());
    return { ok: true, value: null };
  }

  async cancelSignIn(): Promise<void> {
    this.pending = null;
    await this.emit();
  }

  /** Handles multai-dev://auth/callback?flowId=…&completionCode=… from the system browser. */
  async completeSignIn(callback: URL): Promise<void> {
    const pending = this.pending;
    const flowId = callback.searchParams.get('flowId');
    const completionCode = callback.searchParams.get('completionCode');
    if (!pending || !flowId || !completionCode || flowId !== pending.flowId) return; // Stale or foreign callback.
    this.pending = null;
    if (Date.now() > pending.expiresAt) {
      this.onChange({ status: 'signed-out', error: { code: 'invalid_flow', message: 'Sign-in took too long. Start again.' } });
      return;
    }
    const record = await this.store.load();
    const proof = record.lastUserId ? record.devices[record.lastUserId] : undefined;
    const base = { flowId, completionCode, codeVerifier: pending.verifier, deviceName: os.hostname().slice(0, 120) || 'Desktop' };
    let bundle: z.infer<typeof tokenBundle>;
    try {
      try {
        bundle = tokenBundle.parse(await this.send('POST', '/v1/auth/google/exchange', proof ? { ...base, ...proof } : base));
      } catch (e) {
        // The proof belongs to a different account. The failed exchange rolled back, so the
        // completion code is still valid; enroll this computer as a new device instead.
        if (!(proof && e instanceof ApiFailure && e.error.code === 'invalid_device_proof')) throw e;
        bundle = tokenBundle.parse(await this.send('POST', '/v1/auth/google/exchange', base));
      }
    } catch (e) {
      this.onChange({ status: 'signed-out', error: toError(e) });
      return;
    }
    this.generation++;
    this.me = null;
    const me = meSchema.parse(await this.send('GET', '/v1/me', undefined, bundle.accessToken));
    const devices = { ...record.devices };
    if (bundle.deviceSecret) devices[me.id] = { deviceId: bundle.deviceId, deviceSecret: bundle.deviceSecret };
    await this.store.save({
      active: { userId: me.id, accessToken: bundle.accessToken, refreshToken: bundle.refreshToken, accessExpiresAt: Date.now() + bundle.expiresIn * 1000 },
      devices,
      lastUserId: me.id,
    });
    this.me = me;
    await this.emit();
  }

  async signOut(): Promise<Result<null>> {
    const record = await this.store.load();
    if (record.active) {
      // Best effort: revoke centrally, but always forget locally.
      await this.request('POST', '/v1/auth/logout').catch(() => undefined);
    }
    this.generation++;
    this.me = null;
    this.pending = null;
    await this.store.clearActive();
    await this.emit();
    return { ok: true, value: null };
  }

  /* ------------------------------------------------------------ tokens */

  /** Returns a fresh access token, refreshing at most once at a time. */
  async accessToken(): Promise<string> {
    const record = await this.store.load();
    if (!record.active) throw new ApiFailure({ code: 'signed_out', message: 'Sign in to continue.', status: 401 });
    if (record.active.accessExpiresAt - REFRESH_MARGIN_MS > Date.now()) return record.active.accessToken;
    return this.refresh();
  }

  private refresh(): Promise<string> {
    this.refreshing ??= this.doRefresh().finally(() => { this.refreshing = null; });
    return this.refreshing;
  }

  private async doRefresh(): Promise<string> {
    const generation = this.generation;
    const record = await this.store.load();
    const active = record.active;
    if (!active) throw new ApiFailure({ code: 'signed_out', message: 'Sign in to continue.', status: 401 });
    let bundle: z.infer<typeof tokenBundle>;
    try {
      bundle = tokenBundle.parse(await this.send('POST', '/v1/auth/refresh', { refreshToken: active.refreshToken }));
    } catch (e) {
      if (e instanceof ApiFailure && e.error.code === 'offline_unsent') throw e; // Never reached the server: safe to retry later.
      // Rejected, or the outcome is unknown. Retrying a possibly-consumed refresh token would
      // revoke the whole sign-in, so forget it and ask the person to sign in again.
      await this.forget({ code: 'session_expired', message: 'Your sign-in expired. Sign in again to continue.' });
      throw new ApiFailure({ code: 'session_expired', message: 'Your sign-in expired. Sign in again to continue.', status: 401 });
    }
    if (generation !== this.generation) throw new ApiFailure({ code: 'stale', message: 'Account changed.' });
    await this.store.save({
      ...record,
      active: { ...active, accessToken: bundle.accessToken, refreshToken: bundle.refreshToken, accessExpiresAt: Date.now() + bundle.expiresIn * 1000 },
    });
    return bundle.accessToken;
  }

  private async forget(error: ServiceError): Promise<void> {
    this.generation++;
    this.me = null;
    await this.store.clearActive();
    this.onChange({ status: 'signed-out', error });
  }

  /* ------------------------------------------------------------ requests */

  /** Authorized request. Retries once after a 401 caused by an expired access token. */
  async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const generation = this.generation;
    const token = await this.accessToken();
    try {
      return await this.guard(generation, this.send(method, path, body, token));
    } catch (e) {
      if (!(e instanceof ApiFailure) || e.error.status !== 401 || e.error.code === 'membership_revoked') throw e;
      const record: CredentialRecord = await this.store.load();
      if (!record.active) throw e;
      // A 401 means the request wasn't processed, so retrying it is safe.
      record.active.accessExpiresAt = 0;
      const fresh = await this.refresh();
      return this.guard(generation, this.send(method, path, body, fresh));
    }
  }

  private async guard<T>(generation: number, p: Promise<T>): Promise<T> {
    const value = await p;
    if (generation !== this.generation) throw new ApiFailure({ code: 'stale', message: 'Account changed while this request was running.' });
    return value;
  }

  private async send(method: string, path: string, body?: unknown, token?: string): Promise<unknown> {
    let res: Response;
    try {
      res = await fetch(new URL(path, this.origin), {
        method,
        headers: {
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        redirect: 'error',
      });
    } catch (e) {
      throw new ApiFailure(neverSent(e)
        ? { code: 'offline_unsent', message: 'Can’t reach the collaboration service.' }
        : { code: 'network_uncertain', message: 'The connection dropped before the service answered.' });
    }
    if (res.status === 204) return null;
    const json: unknown = await res.json().catch(() => null);
    if (!res.ok) {
      const parsed = errorBody.safeParse(json);
      throw new ApiFailure(parsed.success
        ? { ...parsed.data.error, status: res.status }
        : { code: 'http_error', message: `The service answered ${res.status}.`, status: res.status });
    }
    return json;
  }

  /** Builds an authenticated WebSocket handshake header without exposing the token. */
  async authorizationHeader(): Promise<string> {
    return `Bearer ${await this.accessToken()}`;
  }

  forceRefreshOnNextUse(): void {
    void this.store.load().then((r) => { if (r.active) r.active.accessExpiresAt = 0; });
  }
}

export function toError(e: unknown): ServiceError {
  if (e instanceof ApiFailure) return e.error;
  if (e instanceof z.ZodError) return { code: 'unexpected_response', message: 'The service sent a response this app doesn’t understand.' };
  return { code: 'internal', message: 'Something went wrong.' };
}
