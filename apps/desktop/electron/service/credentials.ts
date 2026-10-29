import { app, safeStorage } from 'electron';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

// Credentials are scoped to the service origin and encrypted with the OS keychain via
// safeStorage. If encryption is unavailable they are kept in memory only, never in plaintext.

export interface ActiveCredentials {
  userId: string;
  accessToken: string;
  accessExpiresAt: number;
  refreshToken: string;
}

export interface DeviceProof {
  deviceId: string;
  deviceSecret: string;
}

export interface CredentialRecord {
  active: ActiveCredentials | null;
  /** Per-account device proofs, kept across sign-out so this computer keeps its host identity. */
  devices: Record<string, DeviceProof>;
  lastUserId: string | null;
}

const empty = (): CredentialRecord => ({ active: null, devices: {}, lastUserId: null });

export class CredentialStore {
  private readonly file: string;
  private memory: CredentialRecord = empty();
  private loaded = false;

  constructor(serviceOrigin: string) {
    const scope = new URL(serviceOrigin).host.replace(/[^a-zA-Z0-9.-]/g, '_');
    this.file = path.join(app.getPath('userData'), 'credentials', `${scope}.bin`);
  }

  get encrypted(): boolean {
    return safeStorage.isEncryptionAvailable();
  }

  async load(): Promise<CredentialRecord> {
    if (this.loaded) return this.memory;
    this.loaded = true;
    if (!this.encrypted) return this.memory;
    try {
      const bytes = await readFile(this.file);
      const parsed = JSON.parse(safeStorage.decryptString(bytes)) as Partial<CredentialRecord>;
      this.memory = { ...empty(), ...parsed };
    } catch {
      this.memory = empty();
    }
    return this.memory;
  }

  async save(next: CredentialRecord): Promise<void> {
    this.memory = next;
    if (!this.encrypted) return;
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 });
    // Write-then-rename so a crash can't leave a half-written refresh token behind.
    const temp = `${this.file}.${process.pid}.tmp`;
    await writeFile(temp, safeStorage.encryptString(JSON.stringify(next)), { mode: 0o600 });
    await rename(temp, this.file);
  }

  async clearActive(): Promise<void> {
    const record = await this.load();
    await this.save({ ...record, active: null });
  }

  async wipe(): Promise<void> {
    this.memory = empty();
    await rm(this.file, { force: true });
  }
}
