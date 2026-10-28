import {DatabaseSync} from 'node:sqlite';
import {closeSync, constants, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync} from 'node:fs';
import {dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {assertAuthority, canonicalJson, fail, fingerprint, sha256, validateDescriptor} from './policy.js';
import type {ActionDescriptor, Authority, JsonValue} from './policy.js';

export interface JournalScope {serviceOrigin: string; accountId: string; deviceId: string}
export type EffectState = 'prepared' | 'executing' | 'completed' | 'uncertain';
export type ApprovalState = 'pending' | 'approved' | 'rejected' | 'canceled' | 'consumed';
export interface Effect {
  descriptor: ActionDescriptor;
  fingerprint: string;
  state: EffectState;
  approval: ApprovalState;
  result: JsonValue | null;
}
export interface DispatchTicket {requestId: string; fingerprint: string; attemptId: string}
export type Reservation = {kind: 'execute'; ticket: DispatchTicket} | {kind: 'completed'; result: JsonValue};
interface StoredEffect {descriptor: string; fingerprint: string; state: EffectState; approval: ApprovalState; result: string | null; attempt_id: string | null}
export interface OutboundEvent {id: string; payload: JsonValue; createdAt: number}

/** Establish privacy before SQLite can write a header, schema or scope metadata. */
function openPrivateJournalFile(filename: string): number {
  let file: number | undefined;
  try {
    const noFollow = constants.O_NOFOLLOW ?? 0;
    try {
      file = openSync(filename, constants.O_CREAT | constants.O_EXCL | constants.O_RDWR | noFollow, 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      const entry = lstatSync(filename);
      if (!entry.isFile()) fail('UNSAFE_JOURNAL_PATH', 'Journal path must be a regular file, never a symbolic link or directory');
      file = openSync(filename, constants.O_RDWR | noFollow | (constants.O_NONBLOCK ?? 0));
      const opened = fstatSync(file);
      if (entry.dev !== opened.dev || entry.ino !== opened.ino) fail('UNSAFE_JOURNAL_PATH', 'Journal file changed while opening');
    }
    const opened = fstatSync(file);
    if (!opened.isFile()) fail('UNSAFE_JOURNAL_PATH', 'Journal path must be a regular file');
    fchmodSync(file, 0o600);
    return file;
  } catch (error) {
    if (file !== undefined) closeSync(file);
    if ((error as NodeJS.ErrnoException).code === 'ELOOP') fail('UNSAFE_JOURNAL_PATH', 'Journal path must not be a symbolic link');
    throw error;
  }
}

/** Single native host connection. SQLite holds an exclusive lock until close. */
export class ExecutionJournal {
  private readonly db: DatabaseSync;
  private readonly clock: () => number;
  private readonly scope: JournalScope;
  private closed = false;

  constructor(filename: string, scope: JournalScope, clock: () => number = Date.now) {
    if (!scope.accountId || !scope.deviceId || scope.accountId.length > 512 || scope.deviceId.length > 512) fail('INVALID_SCOPE', 'An account and device scope are required');
    let origin: URL;
    try {origin = new URL(scope.serviceOrigin);} catch {fail('INVALID_SCOPE', 'A service origin is required');}
    if (origin.origin !== scope.serviceOrigin || !['https:', 'http:'].includes(origin.protocol)) fail('INVALID_SCOPE', 'Service scope must be a bare HTTP(S) origin');
    if (filename === ':memory:') fail('DURABLE_PATH_REQUIRED', 'Execution journals must be file backed');
    this.scope = Object.freeze({...scope});
    mkdirSync(dirname(filename), {recursive: true, mode: 0o700});
    this.clock = clock;
    const file = openPrivateJournalFile(filename);
    try {this.db = new DatabaseSync(filename);} finally {closeSync(file);}
    try {
      this.db.exec(`
        PRAGMA busy_timeout=0;
        PRAGMA locking_mode=EXCLUSIVE;
        PRAGMA journal_mode=DELETE;
        PRAGMA synchronous=FULL;
        PRAGMA foreign_keys=ON;
        BEGIN EXCLUSIVE;
        CREATE TABLE IF NOT EXISTS journal_metadata (singleton INTEGER PRIMARY KEY CHECK(singleton=1), version INTEGER NOT NULL, scope TEXT NOT NULL);
        CREATE TABLE IF NOT EXISTS effects (
          request_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
          descriptor TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('prepared','executing','completed','uncertain')),
          approval TEXT NOT NULL CHECK(approval IN ('pending','approved','rejected','canceled','consumed')),
          result TEXT, attempt_id TEXT, updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS effects_active_session ON effects(session_id,state);
        CREATE TABLE IF NOT EXISTS outbound_events (
          sequence INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE, fingerprint TEXT NOT NULL, payload TEXT NOT NULL,
          created_at INTEGER NOT NULL, acknowledged_at INTEGER
        );
        COMMIT;
      `);
      const metadata = this.db.prepare('SELECT version,scope FROM journal_metadata WHERE singleton=1').get() as {version: number; scope: string} | undefined;
      const encodedScope = canonicalJson(scope);
      if (metadata && (metadata.version !== 2 || metadata.scope !== encodedScope)) fail('SCOPE_MISMATCH', 'This journal belongs to a different account, service, device or schema version');
      this.db.prepare('INSERT OR IGNORE INTO journal_metadata(singleton,version,scope) VALUES(1,2,?)').run(encodedScope);
      this.atomic(() => {
        this.db.prepare("UPDATE effects SET state='uncertain',updated_at=? WHERE state='executing'").run(this.clock());
        this.db.prepare("UPDATE effects SET approval='canceled',updated_at=? WHERE state='prepared' AND approval IN ('pending','approved')").run(this.clock());
      });
    } catch (error) {
      try {this.db.exec('ROLLBACK');} catch { /* No active transaction. */ }
      this.db.close();
      throw error;
    }
  }

  private atomic<T>(operation: () => T): T {
    if (this.closed) fail('JOURNAL_CLOSED', 'Journal is closed');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = operation();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  private stored(requestId: string): StoredEffect {
    const effect = this.db.prepare('SELECT descriptor,fingerprint,state,approval,result,attempt_id FROM effects WHERE request_id=?').get(requestId) as unknown as StoredEffect | undefined;
    return effect ?? fail('UNKNOWN_REQUEST', 'No prepared action has that request identity');
  }

  private matching(descriptor: ActionDescriptor): StoredEffect {
    const effect = this.stored(descriptor.requestId);
    if (effect.fingerprint !== fingerprint(descriptor)) fail('REQUEST_CONFLICT', 'This request identity is already bound to different action bytes');
    return effect;
  }

  private checkScope(descriptor: ActionDescriptor): void {
    if (descriptor.originalOwnerId !== this.scope.accountId || descriptor.originalDeviceId !== this.scope.deviceId) fail('SCOPE_MISMATCH', 'Action does not belong to this host journal');
  }

  get(requestId: string): Effect {
    if (this.closed) fail('JOURNAL_CLOSED', 'Journal is closed');
    const stored = this.stored(requestId);
    return {
      descriptor: JSON.parse(stored.descriptor) as ActionDescriptor,
      fingerprint: stored.fingerprint,
      state: stored.state,
      approval: stored.approval,
      result: stored.result === null ? null : JSON.parse(stored.result) as JsonValue,
    };
  }

  prepare(input: ActionDescriptor, authority: Authority): Effect {
    const descriptor = validateDescriptor(input);
    this.checkScope(descriptor);
    assertAuthority(descriptor, authority, this.clock());
    return this.atomic(() => {
      const existing = this.db.prepare('SELECT request_id FROM effects WHERE request_id=?').get(descriptor.requestId);
      if (existing) this.matching(descriptor);
      else {
        const count = this.db.prepare('SELECT count(*) AS total FROM effects').get() as {total: number};
        if (count.total >= 10_000) fail('JOURNAL_FULL', 'Journal retention limit reached; explicit reviewed cleanup is required');
        this.db.prepare("INSERT INTO effects(request_id,session_id,fingerprint,descriptor,state,approval,updated_at) VALUES(?,?,?,?,'prepared','pending',?)")
          .run(descriptor.requestId, descriptor.sessionId, fingerprint(descriptor), canonicalJson(descriptor), this.clock());
      }
      return this.get(descriptor.requestId);
    });
  }

  decide(requestId: string, expectedFingerprint: string, authority: Authority, decision: 'approve' | 'reject'): Effect {
    return this.atomic(() => {
      const stored = this.stored(requestId);
      if (stored.fingerprint !== expectedFingerprint) fail('REQUEST_CONFLICT', 'Approval must bind to the reviewed action hash');
      const descriptor = JSON.parse(stored.descriptor) as ActionDescriptor;
      assertAuthority(descriptor, authority, this.clock());
      if (stored.state !== 'prepared' || !['pending', 'approved'].includes(stored.approval)) fail('APPROVAL_UNAVAILABLE', 'This action cannot receive fresh approval');
      this.db.prepare('UPDATE effects SET approval=?,updated_at=? WHERE request_id=?').run(decision === 'approve' ? 'approved' : 'rejected', this.clock(), requestId);
      return this.get(requestId);
    });
  }

  /** Internal host lifecycle operation; never expose directly as renderer authority. */
  cancel(requestId: string): void {
    this.atomic(() => {
      const effect = this.stored(requestId);
      if (effect.state !== 'prepared' || !['pending', 'approved'].includes(effect.approval)) fail('APPROVAL_UNAVAILABLE', 'Only pending or approved prepared actions can be canceled');
      this.db.prepare("UPDATE effects SET approval='canceled',updated_at=? WHERE request_id=?").run(this.clock(), requestId);
    });
  }

  /** Run at Stop, sign-out, disconnect, runtime/connection change, sleep and Quit. */
  invalidateSession(sessionId: string): void {
    this.atomic(() => {
      this.db.prepare("UPDATE effects SET approval='canceled',updated_at=? WHERE session_id=? AND state='prepared' AND approval IN ('pending','approved')").run(this.clock(), sessionId);
      this.db.prepare("UPDATE effects SET state='uncertain',updated_at=? WHERE session_id=? AND state='executing'").run(this.clock(), sessionId);
    });
  }

  reserve(input: ActionDescriptor, authority: Authority): Reservation {
    const descriptor = validateDescriptor(input);
    this.checkScope(descriptor);
    return this.atomic(() => {
      const stored = this.matching(descriptor);
      // Output replay is safe, but still needs the same live original-host identity.
      if (stored.state === 'completed') {
        assertAuthority(descriptor, {...authority, mode: 'build'}, this.clock(), false);
        return {kind: 'completed', result: JSON.parse(stored.result!) as JsonValue};
      }
      assertAuthority(descriptor, authority, this.clock());
      if (stored.state === 'uncertain') fail('UNCERTAIN_EFFECT', 'An uncertain side effect requires human review and must not be retried');
      if (stored.state === 'executing') fail('ALREADY_EXECUTING', 'This action was already reserved and cannot be dispatched again');
      if (stored.approval !== 'approved') fail('HOST_APPROVAL_REQUIRED', 'A fresh exact original-host approval is required');
      const active = this.db.prepare("SELECT request_id FROM effects WHERE session_id=? AND state IN ('executing','uncertain') LIMIT 1").get(descriptor.sessionId);
      if (active) fail('SESSION_UNAVAILABLE', 'An executing or uncertain action already owns this session');
      const attemptId = randomUUID();
      this.db.prepare("UPDATE effects SET state='executing',approval='consumed',attempt_id=?,updated_at=? WHERE request_id=?").run(attemptId, this.clock(), descriptor.requestId);
      return {kind: 'execute', ticket: {requestId: descriptor.requestId, fingerprint: stored.fingerprint, attemptId}};
    });
  }

  complete(ticket: DispatchTicket, result: JsonValue, authority: Authority): void {
    const encodedResult = canonicalJson(result);
    if (Buffer.byteLength(encodedResult) > 65_536) fail('RESULT_TOO_LARGE', 'Effect results are limited to 64 KiB');
    let authorityError: unknown;
    this.atomic(() => {
      const stored = this.stored(ticket.requestId);
      if (stored.fingerprint !== ticket.fingerprint || stored.attempt_id !== ticket.attemptId) fail('STALE_DISPATCH', 'Completion does not match the reserved attempt');
      if (stored.state === 'completed') {
        if (stored.result !== encodedResult) fail('RESULT_CONFLICT', 'A completed result is immutable');
        return;
      }
      if (stored.state !== 'executing') fail('STALE_DISPATCH', 'This attempt no longer has authority to complete');
      const descriptor = JSON.parse(stored.descriptor) as ActionDescriptor;
      try {assertAuthority(descriptor, authority, this.clock(), false);} catch (error) {
        this.db.prepare("UPDATE effects SET state='uncertain',updated_at=? WHERE request_id=?").run(this.clock(), ticket.requestId);
        authorityError = error;
        return;
      }
      this.enqueueWithinTransaction(`effect:${ticket.requestId}`, {type: 'effect.completed', requestId: ticket.requestId, fingerprint: ticket.fingerprint, result});
      this.db.prepare("UPDATE effects SET state='completed',result=?,updated_at=? WHERE request_id=?").run(encodedResult, this.clock(), ticket.requestId);
    });
    if (authorityError) throw authorityError;
  }

  private enqueueWithinTransaction(id: string, payload: JsonValue): void {
    if (!id || id.length > 1024) fail('INVALID_EVENT', 'An outbound event identity is required');
    const encoded = canonicalJson(payload);
    const hash = sha256(encoded);
    const existing = this.db.prepare('SELECT fingerprint FROM outbound_events WHERE id=?').get(id) as {fingerprint: string} | undefined;
    if (existing) {
      if (existing.fingerprint !== hash) fail('EVENT_CONFLICT', 'Outbound event identity is already bound to different data');
      return;
    }
    const retained = this.db.prepare('SELECT count(*) AS total,coalesce(sum(length(CAST(payload AS BLOB))),0) AS bytes FROM outbound_events').get() as {total: number; bytes: number};
    if (retained.total >= 10_000 || retained.bytes + Buffer.byteLength(encoded) > 67_108_864) fail('OUTBOX_FULL', 'Outbound journal retention limit reached; no event was dropped');
    this.db.prepare('INSERT INTO outbound_events(id,fingerprint,payload,created_at) VALUES(?,?,?,?)').run(id, hash, encoded, this.clock());
  }

  enqueue(id: string, payload: JsonValue): void {
    this.atomic(() => this.enqueueWithinTransaction(id, payload));
  }

  pending(limit = 100): OutboundEvent[] {
    if (this.closed) fail('JOURNAL_CLOSED', 'Journal is closed');
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) fail('INVALID_LIMIT', 'Outbox pages must contain 1 to 500 records');
    const rows = this.db.prepare('SELECT id,payload,created_at FROM outbound_events WHERE acknowledged_at IS NULL ORDER BY sequence LIMIT ?').all(limit) as {id: string; payload: string; created_at: number}[];
    return rows.map(row => ({id: row.id, payload: JSON.parse(row.payload) as JsonValue, createdAt: row.created_at}));
  }

  acknowledge(id: string): void {
    this.atomic(() => {
      const result = this.db.prepare('UPDATE outbound_events SET acknowledged_at=coalesce(acknowledged_at,?) WHERE id=?').run(this.clock(), id);
      if (result.changes === 0) fail('UNKNOWN_EVENT', 'No outbound event has that identity');
    });
  }

  close(): void {
    if (this.closed) return;
    this.db.close();
    this.closed = true;
  }
}
