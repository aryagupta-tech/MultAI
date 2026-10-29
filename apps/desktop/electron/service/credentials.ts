import { app, safeStorage } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';

export interface ActiveCredentials {
  userId: string;
  accessToken: string;
  accessExpiresAt: number;
  refreshToken: string;
}
export interface DeviceProof { deviceId: string; deviceSecret: string }
export interface CredentialRecord {
  active: ActiveCredentials | null;
  /** Account-scoped device proofs survive sign-out so original host identity can resume. */
  devices: Record<string, DeviceProof>;
  lastUserId: string | null;
}
export interface CredentialPersistence {
  readonly encrypted: boolean;
  assertAvailable(): void;
  load(): Promise<CredentialRecord>;
  save(next: CredentialRecord): Promise<void>;
  clearActive(): Promise<void>;
}
export interface SecureStorage {
  isEncryptionAvailable(): boolean;
  getSelectedStorageBackend(): string;
  encryptString(value: string): Buffer;
  decryptString(value: Buffer): string;
}
export interface CredentialStoreOptions {
  directory?: string;
  platform?: NodeJS.Platform;
  storage?: SecureStorage;
}
export class CredentialStorageError extends Error {
  constructor(readonly code: 'secure_storage_unavailable' | 'credential_storage_failed') {
    super(code === 'secure_storage_unavailable'
      ? 'Unlock an approved OS keyring before signing in.'
      : 'The encrypted credential record could not be read or saved.');
  }
}

const secret = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const recordSchema = z.object({
  active: z.object({userId: z.uuid(), accessToken: secret, refreshToken: secret, accessExpiresAt: z.number().int().positive()}).strict().nullable(),
  devices: z.record(z.uuid(), z.object({deviceId: z.uuid(), deviceSecret: secret}).strict()).refine(value => Object.keys(value).length <= 100),
  lastUserId: z.uuid().nullable(),
}).strict();
const empty = (): CredentialRecord => ({active: null, devices: {}, lastUserId: null});
const clone = (record: CredentialRecord): CredentialRecord => structuredClone(record);
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

/** OS-encrypted, full-origin-scoped storage. Missing/weak keyrings fail closed. */
export class CredentialStore implements CredentialPersistence {
  private readonly file: string;
  private readonly marker: string;
  private readonly platform: NodeJS.Platform;
  private readonly storage: SecureStorage;
  private memory: CredentialRecord = empty();
  private loaded = false;
  private queue: Promise<void> = Promise.resolve();

  constructor(serviceOrigin: string, options: CredentialStoreOptions = {}) {
    const origin = new URL(serviceOrigin);
    if (origin.origin !== serviceOrigin || !['http:', 'https:'].includes(origin.protocol)) throw new Error('A bare service origin is required.');
    const scope = createHash('sha256').update(origin.origin).digest('hex');
    this.file = path.join(options.directory ?? path.join(app.getPath('userData'), 'credentials'), `${scope}.bin`);
    this.marker = `${this.file}.signed-out`;
    this.platform = options.platform ?? process.platform;
    this.storage = options.storage ?? safeStorage;
  }

  get encrypted(): boolean {
    try {
      if (!this.storage.isEncryptionAvailable()) return false;
      if (this.platform === 'linux') return ['gnome_libsecret', 'kwallet', 'kwallet5', 'kwallet6'].includes(this.storage.getSelectedStorageBackend());
      return true;
    } catch { return false; }
  }

  assertAvailable(): void {
    if (!this.encrypted) throw new CredentialStorageError('secure_storage_unavailable');
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.queue.then(operation, operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private async read(): Promise<CredentialRecord> {
    this.assertAvailable();
    if (this.loaded) return clone(this.memory);
    let bytes: Buffer;
    try { bytes = await readFile(this.file); }
    catch (error) {
      if (!missing(error)) throw new CredentialStorageError('credential_storage_failed');
      this.loaded = true;
      return empty();
    }
    try {
      if (bytes.length > 131_072) throw new Error('Oversized credential record');
      const parsed = recordSchema.parse(JSON.parse(this.storage.decryptString(bytes)));
      // A sign-out marker is nonsecret and can be committed even while a keyring is locked.
      try { await readFile(this.marker); parsed.active = null; }
      catch (error) { if (!missing(error)) throw error; }
      this.memory = parsed;
      this.loaded = true;
      return clone(parsed);
    } catch { throw new CredentialStorageError('credential_storage_failed'); }
  }

  load(): Promise<CredentialRecord> { return this.serialize(() => this.read()); }

  save(next: CredentialRecord): Promise<void> {
    const parsed = recordSchema.parse(next);
    return this.serialize(async () => {
      this.assertAvailable();
      const temp = `${this.file}.${randomUUID()}.tmp`;
      try {
        const encrypted = this.storage.encryptString(JSON.stringify(parsed));
        await mkdir(path.dirname(this.file), {recursive: true, mode: 0o700});
        await writeFile(temp, encrypted, {mode: 0o600, flag: 'wx'});
        await rename(temp, this.file);
        if (parsed.active) await rm(this.marker, {force: true});
        this.memory = clone(parsed);
        this.loaded = true;
      } catch {
        await rm(temp, {force: true}).catch(() => undefined);
        throw new CredentialStorageError('credential_storage_failed');
      }
    });
  }

  clearActive(): Promise<void> {
    return this.serialize(async () => {
      // Preserve all unrelated encrypted device proofs without needing to decrypt them.
      await mkdir(path.dirname(this.file), {recursive: true, mode: 0o700});
      await writeFile(this.marker, 'signed-out\n', {mode: 0o600});
      this.memory = {...this.memory, active: null};
    });
  }

  wipe(): Promise<void> {
    return this.serialize(async () => {
      this.memory = empty();
      this.loaded = true;
      await rm(this.file, {force: true});
      await rm(this.marker, {force: true});
    });
  }
}
