import {app, safeStorage} from 'electron';
import {createHash, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {mkdir, open, rename, rm} from 'node:fs/promises';
import path from 'node:path';
import {ConnectionError} from './network';

export interface Encryption {
  available(): boolean;
  encrypt(value: string): Buffer;
  decrypt(value: Buffer): string;
}
const nativeEncryption: Encryption = {
  available: () => safeStorage.isEncryptionAvailable() && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
  encrypt: value => safeStorage.encryptString(value),
  decrypt: value => safeStorage.decryptString(value),
};

/** One encrypted, account/service/device-bound record. Never falls back to plaintext. */
export class SecureConnectionStore<T> {
  readonly filename: string;
  private tail: Promise<void> = Promise.resolve();
  constructor(private readonly scope: string, private readonly initial: () => T, private readonly encryption: Encryption = nativeEncryption, root = app.getPath('userData')) {
    this.filename = path.join(root, 'inference', `${createHash('sha256').update(scope).digest('hex')}.bin`);
  }
  private checkEncryption(): void {
    if (!this.encryption.available()) throw new ConnectionError('secure_storage_unavailable', 'Unlock the operating system credential store before connecting AI. Plaintext credential storage is disabled.');
  }
  async load(): Promise<T> {
    await this.tail;
    this.checkEncryption();
    let file;
    try {
      file = await open(this.filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > 1_048_576) throw new Error('Invalid secure record');
      const envelope = JSON.parse(this.encryption.decrypt(await file.readFile())) as {scope?: string; value?: T};
      if (envelope.scope !== this.scope || !Object.hasOwn(envelope, 'value')) throw new Error('Wrong scope');
      return structuredClone(envelope.value as T);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return this.initial();
      throw new ConnectionError('credential_store_invalid', 'The saved AI connection cannot be opened. Restore its operating system credential access or remove the connection record.');
    } finally {await file?.close();}
  }
  save(value: T): Promise<void> {
    const snapshot = structuredClone(value);
    const operation = this.tail.then(async () => {
      this.checkEncryption();
      const plaintext = JSON.stringify({scope: this.scope, value: snapshot});
      if (Buffer.byteLength(plaintext) > 1_048_576) throw new ConnectionError('connection_capacity', 'The saved connection limit was reached.');
      const encrypted = this.encryption.encrypt(plaintext);
      await mkdir(path.dirname(this.filename), {recursive: true, mode: 0o700});
      const temporary = `${this.filename}.${randomUUID()}.tmp`;
      let file;
      try {
        file = await open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | (constants.O_NOFOLLOW ?? 0), 0o600);
        await file.writeFile(encrypted);
        await file.sync();
        await file.close(); file = undefined;
        await rename(temporary, this.filename);
      } finally {
        await file?.close();
        await rm(temporary, {force: true});
      }
    });
    this.tail = operation.catch(() => undefined);
    return operation;
  }
}
