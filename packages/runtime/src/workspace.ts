import {constants} from 'node:fs';
import {lstat, open, readdir, realpath, rename, unlink} from 'node:fs/promises';
import {dirname, isAbsolute, join, relative, sep} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ExecutionJournal} from './journal.js';
import {assertAuthority, fail, fingerprint, sha256, validateDescriptor} from './policy.js';
import type {ActionDescriptor, Authority, JsonValue} from './policy.js';

const MAX_FILE_BYTES = 262_144;
const MAX_LIST = 500;
const deniedNames = new Set(['.git', '.ssh', '.aws', '.azure', '.config', '.codex', '.claude', '.gnupg', '.npmrc', '.pypirc', '.netrc', '.local', 'node_modules', '.venv', '.DS_Store']);
const binaryExtension = /\.(?:png|jpe?g|gif|webp|ico|icns|pdf|zip|gz|xz|bz2|7z|tar|mp[34]|mov|wav|woff2?|ttf|otf|exe|dll|dylib|so|sqlite|db|p12|pfx|key|pem|der)$/iu;
const credentialName = /(?:^\.env(?:\.|$)|^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)|^(?:credentials|secrets?)(?:$|\.(?:json|ya?ml|toml|ini|conf|txt|env)$))/iu;
const credentialContent = /(?:-----BEGIN [A-Z ]*PRIVATE KEY-----|\bsk-[A-Za-z0-9_-]{20,}\b|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\b(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}\b|\bGOCSPX-[A-Za-z0-9_-]{20,}\b)/u;

interface Identity {dev: number; ino: number}
const same = (a: Identity, b: Identity) => a.dev === b.dev && a.ino === b.ino;
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

function parts(path: string, rootAllowed = false): string[] {
  if (rootAllowed && (path === '' || path === '.')) return [];
  if (typeof path !== 'string' || Buffer.byteLength(path) > 4096 || isAbsolute(path) || /[\\\u0000-\u001f\u007f]/u.test(path)) fail('UNSAFE_PATH', 'Use a bounded relative workspace path.');
  const components = path.split('/');
  if (components.some(part => !part || part === '.' || part === '..' || deniedNames.has(part) || credentialName.test(part))) fail('PRIVATE_PATH', 'Credential, private or traversing paths are unavailable.');
  return components;
}

function decode(bytes: Uint8Array): string {
  if (bytes.includes(0)) fail('BINARY_FILE', 'Only bounded UTF-8 text files are supported.');
  let value: string;
  try {
    value = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(bytes);
  } catch {return fail('BINARY_FILE', 'Only bounded UTF-8 text files are supported.');}
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value)) fail('BINARY_FILE', 'Only bounded UTF-8 text files are supported.');
  if (credentialContent.test(value)) fail('CREDENTIAL_CONTENT', 'This file contains a recognized credential format and cannot be shared with inference.');
  return value;
}

export interface WorkspaceEntry {path: string; name: string; type: 'file' | 'directory'}
export interface WorkspaceRead {path: string; text: string; hash: string}
export interface ReviewedWrite {
  descriptor: ActionDescriptor;
  authority: Authority;
  journal: ExecutionJournal;
  signal: AbortSignal;
}

/** A private host-created working copy. This class never opens an original project checkout. */
export class ControlledWorkspace {
  private constructor(readonly root: string, private readonly identity: Identity) {}

  static async open(root: string): Promise<ControlledWorkspace> {
    const selected = await lstat(root);
    if (selected.isSymbolicLink() || !selected.isDirectory()) fail('UNSAFE_WORKSPACE', 'The private workspace must be a real directory.');
    const canonical = await realpath(root);
    if (!same(selected, await lstat(canonical))) fail('UNSAFE_WORKSPACE', 'The workspace changed while opening.');
    return new ControlledWorkspace(canonical, {dev: selected.dev, ino: selected.ino});
  }

