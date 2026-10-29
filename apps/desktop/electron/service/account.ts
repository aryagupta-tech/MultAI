import {createHash, randomBytes} from 'node:crypto';
import os from 'node:os';
import {shell} from 'electron';
import {z} from 'zod';
import type {AuthState, Result, ServiceError, ServiceHealth} from '../../src/bridge/contract';
import type {WireMe} from '../../src/bridge/wire';
import {CredentialStorageError, CredentialStore, type CredentialPersistence} from './credentials';

const REQUEST_TIMEOUT_MS = 15_000;
const REFRESH_MARGIN_MS = 60_000;
const opaque = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const errorBody = z.object({error: z.object({code: z.string().max(100), message: z.string().max(500)})});
const tokenBundle = z.object({accessToken: opaque, refreshToken: opaque, expiresIn: z.number().int().positive().max(86_400), deviceId: z.uuid(), deviceSecret: opaque.optional()});
const meSchema = z.object({id: z.uuid(), displayName: z.string().max(120), workspaceId: z.uuid(), deviceId: z.uuid()});
const startSchema = z.object({flowId: z.uuid(), authorizationUrl: z.url(), expiresAt: z.string()});
const stale = () => new ApiFailure({code: 'stale', message: 'Account or sign-in flow changed while this request was running.'});
const signedOut = () => new ApiFailure({code: 'signed_out', message: 'Sign in to continue.', status: 401});

export class ApiFailure extends Error {
  constructor(readonly error: ServiceError) { super(error.message); }
}
export interface IdentitySnapshot {userId: string; deviceId: string; generation: number}
export interface AccountOptions {
  store?: CredentialPersistence;
  fetch?: typeof fetch;
  openExternal?: (url: string) => Promise<void>;
  now?: () => number;
  hostname?: () => string;
}
interface PendingFlow {flowId: string; verifier: string; expiresAt: number; generation: number; completing: boolean}
interface Refresh {generation: number; promise: Promise<string>}

function neverSent(error: unknown): boolean {
  const code = (error as {cause?: {code?: string}})?.cause?.code;
  return ['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH'].includes(code ?? '');
}

async function responseJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) return null;
  const parts: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      // A legal 100-event replay page may contain ~6 MiB of bounded UTF-8 messages.
      if (size > 8_388_608) throw new Error('Response exceeds limit');
      parts.push(part.value);
    }
    return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(parts)));
  } catch { throw new ApiFailure({code: 'unexpected_response', message: 'The service response was invalid or exceeded the limit.'}); }
  finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

/** Native-only identity. Credentials never cross the renderer bridge. */
export class Account {
  private readonly store: CredentialPersistence;
  private readonly fetcher: typeof fetch;
  private readonly openExternal: (url: string) => Promise<void>;
  private readonly now: () => number;
  private readonly hostname: () => string;
  private readonly inFlight = new Set<AbortController>();
  private pending: PendingFlow | null = null;
  private refreshing: Refresh | null = null;
  private me: WireMe | null = null;
  private generation = 0;
  private blocked = false;
  private forceRefresh = false;

