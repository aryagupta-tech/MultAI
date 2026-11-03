// Ordinary Google sign-in for a phone: a collaborator/viewer/owner account on a new device. It never
// carries original-host or owner-controller authority; that needs desktop pairing (controller.ts).
import {ApiClient, ApiError} from './client.js';
import {randomSecret, sha256, toBase64Url} from './canonical.js';
import {meSchema, signInStartSchema, tokenBundleSchema, webSessionSchema, type Me} from './wire.js';
import type {PlainStore, SecureStore} from './storage.js';

export type AccountState =
  | {status: 'signed-out'; reason?: 'expired' | 'revoked' | 'signed-out'}
  | {status: 'restoring'}
  | {status: 'signed-in'; me: Me};

const KEYS = {refresh: 'account.refreshToken', device: 'account.deviceId', deviceSecret: 'account.deviceSecret', flow: 'account.pendingFlow'};
const REFRESH_MARGIN_MS = 60_000;

export interface AccountPlatform {
  /** Android: Keystore-backed storage for the refresh token and device proof. Browser: null (HttpOnly cookie). */
  secure: SecureStore | null;
  /** Holds the PKCE verifier across the redirect: sessionStorage in a browser, secure storage on Android. */
  flows: PlainStore;
  deviceName(): string;
  /** Browser: navigate this tab. Android: open a Custom Tab. */
  openSignIn(url: string): Promise<void>;
}

export class Account {
  private access: {token: string; expiresAt: number} | null = null;
  private refreshing: Promise<string> | null = null;
  private state: AccountState = {status: 'restoring'};
  private readonly listeners = new Set<(state: AccountState) => void>();
  /** Bumped on sign-out so a late refresh cannot sign a newer state back in. */
  private generation = 0;
  constructor(private readonly api: ApiClient, private readonly platform: AccountPlatform) {}

  get current(): AccountState {return this.state;}
  subscribe(listener: (state: AccountState) => void): () => void {this.listeners.add(listener); listener(this.state); return () => this.listeners.delete(listener);}
  private set(state: AccountState) {this.state = state; for (const listener of this.listeners) listener(state);}

  /** Restores a saved sign-in after a reload, resume or process death. Network failure keeps the saved sign-in. */
  async restore(): Promise<AccountState> {
    try {
      await this.token();
      await this.loadMe();
    } catch (error) {
      if (error instanceof ApiError && error.uncertain) {
        // Keep the credential and say so; the app retries when the network returns.
        if (this.state.status === 'restoring') this.set({status: 'signed-out', reason: 'signed-out'});
        throw error;
      }
      this.set({status: 'signed-out'});
    }
    return this.state;
  }

  async beginSignIn(): Promise<void> {
    const verifier = randomSecret() + randomSecret();
    const challenge = toBase64Url(await sha256(verifier));
    const started = this.api.mode === 'web'
      ? await this.api.request('POST', '/v1/web/auth/start', {body: {codeChallenge: challenge}, schema: signInStartSchema})
      : await this.api.request('POST', '/v1/auth/google/start', {body: {codeChallenge: challenge, client: 'android'}, schema: signInStartSchema});
    this.platform.flows.set(KEYS.flow, JSON.stringify({flowId: started.flowId, verifier, expiresAt: Date.parse(started.expiresAt)}));
    await this.platform.openSignIn(started.authorizationUrl);
  }

