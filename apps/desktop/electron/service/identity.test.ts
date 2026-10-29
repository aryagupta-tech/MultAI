import {createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID} from 'node:crypto';
import {mkdtemp, readdir, readFile, rm, stat, writeFile} from 'node:fs/promises';
import {EventEmitter} from 'node:events';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {afterEach, describe, expect, it, vi} from 'vitest';
import type WebSocket from 'ws';

vi.mock('electron', () => ({app: {getPath: () => '/unused-injected-test-path'}, shell: {openExternal: vi.fn()}, safeStorage: {}}));

import {Account, ApiFailure} from './account';
import {CredentialStore, type CredentialPersistence, type CredentialRecord, type SecureStorage} from './credentials';
import {LiveHub} from './live';

const origin = 'http://127.0.0.1:4310';
const secret = () => randomBytes(32).toString('base64url');
const userId = randomUUID();
const deviceId = randomUUID();
const workspaceId = randomUUID();
const now = 1_800_000_000_000;
const identity = {id: userId, displayName: 'Synthetic person', deviceId, workspaceId};
const credentials = (): CredentialRecord => ({active: {userId, accessToken: secret(), refreshToken: secret(), accessExpiresAt: now + 900_000}, devices: {[userId]: {deviceId, deviceSecret: secret()}}, lastUserId: userId});
const empty = (): CredentialRecord => ({active: null, devices: {}, lastUserId: null});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});
const bundle = () => ({accessToken: secret(), refreshToken: secret(), expiresIn: 900, deviceId, deviceSecret: secret()});
const start = () => ({flowId: randomUUID(), authorizationUrl: 'https://accounts.google.com/o/oauth2/v2/auth?synthetic=1', expiresAt: new Date(now + 300_000).toISOString()});
const callback = (flowId: string) => new URL(`multai-dev://auth/callback?flowId=${flowId}&completionCode=${secret()}`);
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {resolve = yes; reject = no;});
  return {promise, resolve, reject};
}
async function settle() { for (let i = 0; i < 10; i++) await Promise.resolve(); }
class MemoryStore implements CredentialPersistence {
  encrypted = true;
  constructor(public record: CredentialRecord = empty()) {}
  assertAvailable() { if (!this.encrypted) throw new Error('Synthetic unavailable keyring'); }
  async load() { return structuredClone(this.record); }
  async save(next: CredentialRecord) { this.record = structuredClone(next); }
  async clearActive() { this.record = {...this.record, active: null}; }
}
function account(fetcher: (url: URL, init?: RequestInit) => Promise<Response>, store = new MemoryStore()) {
  const changes = vi.fn();
  const openExternal = vi.fn(async () => undefined);
  const instance = new Account(origin, changes, {store, fetch: fetcher as typeof fetch, openExternal, now: () => now, hostname: () => 'Synthetic device'});
  return {instance, store, changes, openExternal};
}