  private async resolve(path: string, options: {rootAllowed?: boolean; missingLeaf?: boolean} = {}) {
    const components = parts(path, options.rootAllowed);
    const currentRoot = await lstat(this.root);
    if (currentRoot.isSymbolicLink() || !currentRoot.isDirectory() || !same(currentRoot, this.identity) || await realpath(this.root) !== this.root) fail('WORKSPACE_CHANGED', 'The private workspace changed. Stop and review its location.');
    let selected = this.root;
    for (const [index, component] of components.entries()) {
      selected = join(selected, component);
      let stat;
      try {stat = await lstat(selected);} catch (error) {
        if (options.missingLeaf && index === components.length - 1 && missing(error)) return selected;
        throw error;
      }
      if (stat.isSymbolicLink() || stat.dev !== this.identity.dev || (!stat.isFile() && !stat.isDirectory()) || (stat.isFile() && stat.nlink !== 1)) fail('UNSAFE_PATH', 'Links, special files and mounted paths are unavailable.');
      if (index < components.length - 1 && !stat.isDirectory()) fail('UNSAFE_PATH', 'A workspace path parent is not a directory.');
      const resolved = await realpath(selected);
      const within = relative(this.root, resolved);
      if (within === '..' || within.startsWith(`..${sep}`) || isAbsolute(within)) fail('UNSAFE_PATH', 'The selected path escapes this workspace.');
    }
    return selected;
  }

  async list(path = ''): Promise<{entries: WorkspaceEntry[]; omitted: {name: string; reason: string}[]; truncated: boolean}> {
    const directory = await this.resolve(path, {rootAllowed: true});
    if (!(await lstat(directory)).isDirectory()) fail('NOT_DIRECTORY', 'Select a workspace directory.');
    const entries: WorkspaceEntry[] = [];
    const omitted: {name: string; reason: string}[] = [];
    const children = await readdir(directory, {withFileTypes: true});
    let truncated = false;
    for (const child of children.sort((a, b) => a.name.localeCompare(b.name))) {
      if (entries.length + omitted.length >= MAX_LIST) {truncated = true; break;}
      const childPath = path === '' || path === '.' ? child.name : `${path}/${child.name}`;
      try {
        await this.resolve(childPath);
        if (binaryExtension.test(child.name)) {omitted.push({name: child.name, reason: 'Unsupported binary or credential type'}); continue;}
        entries.push({path: childPath, name: child.name, type: child.isDirectory() ? 'directory' : 'file'});
      } catch {omitted.push({name: child.name.slice(0, 120), reason: 'Private, linked, unavailable or unsafe path'});}
    }
    return {entries, omitted, truncated};
  }

