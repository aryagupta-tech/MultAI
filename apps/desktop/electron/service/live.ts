import WebSocket, {type ClientOptions} from 'ws';
import {z} from 'zod';
import type {LiveBatch, LiveStatusChange, ServiceError} from '../../src/bridge/contract';
import type {WireEvent} from '../../src/bridge/wire';
import type {Account} from './account';

const eventSchema = z.object({id: z.uuid(), sessionId: z.uuid(), sequence: z.number().int().min(1).max(100000), type: z.string().max(100), actorId: z.uuid().nullable(), payload: z.unknown(), createdAt: z.string()});
const frameSchema = z.object({type: z.literal('event'), event: eventSchema});
const TERMINAL = new Set(['membership_required', 'membership_revoked', 'session_not_found', 'session_deleted', 'not_found', 'forbidden']);
const MAX_BUFFER_BYTES = 1_048_576;
const MAX_BACKOFF_MS = 30_000;
const FLUSH_MS = 16;

interface Subscription {
  sessionId: string;
  generation: number;
  /** Last sequence synchronously delivered to the trusted main-process emitter. */
  cursor: number;
  receivedCursor: number;
  socket: WebSocket | null;
  attempts: number;
  timer: NodeJS.Timeout | null;
  closed: boolean;
  buffer: WireEvent[];
  bufferBytes: number;
  flush: NodeJS.Timeout | null;
}
export interface LiveHubOptions {
  socketFactory?: (url: URL, options: ClientOptions) => WebSocket;
  random?: () => number;
}

/** Native read-only replay. Missing sequences force replay from the last delivered cursor. */
export class LiveHub {
  private readonly subs = new Map<string, Subscription>();
  private readonly socketFactory: (url: URL, options: ClientOptions) => WebSocket;
  private readonly random: () => number;

  constructor(
    private readonly account: Pick<Account, 'origin' | 'accountGeneration' | 'authorizationHeader' | 'forceRefreshOnNextUse'>,
    private readonly emitEvents: (batch: LiveBatch) => void,
    private readonly emitStatus: (change: LiveStatusChange) => void,
    options: LiveHubOptions = {},
  ) {
    this.socketFactory = options.socketFactory ?? ((url, socketOptions) => new WebSocket(url, socketOptions));
    this.random = options.random ?? Math.random;
  }

  subscribe(sessionId: string, after: number): void {
    z.uuid().parse(sessionId);
    z.number().int().min(0).max(100000).parse(after);
    const existing = this.subs.get(sessionId);
    if (existing && !existing.closed && existing.generation === this.account.accountGeneration) {
      existing.cursor = Math.max(existing.cursor, after);
      existing.receivedCursor = Math.max(existing.receivedCursor, after);
      existing.buffer = existing.buffer.filter(event => event.sequence > existing.cursor);
      existing.bufferBytes = Buffer.byteLength(JSON.stringify(existing.buffer));
      return;
    }
    if (existing) this.unsubscribe(sessionId);
    const sub: Subscription = {sessionId, generation: this.account.accountGeneration, cursor: after, receivedCursor: after, socket: null, attempts: 0, timer: null, closed: false, buffer: [], bufferBytes: 0, flush: null};
    this.subs.set(sessionId, sub);
    void this.connect(sub);
  }

  unsubscribe(sessionId: string): void {
    const sub = this.subs.get(sessionId);
    if (!sub) return;
    sub.closed = true;
    if (sub.timer) clearTimeout(sub.timer);
    this.discardBuffered(sub);
    sub.socket?.terminate();
    sub.socket = null;
    this.subs.delete(sessionId);
  }
  closeAll(): void { for (const id of [...this.subs.keys()]) this.unsubscribe(id); }

  private current(sub: Subscription): boolean {
    if (sub.closed) return false;
    if (sub.generation !== this.account.accountGeneration) { this.end(sub, 'account_changed'); return false; }
    return true;
  }

  private discardBuffered(sub: Subscription): void {
    if (sub.flush) clearTimeout(sub.flush);
    sub.flush = null;
    sub.buffer = [];
    sub.bufferBytes = 0;
    sub.receivedCursor = sub.cursor;
  }

