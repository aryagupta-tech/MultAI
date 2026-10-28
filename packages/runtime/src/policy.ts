import {createHash} from 'node:crypto';
import {isAbsolute, normalize} from 'node:path';

export type JsonValue = null | boolean | number | string | JsonValue[] | {[key: string]: JsonValue};

export class RuntimeError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = 'RuntimeError';
  }
}

export type Operation =
  | {kind: 'shell'; executable: string; argv: string[]; commandText: string | null}
  | {kind: 'external'; tool: string; transport: 'stdio' | 'https'; arguments: JsonValue}
  | {kind: 'file_write'; relativePath: string; expectedContentHash: string | null; contentHash: string};

/** Cwd must already have been canonicalized and revalidated by the native host. */
export interface ActionDescriptor {
  version: 1;
  requestId: string;
  sessionId: string;
  originalOwnerId: string;
  originalDeviceId: string;
  accountGeneration: number;
  sessionGeneration: number;
  runtimeGeneration: number;
  connectionId: string;
  payerId: string;
  resourceIdentity: string;
  cwd: string;
  expiresAt: number;
  operation: Operation;
}

/** Supplied by the trusted host, never from a renderer/participant payload. */
export interface Authority {
  actorId: string;
  actorDeviceId: string;
  role: 'owner' | 'collaborator' | 'viewer';
  sessionId: string;
  originalOwnerId: string;
  originalDeviceId: string;
  accountGeneration: number;
  sessionGeneration: number;
  runtimeGeneration: number;
  connectionId: string;
  payerId: string;
  mode: 'plan' | 'build';
  connected: boolean;
}

export function fail(code: string, message: string): never {
  throw new RuntimeError(code, message);
}

function text(value: unknown, label: string, maximum = 512): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value) > maximum || /[\u0000-\u001f\u007f]/u.test(value)) {
    fail('INVALID_DESCRIPTOR', `${label} must be bounded nonempty text without control characters`);
  }
}

function exactKeys(value: object, expected: string[]): void {
  if (Object.keys(value).sort().join(',') !== expected.sort().join(',')) {
    fail('INVALID_DESCRIPTOR', 'An action contains missing or unrecognized fields');
  }
}

export function canonicalJson(value: unknown): string {
  let nodes = 0;
  function visit(item: unknown, depth: number): string {
    if (++nodes > 20_000 || depth > 32) fail('INVALID_JSON', 'JSON exceeds structural limits');
    if (item === null || typeof item === 'boolean' || typeof item === 'string') return JSON.stringify(item);
    if (typeof item === 'number' && Number.isFinite(item)) return JSON.stringify(item);
    if (Array.isArray(item)) {
      if (item.length > 10_000) fail('INVALID_JSON', 'JSON array exceeds limits');
      return `[${item.map(child => visit(child, depth + 1)).join(',')}]`;
    }
    if (typeof item === 'object' && item !== null && Object.getPrototypeOf(item) === Object.prototype) {
      return `{${Object.keys(item).sort().map(key => `${JSON.stringify(key)}:${visit((item as Record<string, unknown>)[key], depth + 1)}`).join(',')}}`;
    }
    return fail('INVALID_JSON', 'Only finite plain JSON values are supported');
  }
  const encoded = visit(value, 0);
  if (Buffer.byteLength(encoded) > 131_072) fail('PAYLOAD_TOO_LARGE', 'JSON exceeds 128 KiB');
  return encoded;
}

