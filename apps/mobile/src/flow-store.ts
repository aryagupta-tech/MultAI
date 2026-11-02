// Account expects synchronous PKCE/return-intent reads. Hydrate an in-memory cache from the Android
// Keystore, queue durable writes, then flush them before leaving the app for Google's Custom Tab.
import type {PlainStore, SecureStore} from '@multai/companion-core';

export interface FlowStore extends PlainStore {flush(): Promise<void>}

export async function nativeFlowKey(key: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(key));
  return `flow.${[...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('').slice(0, 58)}`;
}

export async function nativeFlowStore(secure: SecureStore, allowedKeys: readonly string[]): Promise<FlowStore> {
  const names = new Map(await Promise.all(allowedKeys.map(async key => [key, await nativeFlowKey(key)] as const)));
  const values = new Map<string, string>();
  let failure: unknown;
  await Promise.all([...names].map(async ([key, name]) => {
    try {const value = await secure.get(name); if (value !== null) values.set(key, value);}
    catch (error) {failure = error;}
  }));
  let pending = Promise.resolve();
  const queue = (work: () => Promise<void>) => {pending = pending.then(work).catch(error => {failure = error;});};
  return {
    get: key => values.get(key) ?? null,
    set: (key, value) => {
      const name = names.get(key);
      if (!name) throw new TypeError('Unsupported sign-in storage key.');
      values.set(key, value);
      queue(() => secure.set(name, value));
    },
    remove: key => {
      const name = names.get(key);
      if (!name) return;
      values.delete(key);
      queue(() => secure.remove(name));
    },
    flush: async () => {
      await pending;
      if (failure) {failure = undefined; throw new Error('Secure sign-in storage is unavailable. Try again before signing in.');}
    },
  };
}