  private flush(sub: Subscription): void {
    if (sub.flush) clearTimeout(sub.flush);
    sub.flush = null;
    if (!this.current(sub) || !sub.buffer.length) return;
    const events = sub.buffer.slice();
    try {
      this.emitEvents({sessionId: sub.sessionId, events});
      sub.cursor = events.at(-1)!.sequence;
      sub.buffer.splice(0, events.length);
      sub.bufferBytes = 0;
    } catch {
      // No acknowledgement was delivered: do not advance the replay cursor.
      this.end(sub, 'renderer_unavailable');
    }
  }

  private async connect(sub: Subscription): Promise<void> {
    if (!this.current(sub)) return;
    this.emitStatus({sessionId: sub.sessionId, status: sub.attempts === 0 ? 'connecting' : 'reconnecting'});
    let authorization: string;
    try { authorization = await this.account.authorizationHeader(); }
    catch (error) {
      const failure = (error as {error?: ServiceError})?.error;
      if (failure?.status === 401 || ['signed_out', 'session_expired', 'stale', 'secure_storage_unavailable'].includes(failure?.code ?? '')) return this.end(sub, failure?.code ?? 'signed_out');
      this.retry(sub);
      return;
    }
    if (!this.current(sub)) return;
    const url = new URL(`/v1/sessions/${sub.sessionId}/live`, this.account.origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('after', String(sub.cursor));
    const socket = this.socketFactory(url, {headers: {authorization}, handshakeTimeout: 10_000, maxPayload: 256 * 1024});
    sub.socket = socket;
    socket.on('open', () => {
      if (!this.current(sub)) return;
      sub.attempts = 0;
      this.emitStatus({sessionId: sub.sessionId, status: 'live'});
    });
    socket.on('message', data => {
      if (!this.current(sub) || sub.socket !== socket) return;
      let frame: z.infer<typeof frameSchema>;
      try {
        const bytes = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
        frame = frameSchema.parse(JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes)));
      }
      catch { this.end(sub, 'invalid_stream'); return; }
      if (frame.event.sessionId !== sub.sessionId) { this.end(sub, 'invalid_stream'); return; }
      if (frame.event.sequence <= sub.receivedCursor) return;
      if (frame.event.sequence !== sub.receivedCursor + 1) {
        sub.socket = null;
        socket.terminate();
        this.discardBuffered(sub);
        this.retry(sub);
        return;
      }
      const bytes = Buffer.byteLength(JSON.stringify(frame.event));
      if (sub.bufferBytes + bytes > MAX_BUFFER_BYTES) this.flush(sub);
      if (!this.current(sub)) return;
      sub.buffer.push(frame.event);
      sub.bufferBytes += bytes;
      sub.receivedCursor = frame.event.sequence;
      sub.flush ??= setTimeout(() => this.flush(sub), FLUSH_MS);
    });
    socket.on('unexpected-response', (_request, response) => {
      if (!this.current(sub) || sub.socket !== socket) return;
      sub.socket = null;
      socket.terminate();
      this.discardBuffered(sub);
      const status = response.statusCode ?? 0;
      if (status === 403 || status === 404 || status === 410) return this.end(sub, status === 410 ? 'session_deleted' : status === 404 ? 'session_not_found' : 'membership_revoked');
      if (status === 401) this.account.forceRefreshOnNextUse();
      this.retry(sub);
    });
    socket.on('close', (code, reasonBuffer) => {
      if (!this.current(sub) || sub.socket !== socket) return;
      sub.socket = null;
      this.discardBuffered(sub);
      const reason = reasonBuffer.toString();
      if (code === 1008 && TERMINAL.has(reason)) return this.end(sub, reason);
      if (code === 1008 && ['invalid_credentials', 'unauthorized'].includes(reason)) this.account.forceRefreshOnNextUse();
      if (code === 1013) sub.attempts = 0;
      this.retry(sub);
    });
    socket.on('error', () => { /* Close/HTTP rejection owns the single reconnect. */ });
  }

  private retry(sub: Subscription): void {
    if (!this.current(sub) || sub.timer) return;
    const delay = sub.attempts === 0 ? 250 : Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (sub.attempts - 1)) * (0.75 + this.random() * 0.5);
    sub.attempts++;
    this.emitStatus({sessionId: sub.sessionId, status: 'reconnecting'});
    sub.timer = setTimeout(() => {sub.timer = null; void this.connect(sub);}, delay);
  }

  private end(sub: Subscription, reason: string): void {
    if (sub.closed) return;
    this.unsubscribe(sub.sessionId);
    this.emitStatus({sessionId: sub.sessionId, status: 'ended', reason});
  }
}
