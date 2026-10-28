import assert from 'node:assert/strict';
import {chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {ExecutionJournal, RuntimeError, fingerprint} from '../src/index.js';
import type {ActionDescriptor, Authority, DispatchTicket, JournalScope} from '../src/index.js';

const scope: JournalScope = {serviceOrigin: 'https://collaboration.example', accountId: 'owner-a', deviceId: 'device-a'};
const baseTime = 1_800_000_000_000;

function descriptor(overrides: Partial<ActionDescriptor> = {}): ActionDescriptor {
  return {
    version: 1, requestId: 'request-1', sessionId: 'session-a', originalOwnerId: scope.accountId,
    originalDeviceId: scope.deviceId, accountGeneration: 1, sessionGeneration: 1, runtimeGeneration: 1,
    connectionId: 'connection-a', payerId: 'payer-a', resourceIdentity: 'workspace-a', cwd: '/tmp/workspace-a',
    expiresAt: baseTime + 60_000, operation: {kind: 'shell', executable: '/bin/sh', argv: ['-c', 'npm test'], commandText: 'npm test'},
    ...overrides,
  };
}

function authority(overrides: Partial<Authority> = {}): Authority {
  return {
    actorId: scope.accountId, actorDeviceId: scope.deviceId, role: 'owner', sessionId: 'session-a',
    originalOwnerId: scope.accountId, originalDeviceId: scope.deviceId, accountGeneration: 1, sessionGeneration: 1,
    runtimeGeneration: 1, connectionId: 'connection-a', payerId: 'payer-a', mode: 'build', connected: true,
    ...overrides,
  };
}

function throwsCode(operation: () => unknown, code: string): void {
  assert.throws(operation, error => error instanceof RuntimeError && error.code === code);
}

function fixture(t: {after: (cleanup: () => void) => void}) {
  const directory = mkdtempSync(join(tmpdir(), 'multai-journal-test-'));
  const filename = join(directory, 'execution.sqlite');
  let now = baseTime;
  let journal = new ExecutionJournal(filename, scope, () => now);
  t.after(() => {journal.close(); rmSync(directory, {recursive: true, force: true});});
  return {
    get journal() {return journal;}, filename,
    advance(ms: number) {now += ms;},
    reopen(nextScope = scope) {journal.close(); journal = new ExecutionJournal(filename, nextScope, () => now); return journal;},
  };
}

function approved(journal: ExecutionJournal, input = descriptor()): ActionDescriptor {
  const caller = authority({sessionId: input.sessionId});
  const prepared = journal.prepare(input, caller);
  journal.decide(input.requestId, prepared.fingerprint, caller, 'approve');
  return input;
}

function reserve(journal: ExecutionJournal, input = descriptor()): DispatchTicket {
  const reservation = journal.reserve(input, authority());
  assert.equal(reservation.kind, 'execute');
  return reservation.ticket;
}

test('a side effect is reserved once, records its outcome and atomically queues completion', t => {
  const f = fixture(t);
  const input = approved(f.journal);
  const ticket = reserve(f.journal, input);
  throwsCode(() => f.journal.reserve(input, authority()), 'ALREADY_EXECUTING');
  assert.equal(f.journal.get(input.requestId).approval, 'consumed');
  f.journal.complete(ticket, {exitCode: 0, output: 'passed'}, authority());
  assert.equal(f.journal.get(input.requestId).state, 'completed');
  f.advance(120_000);
  // Expired approval does not prevent retrieval of an immutable completed outcome.
  assert.deepEqual(f.journal.reserve(input, authority({mode: 'plan'})), {kind: 'completed', result: {exitCode: 0, output: 'passed'}});
  assert.equal(f.journal.pending().length, 1);
  f.journal.complete(ticket, {output: 'passed', exitCode: 0}, authority());
  assert.equal(f.journal.pending().length, 1);
  throwsCode(() => f.journal.complete(ticket, {exitCode: 1}, authority()), 'RESULT_CONFLICT');
});

test('Plan mode independently blocks preparation and dispatch of every side-effect type', t => {
  const f = fixture(t);
  const operations: ActionDescriptor['operation'][] = [
    descriptor().operation,
    {kind: 'external', tool: 'tool-a', transport: 'https', arguments: {text: 'sample'}},
    {kind: 'file_write', relativePath: 'src/index.ts', contentHash: 'a'.repeat(64), expectedContentHash: null},
  ];
  for (const [index, operation] of operations.entries()) {
    const input = descriptor({requestId: `request-${index}`, operation});
    throwsCode(() => f.journal.prepare(input, authority({mode: 'plan'})), 'PLAN_MODE');
    approved(f.journal, input);
    throwsCode(() => f.journal.reserve(input, authority({mode: 'plan'})), 'PLAN_MODE');
    assert.equal(f.journal.get(input.requestId).state, 'prepared');
  }
});

test('only the original owner on the original device can approve or dispatch', t => {
  const f = fixture(t);
  const input = f.journal.prepare(descriptor(), authority());
  for (const caller of [authority({role: 'collaborator'}), authority({role: 'viewer'}), authority({actorId: 'leader-b'}), authority({actorDeviceId: 'device-b'})]) {
    throwsCode(() => f.journal.decide('request-1', input.fingerprint, caller, 'approve'), 'HOST_APPROVAL_REQUIRED');
    throwsCode(() => f.journal.reserve(descriptor(), caller), 'HOST_APPROVAL_REQUIRED');
  }
  throwsCode(() => f.journal.decide('request-1', 'wrong-hash', authority(), 'approve'), 'REQUEST_CONFLICT');
  throwsCode(() => f.journal.reserve(descriptor(), authority()), 'HOST_APPROVAL_REQUIRED');
});

test('the exact descriptor binds command, executable, arguments, cwd, connection, payer, resource and generations', t => {
  const f = fixture(t);
  approved(f.journal);
  const changed: Partial<ActionDescriptor>[] = [
    {operation: {kind: 'shell', executable: '/bin/bash', argv: ['-c', 'npm test'], commandText: 'npm test'}},
    {operation: {kind: 'shell', executable: '/bin/sh', argv: ['-c', 'npm run build'], commandText: 'npm run build'}},
    {cwd: '/tmp/workspace-b'}, {connectionId: 'connection-b'}, {payerId: 'payer-b'},
    {resourceIdentity: 'workspace-b'}, {accountGeneration: 2}, {sessionGeneration: 2}, {runtimeGeneration: 2},
    {expiresAt: baseTime + 120_000},
  ];
  for (const mutation of changed) throwsCode(() => f.journal.reserve(descriptor(mutation), authority()), 'REQUEST_CONFLICT');
  for (const mutation of [{accountGeneration: 2}, {sessionGeneration: 2}, {runtimeGeneration: 2}, {connectionId: 'connection-b'}, {payerId: 'payer-b'}]) {
    throwsCode(() => f.journal.reserve(descriptor(), authority(mutation)), 'STALE_AUTHORITY');
  }
  throwsCode(() => f.journal.reserve(descriptor(), authority({connected: false})), 'HOST_UNAVAILABLE');
  assert.equal(f.journal.get('request-1').state, 'prepared');
});

test('rejected, canceled and expired requests cannot acquire dispatch authority', t => {
  const f = fixture(t);
  const input = f.journal.prepare(descriptor(), authority());
  f.journal.decide('request-1', input.fingerprint, authority(), 'reject');
  throwsCode(() => f.journal.decide('request-1', input.fingerprint, authority(), 'approve'), 'APPROVAL_UNAVAILABLE');
  throwsCode(() => f.journal.reserve(descriptor(), authority()), 'HOST_APPROVAL_REQUIRED');
  const canceled = approved(f.journal, descriptor({requestId: 'canceled'}));
  f.journal.cancel(canceled.requestId);
  throwsCode(() => f.journal.reserve(canceled, authority()), 'HOST_APPROVAL_REQUIRED');
  const expired = approved(f.journal, descriptor({requestId: 'expired'}));
  f.advance(60_000);
  throwsCode(() => f.journal.reserve(expired, authority()), 'APPROVAL_EXPIRED');
});

test('a real SQLite reopen makes interrupted effects uncertain and cancels stored approvals', t => {
  const f = fixture(t);
  const first = approved(f.journal);
  const ticket = reserve(f.journal, first);
  const pending = approved(f.journal, descriptor({requestId: 'pending', sessionId: 'session-b'}));
  f.reopen();
  assert.equal(f.journal.get(first.requestId).state, 'uncertain');
  assert.equal(f.journal.get(pending.requestId).approval, 'canceled');
  throwsCode(() => f.journal.reserve(first, authority()), 'UNCERTAIN_EFFECT');
  throwsCode(() => f.journal.complete(ticket, {success: true}, authority()), 'STALE_DISPATCH');
  const next = approved(f.journal, descriptor({requestId: 'next'}));
  throwsCode(() => f.journal.reserve(next, authority()), 'SESSION_UNAVAILABLE');
});

test('session invalidation fences late completions and leaves unrelated sessions intact', t => {
  const f = fixture(t);
  const first = approved(f.journal);
  const ticket = reserve(f.journal, first);
  const second = descriptor({requestId: 'second', sessionId: 'session-b'});
  f.journal.prepare(second, authority({sessionId: 'session-b'}));
  f.journal.decide(second.requestId, fingerprint(second), authority({sessionId: 'session-b'}), 'approve');
  f.journal.invalidateSession(first.sessionId);
  throwsCode(() => f.journal.complete(ticket, {success: true}, authority()), 'STALE_DISPATCH');
  assert.equal(f.journal.get(first.requestId).state, 'uncertain');
  assert.equal(f.journal.get(second.requestId).approval, 'approved');
});

test('changed runtime authority during completion commits uncertainty rather than accepting a stale callback', t => {
  const f = fixture(t);
  const first = approved(f.journal);
  const ticket = reserve(f.journal, first);
  throwsCode(() => f.journal.complete(ticket, {success: true}, authority({runtimeGeneration: 2})), 'STALE_AUTHORITY');
  assert.equal(f.journal.get(first.requestId).state, 'uncertain');
  assert.deepEqual(f.journal.pending(), []);
});

test('one journal connection owns execution and account, device and service scopes cannot cross', t => {
  const f = fixture(t);
  assert.throws(() => new ExecutionJournal(f.filename, scope, () => baseTime), /locked/u);
  f.journal.close();
  for (const nextScope of [{...scope, accountId: 'owner-b'}, {...scope, deviceId: 'device-b'}, {...scope, serviceOrigin: 'https://other.example'}]) {
    throwsCode(() => new ExecutionJournal(f.filename, nextScope, () => baseTime), 'SCOPE_MISMATCH');
  }
  f.reopen();
  throwsCode(() => f.journal.prepare(descriptor({originalDeviceId: 'device-b'}), authority()), 'SCOPE_MISMATCH');
});

test('journal permissions are private during initialization even with a permissive umask', t => {
  const directory = mkdtempSync(join(tmpdir(), 'multai-journal-permissions-'));
  const filename = join(directory, 'execution.sqlite');
  let journal: ExecutionJournal | undefined;
  t.after(() => {journal?.close(); rmSync(directory, {recursive: true, force: true});});
  // The existing parent is trusted native storage; leave its permissions alone.
  chmodSync(directory, 0o750);
  const previousUmask = process.umask(0);
  let initializationChecks = 0;
  try {
    journal = new ExecutionJournal(filename, scope, () => {
      // Called inside startup recovery, before constructor initialization ends.
      assert.equal(statSync(filename).mode & 0o777, 0o600);
      initializationChecks++;
      return baseTime;
    });
  } finally {
    process.umask(previousUmask);
  }
  assert.ok(initializationChecks > 0);
  assert.equal(statSync(directory).mode & 0o777, 0o750);
  journal.close();
  // Existing databases are secured before startup recovery can write to them too.
  chmodSync(filename, 0o644);
  journal = new ExecutionJournal(filename, scope, () => {
    assert.equal(statSync(filename).mode & 0o777, 0o600);
    return baseTime;
  });
});

test('journal creation rejects a symbolic link or directory without modifying its target', t => {
  const directory = mkdtempSync(join(tmpdir(), 'multai-journal-path-'));
  t.after(() => rmSync(directory, {recursive: true, force: true}));
  const target = join(directory, 'unrelated.txt');
  const link = join(directory, 'execution.sqlite');
  writeFileSync(target, 'unrelated content', {mode: 0o644});
  chmodSync(target, 0o644);
  symlinkSync(target, link);
  throwsCode(() => new ExecutionJournal(link, scope), 'UNSAFE_JOURNAL_PATH');
  assert.equal(readFileSync(target, 'utf8'), 'unrelated content');
  assert.equal(statSync(target).mode & 0o777, 0o644);
  const nonregular = join(directory, 'database-directory');
  mkdirSync(nonregular);
  throwsCode(() => new ExecutionJournal(nonregular, scope), 'UNSAFE_JOURNAL_PATH');
});

test('outbound delivery survives restart and only acknowledgments clear pending records', t => {
  const f = fixture(t);
  f.journal.enqueue('event-a', {kind: 'progress', step: 1});
  f.journal.enqueue('event-a', {step: 1, kind: 'progress'});
  assert.equal(f.journal.pending().length, 1);
  throwsCode(() => f.journal.enqueue('event-a', {step: 2}), 'EVENT_CONFLICT');
  f.reopen();
  assert.equal(f.journal.pending()[0]?.id, 'event-a');
  f.journal.acknowledge('event-a');
  f.journal.acknowledge('event-a');
  f.reopen();
  assert.deepEqual(f.journal.pending(), []);
  // An acknowledged ID stays reserved and cannot be used to send new content.
  throwsCode(() => f.journal.enqueue('event-a', {step: 3}), 'EVENT_CONFLICT');
});

test('completed results survive restart while oversized results never permit a second execution', t => {
  const f = fixture(t);
  const first = approved(f.journal);
  const ticket = reserve(f.journal, first);
  f.journal.complete(ticket, {exitCode: 0}, authority());
  f.reopen();
  assert.deepEqual(f.journal.reserve(first, authority()), {kind: 'completed', result: {exitCode: 0}});
  const oversized = approved(f.journal, descriptor({requestId: 'large'}));
  const secondTicket = reserve(f.journal, oversized);
  throwsCode(() => f.journal.complete(secondTicket, 'a'.repeat(70_000), authority()), 'RESULT_TOO_LARGE');
  throwsCode(() => f.journal.reserve(oversized, authority()), 'ALREADY_EXECUTING');
});

test('descriptors are copied, key order is canonical and unsupported bytes are rejected', t => {
  const f = fixture(t);
  const input = descriptor();
  const prepared = f.journal.prepare(input, authority());
  input.cwd = '/tmp/changed';
  assert.equal(f.journal.get(input.requestId).descriptor.cwd, '/tmp/workspace-a');
  assert.equal(prepared.fingerprint, fingerprint(descriptor()));
  const external = descriptor({operation: {kind: 'external', tool: 'tool-a', transport: 'https', arguments: {a: 1, b: [true, null]}}});
  const reordered = descriptor({operation: {kind: 'external', tool: 'tool-a', transport: 'https', arguments: {b: [true, null], a: 1}}});
  assert.equal(fingerprint(external), fingerprint(reordered));
  throwsCode(() => f.journal.prepare(descriptor({cwd: '../escape'}), authority()), 'INVALID_DESCRIPTOR');
  throwsCode(() => fingerprint({...descriptor(), unwanted: 'field'} as ActionDescriptor), 'INVALID_DESCRIPTOR');
  throwsCode(() => fingerprint(null as unknown as ActionDescriptor), 'INVALID_DESCRIPTOR');
  throwsCode(() => fingerprint(descriptor({runtimeGeneration: Number.NaN})), 'INVALID_JSON');
});


test('outbound insertion order survives equal timestamps, clock rollback and restart', t => {
  const f = fixture(t);
  f.journal.enqueue('z-first', {type: 'prepared'});
  f.journal.enqueue('a-second', {type: 'started'});
  // Wall time can move backward while lifecycle order must remain stable.
  f.advance(-60_000);
  f.journal.enqueue('0-third', {type: 'completed'});
  assert.deepEqual(f.journal.pending().map(event => event.id), ['z-first', 'a-second', '0-third']);
  f.reopen();
  assert.deepEqual(f.journal.pending().map(event => event.id), ['z-first', 'a-second', '0-third']);
  assert.equal(f.journal.pending(1)[0]?.id, 'z-first');
  f.journal.acknowledge('z-first');
  assert.equal(f.journal.pending(1)[0]?.id, 'a-second');
});

test('rejection remains visible through session invalidation and journal recovery', t => {
  const f = fixture(t);
  const rejected = f.journal.prepare(descriptor(), authority());
  f.journal.decide('request-1', rejected.fingerprint, authority(), 'reject');
  throwsCode(() => f.journal.cancel('request-1'), 'APPROVAL_UNAVAILABLE');
  const pending = descriptor({requestId: 'pending'});
  f.journal.prepare(pending, authority());
  const accepted = approved(f.journal, descriptor({requestId: 'accepted'}));
  f.journal.invalidateSession('session-a');
  assert.equal(f.journal.get('request-1').approval, 'rejected');
  assert.equal(f.journal.get(pending.requestId).approval, 'canceled');
  assert.equal(f.journal.get(accepted.requestId).approval, 'canceled');
  // A distinct session proves startup recovery preserves rejection even without
  // invalidateSession having visited that record first.
  const other = descriptor({requestId: 'other-rejected', sessionId: 'session-b'});
  const caller = authority({sessionId: 'session-b'});
  const prepared = f.journal.prepare(other, caller);
  f.journal.decide(other.requestId, prepared.fingerprint, caller, 'reject');
  f.reopen();
  assert.equal(f.journal.get('request-1').approval, 'rejected');
  assert.equal(f.journal.get(other.requestId).approval, 'rejected');
  throwsCode(() => f.journal.decide(other.requestId, prepared.fingerprint, caller, 'approve'), 'APPROVAL_UNAVAILABLE');
});
