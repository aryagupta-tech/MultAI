// Platform storage the core needs. Secrets go only to `SecureStore` (Android Keystore) or HttpOnly
// cookies (browser); `PlainStore` holds non-secret state such as pending request ids.

export interface SecureStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  remove(key: string): Promise<void>;
}
export interface PlainStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
  remove(key: string): void;
}
/** Non-extractable WebCrypto keys survive in IndexedDB; their private bytes can never be read back. */
export interface KeyStore {
  load(): Promise<{signing: CryptoKeyPair; encryption: CryptoKeyPair} | null>;
  save(keys: {signing: CryptoKeyPair; encryption: CryptoKeyPair}): Promise<void>;
  clear(): Promise<void>;
}

export class MemoryStore implements PlainStore {
  private readonly values = new Map<string, string>();
  get(key: string): string | null {return this.values.get(key) ?? null;}
  set(key: string, value: string): void {this.values.set(key, value);}
  remove(key: string): void {this.values.delete(key);}
}
export class MemorySecureStore implements SecureStore {
  private readonly values = new Map<string, string>();
  async get(key: string) {return this.values.get(key) ?? null;}
  async set(key: string, value: string) {this.values.set(key, value);}
  async remove(key: string) {this.values.delete(key);}
}
export class MemoryKeyStore implements KeyStore {
  private keys: {signing: CryptoKeyPair; encryption: CryptoKeyPair} | null = null;
  async load() {return this.keys;}
  async save(keys: {signing: CryptoKeyPair; encryption: CryptoKeyPair}) {this.keys = keys;}
  async clear() {this.keys = null;}
}

/** A PlainStore that never throws: private browsing and blocked storage fall back to memory. */
export function safePlainStore(storage: () => Storage | undefined): PlainStore {
  const fallback = new MemoryStore();
  const run = <T>(work: (s: Storage) => T, otherwise: () => T): T => {
    try {const s = storage(); return s ? work(s) : otherwise();} catch {return otherwise();}
  };
  return {
    get: key => run(s => s.getItem(key), () => fallback.get(key)),
    set: (key, value) => run(s => s.setItem(key, value), () => fallback.set(key, value)),
    remove: key => run(s => s.removeItem(key), () => fallback.remove(key)),
  };
}

const DB = 'multai-companion';
/** IndexedDB key storage for browsers and the Android WebView. */
export function indexedDbKeyStore(name = 'controller-keys'): KeyStore {
  const open = () => new Promise<IDBDatabase>((resolve, reject) => {
    const request = indexedDB.open(DB, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('keys');
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('Key storage is unavailable.'));
  });
  const run = async <T>(mode: IDBTransactionMode, work: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> => {
    const db = await open();
    try {
      return await new Promise<T>((resolve, reject) => {
        const tx = db.transaction('keys', mode);
        const request = work(tx.objectStore('keys'));
        tx.oncomplete = () => resolve(request.result);
        tx.onerror = () => reject(tx.error ?? new Error('Key storage failed.'));
        tx.onabort = () => reject(tx.error ?? new Error('Key storage failed.'));
      });
    } finally {db.close();}
  };
  return {
    load: async () => (await run('readonly', store => store.get(name)) as {signing: CryptoKeyPair; encryption: CryptoKeyPair} | undefined) ?? null,
    save: async keys => {await run('readwrite', store => store.put(keys, name));},
    clear: async () => {await run('readwrite', store => store.delete(name));},
  };
}