  async read(path: string): Promise<WorkspaceRead> {
    if (binaryExtension.test(path)) fail('BINARY_FILE', 'Only bounded UTF-8 source files are supported.');
    const selected = await this.resolve(path);
    const handle = await open(selected, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_FILE_BYTES) fail('FILE_LIMIT', 'Select a regular UTF-8 file no larger than 256 KiB.');
      if (!same(stat, await lstat(await this.resolve(path)))) fail('PATH_CHANGED', 'The selected file changed while opening.');
      // Allocate one extra byte so a growing file cannot defeat the pre-read limit.
      const bytes = Buffer.alloc(MAX_FILE_BYTES + 1);
      let count = 0;
      while (count < bytes.length) {
        const chunk = await handle.read(bytes, count, bytes.length - count, count);
        if (chunk.bytesRead === 0) break;
        count += chunk.bytesRead;
      }
      if (count > MAX_FILE_BYTES) fail('FILE_LIMIT', 'The file grew beyond the text limit.');
      const text = decode(bytes.subarray(0, count));
      return {path, text, hash: sha256(text)};
    } finally {await handle.close();}
  }

  async search(query: string, path = ''): Promise<{matches: {path: string; line: number; text: string}[]; truncated: boolean}> {
    if (typeof query !== 'string' || query.length < 1 || Buffer.byteLength(query) > 512 || query.includes('\0')) fail('INVALID_SEARCH', 'Search for bounded literal text.');
    await this.resolve(path, {rootAllowed: true});
    const pending = [path];
    const matches: {path: string; line: number; text: string}[] = [];
    let files = 0;
    let bytes = 0;
    let truncated = false;
    while (pending.length) {
      const directory = pending.shift()!;
      const listing = await this.list(directory);
      truncated ||= listing.truncated;
      for (const entry of listing.entries) {
        if (entry.type === 'directory') {
          if (entry.path.split('/').length < 16 && pending.length < 500) pending.push(entry.path);
          else truncated = true;
          continue;
        }
        if (++files > 2000 || bytes > 8_388_608) return {matches, truncated: true};
        try {
          const file = await this.read(entry.path);
          bytes += Buffer.byteLength(file.text);
          for (const [index, line] of file.text.split('\n').entries()) {
            if (line.includes(query)) matches.push({path: entry.path, line: index + 1, text: line.slice(0, 300)});
            if (matches.length >= 100) return {matches, truncated: true};
          }
        } catch { /* Listing names do not authorize a later unsafe read. */ }
      }
    }
    return {matches, truncated};
  }

  /** Local approval and durable reservation are mandatory, independently of the service gate. */
  async write(path: string, text: string, expectedHash: string | null, approval: ReviewedWrite): Promise<{path: string; hash: string}> {
    if (typeof text !== 'string' || Buffer.byteLength(text) > MAX_FILE_BYTES || binaryExtension.test(path)) fail('FILE_LIMIT', 'Writes must be bounded UTF-8 text.');
    decode(Buffer.from(text));
    const descriptor = validateDescriptor(approval.descriptor);
    const hash = sha256(text);
    if (descriptor.operation.kind !== 'file_write' || descriptor.operation.relativePath !== path || descriptor.operation.contentHash !== hash || descriptor.operation.expectedContentHash !== expectedHash || descriptor.cwd !== this.root) fail('REQUEST_CONFLICT', 'The reviewed action does not match this exact file write.');
    assertAuthority(descriptor, approval.authority, Date.now());
    approval.signal.throwIfAborted();
    const reservation = approval.journal.reserve(descriptor, approval.authority);
    if (reservation.kind === 'completed') return reservation.result as unknown as {path: string; hash: string};
    // Never clear an executing reservation after any failure. It becomes uncertain
    // on invalidation/reopen, preventing an automatic side-effect replay.
    const selected = await this.resolve(path, {missingLeaf: true});
    const parent = dirname(selected);
    const parentIdentity = await lstat(parent);
    const existing = async () => {
      try {return await this.read(path);} catch (error) {if (missing(error)) return null; throw error;}
    };
    const previous = await existing();
    if (previous?.hash !== (expectedHash ?? undefined)) fail('STALE_FILE', 'The file changed since it was reviewed. Read it again before saving.');
    const previousStat = previous ? await lstat(selected) : undefined;
    if (previousStat && (!previousStat.isFile() || previousStat.nlink !== 1)) fail('STALE_FILE', 'The selected file type changed before saving.');
    // Atomic replacement keeps executable/read/write bits, never special bits.
    const mode = previousStat ? previousStat.mode & 0o777 : 0o600;
    const temporary = join(parent, `.multai-write-${randomUUID()}`);
    let created = false;
    try {
      const handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
      created = true;
      try {await handle.chmod(mode); await handle.writeFile(text, 'utf8'); await handle.sync();} finally {await handle.close();}
      approval.signal.throwIfAborted();
      assertAuthority(descriptor, approval.authority, Date.now());
      await this.resolve(path, {missingLeaf: true});
      if (!same(parentIdentity, await lstat(parent)) || (await existing())?.hash !== (expectedHash ?? undefined)) fail('STALE_FILE', 'The path or file changed while saving. Read it again.');
      if (fingerprint(descriptor) !== reservation.ticket.fingerprint) fail('REQUEST_CONFLICT', 'The reviewed action changed before saving.');
      approval.signal.throwIfAborted();
      await rename(temporary, selected);
      created = false;
      const directory = await open(parent, constants.O_RDONLY);
      try {await directory.sync();} finally {await directory.close();}
      const result = {path, hash};
      approval.journal.complete(reservation.ticket, result as JsonValue, approval.authority);
      return result;
    } finally {if (created) await unlink(temporary).catch(() => undefined);}
  }
}