describe('native collaboration identity fences', () => {
  it('binds callback to the initiating verifier and exposes a credential-free identity snapshot', async () => {
    const flow = start();
    let challenge = '';
    let exchangeVerifier = '';
    let exchangeCount = 0;
    const ctx = account(async (url, init) => {
      if (url.pathname.endsWith('/start')) { challenge = JSON.parse(init!.body as string).codeChallenge; return json(flow); }
      if (url.pathname.endsWith('/exchange')) { exchangeCount++; exchangeVerifier = JSON.parse(init!.body as string).codeVerifier; return json(bundle()); }
      if (url.pathname === '/v1/me') return json(identity);
      throw new Error('Unexpected synthetic endpoint');
    });
    expect((await ctx.instance.signIn()).ok).toBe(true);
    expect(ctx.openExternal).toHaveBeenCalledOnce();
    const link = callback(flow.flowId);
    await ctx.instance.completeSignIn(link);
    await ctx.instance.completeSignIn(link);
    expect(exchangeCount).toBe(1);
    expect(challenge).toBe(createHash('sha256').update(exchangeVerifier).digest('base64url'));
    expect(await ctx.instance.identitySnapshot()).toEqual({userId, deviceId, generation: ctx.instance.accountGeneration});
    expect(Object.keys(await ctx.instance.identitySnapshot()).sort()).toEqual(['deviceId', 'generation', 'userId']);
    expect(ctx.store.record.active?.userId).toBe(userId);
  });

  it('a canceled pending start cannot reopen the browser or create a new pending flow', async () => {
    const pending = deferred<Response>();
    const ctx = account(async () => pending.promise);
    const beginning = ctx.instance.signIn();
    await settle();
    await ctx.instance.cancelSignIn();
    pending.resolve(json(start()));
    expect((await beginning).ok).toBe(false);
    expect(ctx.openExternal).not.toHaveBeenCalled();
    expect((await ctx.instance.state()).status).toBe('signed-out');
  });

  it('sign-out fences an in-flight exchange before it can save credentials', async () => {
    const flow = start();
    const pending = deferred<Response>();
    let exchangeStarted = false;
    const ctx = account(async url => {
      if (url.pathname.endsWith('/start')) return json(flow);
      if (url.pathname.endsWith('/exchange')) {exchangeStarted = true; return pending.promise;}
      if (url.pathname.endsWith('/logout')) return new Response(null, {status: 204});
      if (url.pathname === '/v1/me') return json(identity);
      throw new Error('Unexpected endpoint');
    });
    await ctx.instance.signIn();
    const completion = ctx.instance.completeSignIn(callback(flow.flowId));
    await settle();
    expect(exchangeStarted).toBe(true);
    const generation = ctx.instance.accountGeneration;
    const signingOut = ctx.instance.signOut();
    expect(ctx.instance.accountGeneration).toBeGreaterThan(generation);
    await expect(ctx.instance.accessToken()).rejects.toBeInstanceOf(ApiFailure);
    await signingOut;
    pending.resolve(json(bundle()));
    await completion;
    expect(ctx.store.record.active).toBeNull();
    expect((await ctx.instance.state()).status).toBe('signed-out');
    expect(ctx.changes.mock.calls.every(([change]) => change.status !== 'signed-in')).toBe(true);
  });

  it('refresh is serialized and refresh-on-next-use actually rotates a fresh token', async () => {
    let refreshes = 0;
    const store = new MemoryStore(credentials());
    const next = bundle();
    const ctx = account(async url => {
      if (url.pathname.endsWith('/refresh')) {refreshes++; await settle(); return json(next);}
      if (url.pathname === '/v1/me') return json(identity);
      throw new Error('Unexpected endpoint');
    }, store);
    await ctx.instance.identitySnapshot();
    ctx.instance.forceRefreshOnNextUse();
    const values = await Promise.all([ctx.instance.accessToken(), ctx.instance.accessToken(), ctx.instance.accessToken()]);
    expect(refreshes).toBe(1);
    expect(values).toEqual([next.accessToken, next.accessToken, next.accessToken]);
    expect(store.record.active?.refreshToken).toBe(next.refreshToken);
  });

  it('a late refresh failure cannot clear an account signed in after it', async () => {
    const pending = deferred<Response>();
    const flow = start();
    const store = new MemoryStore(credentials());
    let refreshStarted = false;
    const ctx = account(async url => {
      if (url.pathname.endsWith('/refresh')) {refreshStarted = true; return pending.promise;}
      if (url.pathname.endsWith('/logout')) return new Response(null, {status: 204});
      if (url.pathname.endsWith('/start')) return json(flow);
      if (url.pathname.endsWith('/exchange')) return json(bundle());
      if (url.pathname === '/v1/me') return json(identity);
      throw new Error('Unexpected endpoint');
    }, store);
    ctx.instance.forceRefreshOnNextUse();
    const refreshing = ctx.instance.accessToken();
    const rejected = expect(refreshing).rejects.toBeInstanceOf(ApiFailure);
    await settle();
    expect(refreshStarted).toBe(true);
    await ctx.instance.signOut();
    await ctx.instance.signIn();
    await ctx.instance.completeSignIn(callback(flow.flowId));
    const currentToken = store.record.active!.accessToken;
    pending.resolve(json({error: {code: 'invalid_credentials', message: 'Synthetic revoked'}}, 401));
    await rejected;
    expect(store.record.active?.accessToken).toBe(currentToken);
    expect((await ctx.instance.state()).status).toBe('signed-in');
  });

  it('uncertain refresh clears authority while a provably unsent refresh remains retryable', async () => {
    for (const unsent of [true, false]) {
      const store = new MemoryStore(credentials());
      const ctx = account(async () => {
        if (unsent) throw Object.assign(new Error('Synthetic refusal'), {cause: {code: 'ECONNREFUSED'}});
        throw new TypeError('Synthetic uncertain network failure');
      }, store);
      ctx.instance.forceRefreshOnNextUse();
      await expect(ctx.instance.accessToken()).rejects.toBeInstanceOf(ApiFailure);
      expect(store.record.active === null).toBe(!unsent);
    }
  });

  it('revoked proof cannot silently enroll a replacement; verified account mismatch can', async () => {
    for (const mismatch of [false, true]) {
      const flow = start();
      const store = new MemoryStore({...credentials(), active: null});
      const priorProof = store.record.devices[userId];
      const nextUserId = randomUUID();
      const nextDeviceId = randomUUID();
      let exchanges = 0;
      const ctx = account(async url => {
        if (url.pathname.endsWith('/start')) return json(flow);
        if (url.pathname.endsWith('/exchange')) {
          exchanges++;
          if (exchanges === 1) return json({error: {code: mismatch ? 'device_account_mismatch' : 'invalid_device_proof', message: 'Synthetic device mismatch'}}, 401);
          return json({...bundle(), deviceId: nextDeviceId});
        }
        if (url.pathname === '/v1/me') return json({...identity, id: nextUserId, deviceId: nextDeviceId});
        if (url.pathname.endsWith('/logout')) return new Response(null, {status: 204});
        throw new Error('Unexpected endpoint');
      }, store);
      await ctx.instance.signIn();
      await ctx.instance.completeSignIn(callback(flow.flowId));
      expect(exchanges).toBe(mismatch ? 2 : 1);
      expect((await ctx.instance.state()).status).toBe(mismatch ? 'signed-in' : 'signed-out');
      expect(store.record.devices[userId]).toEqual(priorProof);
      if (mismatch) expect(store.record.devices[nextUserId]?.deviceId).toBe(nextDeviceId);
    }
  });

  it('foreign callback, duplicate parameters and cross-origin requests never receive credentials', async () => {
    const flow = start();
    const fetcher = vi.fn(async url => {
      if ((url as URL).pathname.endsWith('/start')) return json(flow);
      throw new Error('Unexpected endpoint');
    });
    const ctx = account(fetcher);
    await ctx.instance.signIn();
    await ctx.instance.completeSignIn(new URL(`https://untrusted.example/callback?flowId=${flow.flowId}&completionCode=${secret()}`));
    const repeated = callback(flow.flowId);
    repeated.searchParams.append('flowId', flow.flowId);
    await ctx.instance.completeSignIn(repeated);
    expect(fetcher).toHaveBeenCalledOnce();
    const active = account(fetcher, new MemoryStore(credentials()));
    await expect(active.instance.request('GET', 'https://untrusted.example/steal')).rejects.toBeInstanceOf(ApiFailure);
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

function syntheticStorage(): SecureStorage & {available: boolean; backend: string} {
  const key = randomBytes(32);
  return {
    available: true, backend: 'gnome_libsecret',
    isEncryptionAvailable() {return this.available;},
    getSelectedStorageBackend() {return this.backend;},
    encryptString(value) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', key, nonce);
      const bytes = Buffer.concat([cipher.update(value), cipher.final()]);
      return Buffer.concat([nonce, cipher.getAuthTag(), bytes]);
    },
    decryptString(value) {
      const decipher = createDecipheriv('aes-256-gcm', key, value.subarray(0, 12), {authTagLength: 16});
      decipher.setAuthTag(value.subarray(12, 28));
      return Buffer.concat([decipher.update(value.subarray(28)), decipher.final()]).toString();
    },
  };
}

describe('encrypted credential persistence with synthetic OS crypto', () => {
  const folders: string[] = [];
  afterEach(async () => {await Promise.all(folders.splice(0).map(folder => rm(folder, {recursive: true, force: true})));});
  async function folder() {const value = await mkdtemp(path.join(tmpdir(), 'multai-identity-')); folders.push(value); return value;}

  it('rejects Linux basic_text or locked keyrings without writing credentials', async () => {
    const directory = await folder();
    const storage = syntheticStorage();
    storage.backend = 'basic_text';
    const store = new CredentialStore(origin, {directory, platform: 'linux', storage});
    expect(store.encrypted).toBe(false);
    await expect(store.save(credentials())).rejects.toThrow('Unlock an approved OS keyring');
    expect(await readdir(directory)).toEqual([]);
    storage.backend = 'gnome_libsecret';
    storage.available = false;
    await expect(store.load()).rejects.toThrow('Unlock an approved OS keyring');
  });

  it('scopes credentials by full origin and atomically stores private encrypted bytes', async () => {
    const directory = await folder();
    const storage = syntheticStorage();
    const store = new CredentialStore(origin, {directory, platform: 'linux', storage});
    const record = credentials();
    await store.save(record);
    const names = await readdir(directory);
    expect(names).toHaveLength(1);
    const file = path.join(directory, names[0]!);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await readFile(file)).includes(Buffer.from(record.active!.refreshToken))).toBe(false);
    const anotherScheme = new CredentialStore(origin.replace('http:', 'https:'), {directory, platform: 'linux', storage});
    expect((await anotherScheme.load()).active).toBeNull();
    const copy = await store.load();
    copy.active!.accessToken = secret();
    expect((await store.load()).active!.accessToken).toBe(record.active!.accessToken);
  });

  it('sign-out while the keyring is locked survives restart and preserves account device proofs', async () => {
    const directory = await folder();
    const storage = syntheticStorage();
    const options = {directory, platform: 'linux' as const, storage};
    const store = new CredentialStore(origin, options);
    const record = credentials();
    await store.save(record);
    storage.available = false;
    await store.clearActive();
    const restarted = new CredentialStore(origin, options);
    await expect(restarted.load()).rejects.toThrow();
    storage.available = true;
    const restored = await restarted.load();
    expect(restored.active).toBeNull();
    expect(restored.devices).toEqual(record.devices);
    await restarted.save(record);
    expect((await new CredentialStore(origin, options).load()).active?.userId).toBe(userId);
  });

  it('serializes replacement writes and fails closed on corrupted encrypted records', async () => {
    const directory = await folder();
    const storage = syntheticStorage();
    const options = {directory, platform: 'linux' as const, storage};
    const store = new CredentialStore(origin, options);
    const first = credentials();
    const second = credentials();
    await Promise.all([store.save(first), store.save(second)]);
    expect((await new CredentialStore(origin, options).load()).active?.accessToken).toBe(second.active!.accessToken);
    const file = (await readdir(directory))[0]!;
    await writeFile(path.join(directory, file), Buffer.from('synthetic corruption'));
    await expect(new CredentialStore(origin, options).load()).rejects.toThrow('encrypted credential record');
  });

  it('persists refresh uncertainty before network delivery so restart cannot replay a consumed credential', async () => {
    const directory = await folder();
    const options = {directory, platform: 'linux' as const, storage: syntheticStorage()};
    const store = new CredentialStore(origin, options);
    const record = credentials();
    await store.save(record);
    const pending = deferred<Response>();
    const next = bundle();
    const delivered = deferred<void>();
    const instance = new Account(origin, vi.fn(), {store, now: () => now, fetch: (async () => {delivered.resolve(); return pending.promise;}) as typeof fetch});
    instance.forceRefreshOnNextUse();
    const refresh = instance.accessToken();
    await delivered.promise;
    const recovered = await new CredentialStore(origin, options).load();
    expect(recovered.active).toBeNull();
    expect(recovered.devices).toEqual(record.devices);
    pending.resolve(json(next));
    expect(await refresh).toBe(next.accessToken);
    expect((await new CredentialStore(origin, options).load()).active?.refreshToken).toBe(next.refreshToken);
  });
});

class SyntheticSocket extends EventEmitter {
  terminated = false;
  terminate() {this.terminated = true; this.emit('close', 1006, Buffer.from(''));}
}

describe('live replay authority and ordering', () => {
  afterEach(() => vi.useRealTimers());
  const sessionId = randomUUID();
  const event = (sequence: number) => Buffer.from(JSON.stringify({type: 'event', event: {id: randomUUID(), sessionId, sequence, type: 'message.discussion', actorId: userId, payload: {text: 'Synthetic'}, createdAt: new Date(now).toISOString()}}));

  it('replays an unflushed gap from the last delivered cursor and ends on membership_required', async () => {
    vi.useFakeTimers();
    const sockets: SyntheticSocket[] = [];
    const urls: URL[] = [];
    const actor = {origin, accountGeneration: 0, authorizationHeader: async () => `Bearer ${secret()}`, forceRefreshOnNextUse: vi.fn()};
    const emit = vi.fn();
    const status = vi.fn();
    const hub = new LiveHub(actor, emit, status, {socketFactory: url => {urls.push(url); const socket = new SyntheticSocket(); sockets.push(socket); return socket as unknown as WebSocket;}});
    hub.subscribe(sessionId, 0);
    await settle();
    sockets[0]!.emit('message', event(1));
    sockets[0]!.emit('message', event(3));
    expect(sockets[0]!.terminated).toBe(true);
    await vi.advanceTimersByTimeAsync(250);
    expect(urls[1]?.searchParams.get('after')).toBe('0');
    sockets[1]!.emit('message', event(1));
    sockets[1]!.emit('message', event(2));
    await vi.advanceTimersByTimeAsync(16);
    expect(emit.mock.calls[0]![0].events.map((item: {sequence: number}) => item.sequence)).toEqual([1, 2]);
    sockets[1]!.emit('close', 1008, Buffer.from('membership_required'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(sockets).toHaveLength(2);
    expect(status).toHaveBeenLastCalledWith({sessionId, status: 'ended', reason: 'membership_required'});
    hub.closeAll();
  });

  it('signed-out authority stops retries and account-generation changes fence buffered frames', async () => {
    vi.useFakeTimers();
    const status = vi.fn();
    const factory = vi.fn();
    const signedOut = {origin, accountGeneration: 0, authorizationHeader: async () => {throw new ApiFailure({code: 'signed_out', message: 'Synthetic signed out', status: 401});}, forceRefreshOnNextUse: vi.fn()};
    const denied = new LiveHub(signedOut, vi.fn(), status, {socketFactory: factory});
    denied.subscribe(sessionId, 0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(factory).not.toHaveBeenCalled();
    expect(status).toHaveBeenLastCalledWith({sessionId, status: 'ended', reason: 'signed_out'});
    const actor = {origin, accountGeneration: 0, authorizationHeader: async () => `Bearer ${secret()}`, forceRefreshOnNextUse: vi.fn()};
    const socket = new SyntheticSocket();
    const emit = vi.fn();
    const hub = new LiveHub(actor, emit, status, {socketFactory: () => socket as unknown as WebSocket});
    hub.subscribe(sessionId, 0);
    await settle();
    socket.emit('message', event(1));
    actor.accountGeneration++;
    await vi.advanceTimersByTimeAsync(16);
    expect(emit).not.toHaveBeenCalled();
    expect(socket.terminated).toBe(true);
    hub.closeAll();
  });
});