  /** `fragment` is the part after # of the callback: `signin=<flowId>.<completionCode>`. */
  async completeSignIn(fragment: string): Promise<AccountState> {
    const match = /(?:^|[#&])signin=([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})(?:&|$)/u.exec(fragment);
    const saved = this.platform.flows.get(KEYS.flow);
    this.platform.flows.remove(KEYS.flow);
    if (!match || !saved) throw new ApiError(400, 'sign_in_incomplete', 'Sign-in didn’t finish. Try again.', 'invalid');
    const flow = JSON.parse(saved) as {flowId: string; verifier: string; expiresAt: number};
    if (flow.flowId !== match[1] || flow.expiresAt <= Date.now()) throw new ApiError(400, 'sign_in_expired', 'That sign-in expired. Try again.', 'invalid');
    const body = {flowId: flow.flowId, completionCode: match[2], codeVerifier: flow.verifier, deviceName: this.platform.deviceName().slice(0, 120)};
    const generation = ++this.generation;
    if (this.api.mode === 'web') {
      const session = await this.api.request('POST', '/v1/web/auth/exchange', {body, schema: webSessionSchema});
      if (generation !== this.generation) throw new ApiError(409, 'stale', 'Sign-in changed.', 'invalid');
      this.access = {token: session.accessToken, expiresAt: Date.now() + session.expiresIn * 1000};
    } else {
      const secure = this.requireSecure();
      const deviceId = await secure.get(KEYS.device), deviceSecret = await secure.get(KEYS.deviceSecret);
      const exchange = (device: boolean) => this.api.request('POST', '/v1/auth/google/exchange', {body: {...body, ...(device && deviceId && deviceSecret ? {deviceId, deviceSecret} : {})}, schema: tokenBundleSchema});
      let tokens: Awaited<ReturnType<typeof exchange>>;
      try {tokens = await exchange(true);}
      catch (failure) {
        // This phone was enrolled for another account (someone signed out and in as someone else): enroll it anew.
        if (!(failure instanceof ApiError) || failure.code !== 'device_account_mismatch') throw failure;
        await secure.remove(KEYS.device); await secure.remove(KEYS.deviceSecret);
        tokens = await exchange(false);
      }
      if (generation !== this.generation) throw new ApiError(409, 'stale', 'Sign-in changed.', 'invalid');
      await secure.set(KEYS.refresh, tokens.refreshToken);
      await secure.set(KEYS.device, tokens.deviceId);
      if (tokens.deviceSecret) await secure.set(KEYS.deviceSecret, tokens.deviceSecret);
      this.access = {token: tokens.accessToken, expiresAt: Date.now() + tokens.expiresIn * 1000};
    }
    await this.loadMe();
    return this.state;
  }

  private requireSecure(): SecureStore {
    if (!this.platform.secure) throw new TypeError('Secure storage is required in the app.');
    return this.platform.secure;
  }
  private async loadMe() {
    const me = await this.authorized(token => this.api.request('GET', '/v1/me', {auth: {type: 'bearer', token}, schema: meSchema}));
    this.set({status: 'signed-in', me});
  }

  /** A valid access token, refreshed shortly before expiry. Only one refresh runs at a time. */
  async token(): Promise<string> {
    if (this.access && this.access.expiresAt - REFRESH_MARGIN_MS > Date.now()) return this.access.token;
    return this.refresh();
  }
  private refresh(): Promise<string> {
    if (this.refreshing) return this.refreshing;
    const generation = this.generation;
    this.refreshing = (async () => {
      try {
        if (this.api.mode === 'web') {
          const session = await this.api.request('POST', '/v1/web/auth/refresh', {body: {}, schema: webSessionSchema});
          if (generation !== this.generation) throw new ApiError(401, 'signed_out', 'Signed out.');
          this.access = {token: session.accessToken, expiresAt: Date.now() + session.expiresIn * 1000};
        } else {
          const secure = this.requireSecure();
          const refreshToken = await secure.get(KEYS.refresh);
          if (!refreshToken) throw new ApiError(401, 'signed_out', 'Sign in to continue.');
          const tokens = await this.api.request('POST', '/v1/auth/refresh', {body: {refreshToken}, schema: tokenBundleSchema});
          if (generation !== this.generation) throw new ApiError(401, 'signed_out', 'Signed out.');
          await secure.set(KEYS.refresh, tokens.refreshToken);
          this.access = {token: tokens.accessToken, expiresAt: Date.now() + tokens.expiresIn * 1000};
        }
        return this.access.token;
      } catch (error) {
        if (error instanceof ApiError && !error.uncertain && error.status === 401) await this.forget('expired');
        throw error;
      } finally {this.refreshing = null;}
    })();
    return this.refreshing;
  }

  /** Runs a request with the access token; one refresh and retry when the token was rejected. */
  async authorized<T>(work: (token: string) => Promise<T>): Promise<T> {
    const token = await this.token();
    try {return await work(token);}
    catch (error) {
      if (!(error instanceof ApiError) || error.status !== 401) throw error;
      this.access = null;
      return work(await this.refresh());
    }
  }

  private async forget(reason: 'expired' | 'revoked' | 'signed-out') {
    this.generation++;
    this.access = null;
    if (this.platform.secure) await this.platform.secure.remove(KEYS.refresh);
    this.set({status: 'signed-out', reason});
  }

  async signOut(): Promise<void> {
    const token = this.access?.token;
    try {
      if (this.api.mode === 'web') await this.api.request('POST', '/v1/web/auth/logout', {body: {}, ...(token ? {auth: {type: 'bearer', token}} : {})});
      else if (token) await this.api.request('POST', '/v1/auth/logout', {auth: {type: 'bearer', token}});
    } catch {/* Signing out locally always succeeds. */}
    await this.forget('signed-out');
  }
}