  constructor(readonly origin: string, private readonly onChange: (state: AuthState) => void, options: AccountOptions = {}) {
    const parsed = new URL(origin);
    if (parsed.origin !== origin || !['http:', 'https:'].includes(parsed.protocol) ||
      (parsed.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname))) throw new Error('An HTTPS or loopback service origin is required.');
    this.store = options.store ?? new CredentialStore(origin);
    this.fetcher = options.fetch ?? fetch;
    this.openExternal = options.openExternal ?? (url => shell.openExternal(url));
    this.now = options.now ?? Date.now;
    this.hostname = options.hostname ?? os.hostname;
  }

  get accountGeneration(): number { return this.generation; }

  private advance(): number {
    this.generation++;
    for (const request of this.inFlight) request.abort();
    this.inFlight.clear();
    this.refreshing = null;
    this.forceRefresh = false;
    return this.generation;
  }
  private check(generation: number): void { if (generation !== this.generation) throw stale(); }

  async identitySnapshot(): Promise<IdentitySnapshot> {
    const generation = this.generation;
    const state = await this.state();
    this.check(generation);
    if (state.status !== 'signed-in' || this.blocked) throw signedOut();
    return {userId: state.me.id, deviceId: state.me.deviceId, generation};
  }

  async health(): Promise<ServiceHealth> {
    try {
      const body = z.object({database: z.string(), identity: z.string()}).parse(await this.send('GET', '/health/ready'));
      return {origin: this.origin, reachable: true, database: body.database === 'ready' ? 'ready' : 'unavailable', identity: body.identity === 'configured_unverified' || body.identity === 'not_configured' ? body.identity : 'unknown'};
    } catch (error) {
      return {origin: this.origin, reachable: error instanceof ApiFailure && error.error.status !== undefined, database: 'unknown', identity: 'unknown'};
    }
  }

  async state(): Promise<AuthState> {
    const generation = this.generation;
    if (this.pending) return {status: 'signing-in', expiresAt: new Date(this.pending.expiresAt).toISOString()};
    if (this.blocked) return {status: 'signed-out'};
    try {
      if (this.refreshing?.generation === generation) await this.refreshing.promise;
      const record = await this.store.load();
      this.check(generation);
      if (!record.active) return {status: 'signed-out'};
      const me = this.me ?? meSchema.parse(await this.request('GET', '/v1/me'));
      this.check(generation);
      if (me.id !== record.active.userId) throw stale();
      this.me = me;
      return {status: 'signed-in', me, persisted: this.store.encrypted};
    } catch (error) {
      if (generation !== this.generation) return {status: 'signed-out'};
      return {status: 'signed-out', error: toError(error)};
    }
  }

  private async emit(generation = this.generation): Promise<void> {
    const state = await this.state();
    if (generation === this.generation) this.onChange(state);
  }

  async signIn(): Promise<Result<null>> {
    const requestedGeneration = this.generation;
    let existing;
    try { this.store.assertAvailable(); existing = await this.store.load(); this.check(requestedGeneration); }
    catch (error) { return {ok: false, error: toError(error)}; }
    if (existing.active && !this.blocked) return {ok: false, error: {code: 'already_signed_in', message: 'Sign out before switching accounts.'}};
    const generation = this.advance();
    this.pending = null;
    const verifier = randomBytes(64).toString('base64url');
    try {
      const start = startSchema.parse(await this.send('POST', '/v1/auth/google/start', {codeChallenge: createHash('sha256').update(verifier).digest('base64url')}));
      this.check(generation);
      const expiresAt = Date.parse(start.expiresAt);
      const url = new URL(start.authorizationUrl);
      if (url.protocol !== 'https:' || url.hostname !== 'accounts.google.com' || url.username || url.password || url.port || url.pathname !== '/o/oauth2/v2/auth' || !Number.isFinite(expiresAt) || expiresAt <= this.now() || expiresAt > this.now() + 10 * 60_000) {
        throw new ApiFailure({code: 'unexpected_provider', message: 'The service returned an unexpected sign-in address or expiry.'});
      }
      this.pending = {flowId: start.flowId, verifier, expiresAt, generation, completing: false};
      this.blocked = false;
      await this.emit(generation);
      this.check(generation);
      await this.openExternal(url.toString());
      this.check(generation);
      return {ok: true, value: null};
    } catch (error) {
      if (generation === this.generation) { this.pending = null; this.onChange({status: 'signed-out', error: toError(error)}); }
      return {ok: false, error: toError(error)};
    }
  }

  async cancelSignIn(): Promise<void> {
    this.advance();
    this.pending = null;
    this.me = null;
    this.blocked = true;
    this.onChange({status: 'signed-out'});
  }

  async completeSignIn(callback: URL): Promise<void> {
    if (callback.protocol !== 'multai-dev:' || callback.hostname !== 'auth' || callback.pathname !== '/callback' || callback.username || callback.password || callback.port || callback.hash) return;
    if (callback.searchParams.getAll('flowId').length !== 1 || callback.searchParams.getAll('completionCode').length !== 1 || [...callback.searchParams.keys()].some(key => !['flowId', 'completionCode'].includes(key))) return;
    const input = z.object({flowId: z.uuid(), completionCode: opaque}).safeParse(Object.fromEntries(callback.searchParams));
    const pending = this.pending;
    if (!input.success || !pending || pending.completing || input.data.flowId !== pending.flowId || pending.generation !== this.generation) return;
    pending.completing = true;
    const generation = pending.generation;
    let issued: z.infer<typeof tokenBundle> | undefined;
    try {
      if (this.now() > pending.expiresAt) throw new ApiFailure({code: 'invalid_flow', message: 'Sign-in took too long. Start again.'});
      const record = await this.store.load();
      this.check(generation);
      let proof = record.lastUserId ? record.devices[record.lastUserId] : undefined;
      const base = {...input.data, codeVerifier: pending.verifier, deviceName: this.hostname().replace(/[\u0000-\u001f]/g, '').slice(0, 120) || 'Desktop'};
      try { issued = tokenBundle.parse(await this.send('POST', '/v1/auth/google/exchange', proof ? {...base, ...proof} : base)); }
      catch (error) {
        // Only an explicitly different verified account may enroll anew. Revoked/wrong
        // proof never silently changes this installation's original-host identity.
        this.check(generation);
        if (!(proof && error instanceof ApiFailure && error.error.code === 'device_account_mismatch')) throw error;
        proof = undefined;
        issued = tokenBundle.parse(await this.send('POST', '/v1/auth/google/exchange', base));
      }
      this.check(generation);
      if ((!proof && !issued.deviceSecret) || (proof && issued.deviceId !== proof.deviceId)) throw new ApiFailure({code: 'unexpected_response', message: 'The service did not preserve the expected device identity.'});
      const me = meSchema.parse(await this.send('GET', '/v1/me', undefined, issued.accessToken));
      this.check(generation);
      if (me.deviceId !== issued.deviceId) throw new ApiFailure({code: 'unexpected_response', message: 'The signed-in device does not match its credential.'});
      const devices = {...record.devices};
      if (issued.deviceSecret) devices[me.id] = {deviceId: issued.deviceId, deviceSecret: issued.deviceSecret};
      await this.store.save({active: {userId: me.id, accessToken: issued.accessToken, refreshToken: issued.refreshToken, accessExpiresAt: this.now() + issued.expiresIn * 1000}, devices, lastUserId: me.id});
      this.check(generation);
      this.pending = null;
      this.me = me;
      await this.emit(generation);
    } catch (error) {
      if (issued) await this.send('POST', '/v1/auth/logout', undefined, issued.accessToken).catch(() => undefined);
      if (generation !== this.generation) return;
      this.pending = null;
      this.me = null;
      this.blocked = true;
      await this.store.clearActive().catch(() => undefined);
      this.onChange({status: 'signed-out', error: toError(error)});
    }
  }

  async signOut(): Promise<Result<null>> {
    // Fence before the first await. Late refresh/callback responses cannot restore identity.
    this.advance();
    this.pending = null;
    this.me = null;
    this.blocked = true;
    this.onChange({status: 'signed-out'});
    let token: string | undefined;
    try { token = (await this.store.load()).active?.accessToken; } catch { /* A locked keyring must not prevent local sign-out. */ }
    try { await this.store.clearActive(); }
    catch (error) { return {ok: false, error: toError(error)}; }
    if (token) await this.send('POST', '/v1/auth/logout', undefined, token).catch(() => undefined);
    return {ok: true, value: null};
  }

  async accessToken(): Promise<string> {
    const generation = this.generation;
    if (this.blocked || this.pending) throw signedOut();
    if (this.refreshing?.generation === generation) return this.refreshing.promise;
    const record = await this.store.load();
    this.check(generation);
    if (!record.active) throw signedOut();
    if (!this.forceRefresh && record.active.accessExpiresAt - REFRESH_MARGIN_MS > this.now()) return record.active.accessToken;
    return this.refresh();
  }

  private refresh(): Promise<string> {
    const generation = this.generation;
    if (this.refreshing?.generation === generation) return this.refreshing.promise;
    const promise = this.doRefresh(generation).finally(() => { if (this.refreshing?.promise === promise) this.refreshing = null; });
    this.refreshing = {generation, promise};
    return promise;
  }

  private async doRefresh(generation: number): Promise<string> {
    const record = await this.store.load();
    this.check(generation);
    if (this.blocked || this.pending || !record.active) throw signedOut();
    const active = record.active;
    let issued: z.infer<typeof tokenBundle> | undefined;
    try {
      // Persist nonsecret uncertainty BEFORE the rotating request. A crash between
      // provider consumption and replacement cannot replay a stale refresh on restart.
      await this.store.clearActive();
      this.check(generation);
      const bundle = tokenBundle.parse(await this.send('POST', '/v1/auth/refresh', {refreshToken: active.refreshToken}));
      issued = bundle;
      this.check(generation);
      if (this.me && bundle.deviceId !== this.me.deviceId) throw new Error('Unexpected refreshed device');
      await this.store.save({...record, active: {...active, accessToken: bundle.accessToken, refreshToken: bundle.refreshToken, accessExpiresAt: this.now() + bundle.expiresIn * 1000}});
      this.check(generation);
      this.forceRefresh = false;
      return bundle.accessToken;
    } catch (error) {
      if (generation !== this.generation) {
        if (issued) await this.send('POST', '/v1/auth/logout', undefined, issued.accessToken).catch(() => undefined);
        throw stale();
      }
      if (error instanceof ApiFailure && error.error.code === 'offline_unsent') {
        await this.store.save(record);
        this.check(generation);
        throw error;
      }
      // A refresh may already be consumed: uncertain delivery cannot be replayed.
      this.advance();
      this.me = null;
      this.blocked = true;
      await this.store.clearActive();
      const expired = {code: 'session_expired', message: 'Your sign-in expired. Sign in again to continue.', status: 401};
      this.onChange({status: 'signed-out', error: expired});
      throw new ApiFailure(expired);
    }
  }

  async request(method: string, path: string, body?: unknown): Promise<unknown> {
    const generation = this.generation;
    const token = await this.accessToken();
    this.check(generation);
    try { const result = await this.send(method, path, body, token); this.check(generation); return result; }
    catch (error) {
      this.check(generation);
      if (!(error instanceof ApiFailure) || error.error.status !== 401) throw error;
      this.forceRefresh = true;
      const fresh = await this.refresh();
      this.check(generation);
      const result = await this.send(method, path, body, fresh);
      this.check(generation);
      return result;
    }
  }

  private async send(method: string, requestPath: string, body?: unknown, token?: string): Promise<unknown> {
    const url = new URL(requestPath, this.origin);
    if (!requestPath.startsWith('/') || requestPath.startsWith('//') || url.origin !== this.origin) throw new ApiFailure({code: 'invalid_request', message: 'A request cannot leave the configured collaboration service.'});
    const controller = new AbortController();
    this.inFlight.add(controller);
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      let response: Response;
      try {
        response = await this.fetcher(url, {method, headers: {...(body !== undefined ? {'content-type': 'application/json'} : {}), ...(token ? {authorization: `Bearer ${token}`} : {})}, ...(body !== undefined ? {body: JSON.stringify(body)} : {}), signal: controller.signal, redirect: 'error'});
      } catch (error) {
        throw new ApiFailure(neverSent(error) ? {code: 'offline_unsent', message: 'Can’t reach the collaboration service.'} : {code: 'network_uncertain', message: 'The connection dropped before the service answered.'});
      }
      if (response.status === 204) return null;
      const json = await responseJson(response);
      if (!response.ok) {
        const parsed = errorBody.safeParse(json);
        throw new ApiFailure(parsed.success ? {...parsed.data.error, status: response.status} : {code: 'http_error', message: `The service answered ${response.status}.`, status: response.status});
      }
      return json;
    } finally { clearTimeout(timer); this.inFlight.delete(controller); }
  }

  async authorizationHeader(): Promise<string> { return `Bearer ${await this.accessToken()}`; }
  forceRefreshOnNextUse(): void { this.forceRefresh = true; }
}

export function toError(error: unknown): ServiceError {
  if (error instanceof ApiFailure) return error.error;
  if (error instanceof CredentialStorageError) return {code: error.code, message: error.message};
  if (error instanceof z.ZodError) return {code: 'unexpected_response', message: 'The service sent a response this app doesn’t understand.'};
  return {code: 'internal', message: 'Something went wrong.'};
}
