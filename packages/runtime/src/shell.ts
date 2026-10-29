import {spawn} from 'node:child_process';
import {lstat, realpath} from 'node:fs/promises';
import {ExecutionJournal} from './journal.js';
import {assertAuthority, fail, validateDescriptor} from './policy.js';
import type {ActionDescriptor, Authority, JsonValue} from './policy.js';

export interface ApprovedShellOptions {
  descriptor: ActionDescriptor;
  authority: Authority;
  journal: ExecutionJournal;
  signal: AbortSignal;
  timeoutMs?: number;
  maxOutputBytes?: number;
  /** Exact connected-provider secret values may be redacted in addition to known formats. */
  secrets?: string[];
  onOutput?: (text: string) => void;
}
export interface ShellResult {exitCode: number | null; signal: string | null; output: string; truncated: boolean}

export function redactSecrets(text: string, secrets: string[] = []): string {
  let safe = text;
  for (const secret of secrets) if (secret.length >= 8) safe = safe.split(secret).join('[REDACTED]');
  return safe
    .replace(/\bsk-[A-Za-z0-9_-]{16,}\b/gu, '[REDACTED]')
    .replace(/\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/gu, '[REDACTED]')
    .replace(/\b(?:ghp_|github_pat_)[A-Za-z0-9_]{20,}\b/gu, '[REDACTED]')
    .replace(/\bBearer\s+[A-Za-z0-9._~-]{16,}/giu, 'Bearer [REDACTED]');
}

/**
 * Dispatches only a prepared+approved exact descriptor. There is no implicit shell,
 * profile sourcing, inherited credential environment or automatic command retry.
 * An approved command still has the host OS user's access; this is not an OS sandbox.
 */
export async function executeApprovedShell(options: ApprovedShellOptions): Promise<ShellResult> {
  const descriptor = validateDescriptor(options.descriptor);
  if (descriptor.operation.kind !== 'shell') fail('REQUEST_CONFLICT', 'The reviewed action is not a shell command.');
  if (process.platform === 'win32') fail('UNSUPPORTED_PLATFORM', 'Reviewed process-tree cancellation is currently supported on macOS and Linux only.');
  const timeout = options.timeoutMs ?? 60_000;
  const maximum = options.maxOutputBytes ?? 65_536;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 120_000 || !Number.isSafeInteger(maximum) || maximum < 1 || maximum > 131_072) fail('INVALID_LIMIT', 'Shell output and deadline limits are invalid.');
  assertAuthority(descriptor, options.authority, Date.now());
  options.signal.throwIfAborted();
  if (await realpath(descriptor.cwd) !== descriptor.cwd || !(await lstat(descriptor.cwd)).isDirectory()) fail('UNSAFE_PATH', 'The reviewed working directory changed.');
  if (await realpath(descriptor.operation.executable) !== descriptor.operation.executable || !(await lstat(descriptor.operation.executable)).isFile()) fail('UNSAFE_EXECUTABLE', 'Use the exact canonical executable path in the reviewed descriptor.');
  const reservation = options.journal.reserve(descriptor, options.authority);
  if (reservation.kind === 'completed') return reservation.result as unknown as ShellResult;
  const operation = descriptor.operation;
  // commandText is a review annotation and MUST be carried in the actual argv.
  // This prevents displaying one command while passing different bytes to a shell.
  if (operation.commandText !== null && !operation.argv.includes(operation.commandText)) fail('REQUEST_CONFLICT', 'Reviewed command text must appear exactly in the executable arguments.');
  options.signal.throwIfAborted();
  let raw = Buffer.alloc(0);
  let truncated = false;
  let stopping = false;
  let stoppedBy: 'abort' | 'timeout' | null = null;
  const child = spawn(operation.executable, [...operation.argv], {
    cwd: descriptor.cwd,
    env: {PATH: '/usr/bin:/bin:/usr/sbin:/sbin', LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8'},
    shell: false,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const killTree = (signal: NodeJS.Signals) => {
    if (!child.pid) return;
    try {process.kill(-child.pid, signal);} catch (error) {if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;}
  };
  let forceKill: NodeJS.Timeout | undefined;
  const stop = (reason: 'abort' | 'timeout') => {
    if (stopping) return;
    stopping = true;
    stoppedBy = reason;
    killTree('SIGTERM');
    forceKill = setTimeout(() => killTree('SIGKILL'), 500);
    forceKill.unref();
  };
  const abort = () => stop('abort');
  const timer = setTimeout(() => stop('timeout'), timeout);
  options.signal.addEventListener('abort', abort, {once: true});
  if (options.signal.aborted) abort();
  const append = (data: Buffer) => {
    const remaining = maximum + 16_384 - raw.length;
    if (raw.length + data.length > maximum) truncated = true;
    if (remaining > 0) raw = Buffer.concat([raw, data.subarray(0, remaining)]);
    // Do not stream raw chunks: a secret may be split across chunk boundaries.
    // The bounded final result is emitted after full redaction below.
  };
  child.stdout.on('data', append);
  child.stderr.on('data', append);
  let exitCode: number | null;
  let exitSignal: NodeJS.Signals | null;
  try {
    [exitCode, exitSignal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
      child.once('error', () => reject(new Error('The reviewed process could not be started.')));
      child.once('close', (code, signal) => resolve([code, signal]));
    });
  } finally {
    clearTimeout(timer);
    if (forceKill) clearTimeout(forceKill);
    options.signal.removeEventListener('abort', abort);
    // A finished leader may have background descendants. Kill its remaining
    // process group before returning control to the agent.
    killTree('SIGKILL');
  }
  const output = Buffer.from(redactSecrets(raw.toString('utf8'), options.secrets)).subarray(0, maximum).toString('utf8');
  if (stoppedBy !== null || options.signal.aborted) {
    options.journal.invalidateSession(descriptor.sessionId);
    if (stoppedBy === 'timeout') fail('COMMAND_TIMEOUT', 'The command exceeded its deadline; its outcome is uncertain and will not be retried.');
    options.signal.throwIfAborted();
    fail('COMMAND_CANCELED', 'The command was canceled; its outcome is uncertain and will not be retried.');
  }
  const result: ShellResult = {exitCode, signal: exitSignal, output, truncated};
  options.journal.complete(reservation.ticket, result as unknown as JsonValue, options.authority);
  options.onOutput?.(output);
  return result;
}