export function sha256(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** Returns an independent copy so later caller mutation cannot change the stored action. */
export function validateDescriptor(input: ActionDescriptor): ActionDescriptor {
  const value = JSON.parse(canonicalJson(input)) as ActionDescriptor;
  if (typeof value !== 'object' || value === null || Array.isArray(value)) fail('INVALID_DESCRIPTOR', 'An action descriptor must be an object');
  exactKeys(value, ['version', 'requestId', 'sessionId', 'originalOwnerId', 'originalDeviceId', 'accountGeneration', 'sessionGeneration', 'runtimeGeneration', 'connectionId', 'payerId', 'resourceIdentity', 'cwd', 'expiresAt', 'operation']);
  if (value.version !== 1) fail('INVALID_DESCRIPTOR', 'Unsupported descriptor version');
  for (const key of ['requestId', 'sessionId', 'originalOwnerId', 'originalDeviceId', 'connectionId', 'payerId', 'resourceIdentity'] as const) text(value[key], key);
  for (const key of ['accountGeneration', 'sessionGeneration', 'runtimeGeneration'] as const) {
    if (!Number.isSafeInteger(value[key]) || value[key] < 1) fail('INVALID_DESCRIPTOR', 'Generations must be positive safe integers');
  }
  if (!Number.isSafeInteger(value.expiresAt) || value.expiresAt < 1) fail('INVALID_DESCRIPTOR', 'Expiry must be an epoch millisecond timestamp');
  text(value.cwd, 'cwd', 4096);
  if (!isAbsolute(value.cwd) || normalize(value.cwd) !== value.cwd) fail('INVALID_DESCRIPTOR', 'Cwd must be an absolute normalized canonical host path');
  if (typeof value.operation !== 'object' || value.operation === null) fail('INVALID_DESCRIPTOR', 'An operation is required');
  const operation = value.operation;
  if (operation.kind === 'shell') {
    exactKeys(operation, ['kind', 'executable', 'argv', 'commandText']);
    text(operation.executable, 'executable', 4096);
    if (!isAbsolute(operation.executable) || normalize(operation.executable) !== operation.executable) fail('INVALID_DESCRIPTOR', 'Executable must be an exact absolute host path');
    if (!Array.isArray(operation.argv) || operation.argv.length > 256 || operation.argv.some(arg => typeof arg !== 'string' || Buffer.byteLength(arg) > 16_384 || arg.includes('\0'))) fail('INVALID_DESCRIPTOR', 'Invalid executable arguments');
    if (operation.commandText !== null && (typeof operation.commandText !== 'string' || Buffer.byteLength(operation.commandText) > 32_768 || operation.commandText.includes('\0'))) fail('INVALID_DESCRIPTOR', 'Invalid shell command text');
  } else if (operation.kind === 'external') {
    exactKeys(operation, ['kind', 'tool', 'transport', 'arguments']);
    text(operation.tool, 'tool');
    if (operation.transport !== 'stdio' && operation.transport !== 'https') fail('INVALID_DESCRIPTOR', 'Unsupported external transport');
    canonicalJson(operation.arguments);
  } else if (operation.kind === 'file_write') {
    exactKeys(operation, ['kind', 'relativePath', 'expectedContentHash', 'contentHash']);
    text(operation.relativePath, 'relativePath', 4096);
    if (isAbsolute(operation.relativePath) || operation.relativePath.includes('\\') || operation.relativePath.split('/').some(part => part === '' || part === '.' || part === '..')) fail('INVALID_DESCRIPTOR', 'File path must be a bounded relative path');
    if (!/^[a-f0-9]{64}$/u.test(operation.contentHash) || (operation.expectedContentHash !== null && !/^[a-f0-9]{64}$/u.test(operation.expectedContentHash))) fail('INVALID_DESCRIPTOR', 'File content hashes must be SHA-256');
  } else {
    fail('INVALID_DESCRIPTOR', 'Unsupported operation');
  }
  return value;
}

export function fingerprint(descriptor: ActionDescriptor): string {
  return sha256(canonicalJson(validateDescriptor(descriptor)));
}

export function assertAuthority(descriptor: ActionDescriptor, authority: Authority, now: number, checkExpiry = true): void {
  if (authority.role !== 'owner' || authority.actorId !== descriptor.originalOwnerId || authority.actorDeviceId !== descriptor.originalDeviceId) fail('HOST_APPROVAL_REQUIRED', 'Only the original owner on the original device has action authority');
  for (const key of ['sessionId', 'originalOwnerId', 'originalDeviceId', 'accountGeneration', 'sessionGeneration', 'runtimeGeneration', 'connectionId', 'payerId'] as const) {
    if (authority[key] !== descriptor[key]) fail('STALE_AUTHORITY', 'Session, account, device, runtime or inference connection changed');
  }
  if (!authority.connected) fail('HOST_UNAVAILABLE', 'Fresh connected authority is required');
  if (authority.mode !== 'build') fail('PLAN_MODE', 'Plan mode blocks file writes, shell commands and external actions');
  if (checkExpiry && descriptor.expiresAt <= now) fail('APPROVAL_EXPIRED', 'Action approval expired');
}
