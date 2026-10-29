import WebSocket from 'ws';
import { z } from 'zod';
import type { LiveBatch, LiveStatusChange } from '../../src/bridge/contract';
import type { WireEvent } from '../../src/bridge/wire';
import type { Account } from './account';

const eventSchema = z.object({
  id: z.uuid(),
  sessionId: z.uuid(),
  sequence: z.number().int().positive(),
  type: z.string().max(100),
  actorId: z.uuid().nullable(),
  payload: z.unknown(),
  createdAt: z.string(),
});
const frameSchema = z.object({ type: z.literal('event'), event: eventSchema });

/** Close reasons after which reconnecting cannot succeed. */
const TERMINAL = new Set(['membership_revoked', 'session_not_found', 'session_deleted', 'not_found', 'forbidden']);
const MAX_BACKOFF_MS = 30_000;
const FLUSH_MS = 16;

interface Subscription {
  sessionId: string;
  cursor: number;
  socket: WebSocket | null;
  attempts: number;
  timer: NodeJS.Timeout | null;
  closed: boolean;
  buffer: WireEvent[];
  flush: NodeJS.Timeout | null;
}

/**
 * Keeps one read-only live stream per open session. Events are forwarded in sequence order,
 * deduplicated by sequence, and the stream resumes from the last delivered cursor.
 */
export class LiveHub {
  private readonly subs = new Map<string, Subscription>();

  constructor(
    private readonly account: Account,
    private readonly emitEvents: (batch: LiveBatch) => void,
    private readonly emitStatus: (change: LiveStatusChange) => void,
  ) {}

  subscribe(sessionId: string, after: number): void {
    const existing = this.subs.get(sessionId);
    if (existing && !existing.closed) {
      existing.cursor = Math.max(existing.cursor, after);
      return;
    }
    const sub: Subscription = { sessionId, cursor: after, socket: null, attempts: 0, timer: null, closed: false, buffer: [], flush: null };
    this.subs.set(sessionId, sub);
    void this.connect(sub);
  }

  unsubscribe(sessionId: string): void {
    const sub = this.subs.get(sessionId);
    if (!sub) return;
    sub.closed = true;
    if (sub.timer) clearTimeout(sub.timer);
    if (sub.flush) clearTimeout(sub.flush);
    sub.socket?.close(1000);
    this.subs.delete(sessionId);
  }

  closeAll(): void {
    for (const id of [...this.subs.keys()]) this.unsubscribe(id);
  }

  private async connect(sub: Subscription): Promise<void> {
    if (sub.closed) return;
    this.emitStatus({ sessionId: sub.sessionId, status: sub.attempts === 0 ? 'connecting' : 'reconnecting' });
    let authorization: string;
    try {
      authorization = await this.account.authorizationHeader();
    } catch {
      this.retry(sub);
      return;
    }
    if (sub.closed) return;
    const url = new URL(`/v1/sessions/${sub.sessionId}/live`, this.account.origin);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    url.searchParams.set('after', String(sub.cursor));
    // `ws` sends no Origin header, which the service requires for native clients.
    const socket = new WebSocket(url, { headers: { authorization }, handshakeTimeout: 10_000, maxPayload: 256 * 1024 });
    sub.socket = socket;

    socket.on('open', () => {
      sub.attempts = 0;
      this.emitStatus({ sessionId: sub.sessionId, status: 'live' });
    });
    socket.on('message', (data) => {
      let frame: z.infer<typeof frameSchema>;
      try {
        frame = frameSchema.parse(JSON.parse(data.toString()));
      } catch {
        return; // Ignore frames we don't understand rather than corrupting the timeline.
      }
      if (frame.event.sessionId !== sub.sessionId || frame.event.sequence <= sub.cursor) return;
      sub.cursor = frame.event.sequence;
      sub.buffer.push(frame.event);
      // Coalesce bursts (replay pages arrive 100 at a time) into one renderer update.
      sub.flush ??= setTimeout(() => {
        sub.flush = null;
        const events = sub.buffer.splice(0);
        if (events.length && !sub.closed) this.emitEvents({ sessionId: sub.sessionId, events });
      }, FLUSH_MS);
    });
    socket.on('unexpected-response', (_req, res) => {
      // Handshake rejected over HTTP (e.g. 401/403/404/410).
      const status = res.statusCode ?? 0;
      socket.terminate();
      if (status === 401) {
        this.account.forceRefreshOnNextUse();
        this.retry(sub);
      } else if (status === 403 || status === 404 || status === 410) {
        this.end(sub, status === 410 ? 'session_deleted' : status === 404 ? 'session_not_found' : 'membership_revoked');
      } else {
        this.retry(sub);
      }
    });
    socket.on('close', (code, reasonBuffer) => {
      if (sub.socket !== socket || sub.closed) return;
      sub.socket = null;
      const reason = reasonBuffer.toString();
      if (code === 1008 && TERMINAL.has(reason)) return this.end(sub, reason);
      if (code === 1008 && (reason === 'invalid_credentials' || reason === 'unauthorized')) this.account.forceRefreshOnNextUse();
      // 1013 asks us to reconnect from our cursor straight away.
      if (code === 1013) sub.attempts = 0;
      this.retry(sub);
    });
    socket.on('error', () => { /* 'close' follows and handles reconnection. */ });
  }

  private retry(sub: Subscription): void {
    if (sub.closed) return;
    const delay = sub.attempts === 0 ? 250 : Math.min(MAX_BACKOFF_MS, 1000 * 2 ** (sub.attempts - 1)) * (0.75 + Math.random() * 0.5);
    sub.attempts++;
    this.emitStatus({ sessionId: sub.sessionId, status: 'reconnecting' });
    sub.timer = setTimeout(() => {
      sub.timer = null;
      void this.connect(sub);
    }, delay);
  }

  private end(sub: Subscription, reason: string): void {
    sub.closed = true;
    this.subs.delete(sub.sessionId);
    this.emitStatus({ sessionId: sub.sessionId, status: 'ended', reason });
  }
}
