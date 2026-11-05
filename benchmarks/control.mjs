// Component measurements only: no model calls, network requests or live user profiles.
// Run with: node --import tsx benchmarks/control.mjs
import assert from 'node:assert/strict';
import {createHash, randomUUID} from 'node:crypto';
import {execFileSync} from 'node:child_process';
import {mkdir, mkdtemp, open, readFile, realpath, rename, rm, stat} from 'node:fs/promises';
import {cpus, release, tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {performance} from 'node:perf_hooks';
import {fileURLToPath} from 'node:url';
import {ExecutionJournal} from '../packages/runtime/src/journal.ts';
import {RuntimeError} from '../packages/runtime/src/policy.ts';
import {ControlledWorkspace} from '../packages/runtime/src/workspace.ts';
import {buildEnvelope, exportPublic, generatePhoneKeys, signControl, verifyControl} from '../packages/companion-core/src/control.ts';
import {envelopeSchema, verifyControl as verifyService} from '../apps/backend/src/owner-control.ts';

const SAMPLES = 100;
const WARMUP = 10;
const RECOVERIES = 30;
const PAYLOAD_BYTES = 16_384;
const repo = dirname(dirname(fileURLToPath(import.meta.url)));
const sourcePaths = [
  'packages/runtime/src/journal.ts', 'packages/runtime/src/policy.ts',
  'packages/runtime/src/workspace.ts', 'packages/companion-core/src/control.ts',
  'packages/companion-core/src/canonical.ts', 'apps/backend/src/owner-control.ts',
];
const sha256 = value => createHash('sha256').update(value).digest('hex');
const git = (...args) => execFileSync('git', args, {cwd: repo, encoding: 'utf8'}).trim();
const sources = Object.fromEntries(await Promise.all(sourcePaths.map(async path => [path, sha256(await readFile(join(repo, path)))])));
const sourceChanges = git('status', '--porcelain', '--', ...sourcePaths);
assert.equal(sourceChanges, '', 'Benchmark production sources must match HEAD.');
const timings = {durableWriteMs: [], approvedWriteMs: [], completedReplayMs: [], signedControlMs: [], recoveryMs: []};
const counts = {approvedWrites: 0, completedReplaysWithoutRewrite: 0, unapprovedWritesBlocked: 0,
  changedWritesBlocked: 0, nonOwnerApprovalsBlocked: 0, interruptedReservationsHeld: 0,
  validControlsAcceptedByBothVerifiers: 0, mutatedControlsRejectedByBothVerifiers: 0};
const root = await realpath(await mkdtemp(join(tmpdir(), 'multai-control-benchmark-')));
const scope = {serviceOrigin: 'https://benchmark.invalid', accountId: 'benchmark-owner', deviceId: 'benchmark-desktop'};
const signal = new AbortController().signal;
let journal;

const authority = sessionId => ({actorId: scope.accountId, actorDeviceId: scope.deviceId,
  role: 'owner', sessionId, originalOwnerId: scope.accountId, originalDeviceId: scope.deviceId,
  accountGeneration: 1, sessionGeneration: 1, runtimeGeneration: 1, connectionId: 'benchmark-model',
  payerId: scope.accountId, mode: 'build', connected: true});
const descriptor = (cwd, path, text, sessionId = 'benchmark-session') => ({version: 1, requestId: randomUUID(), sessionId,
  originalOwnerId: scope.accountId, originalDeviceId: scope.deviceId, accountGeneration: 1, sessionGeneration: 1,
  runtimeGeneration: 1, connectionId: 'benchmark-model', payerId: scope.accountId, resourceIdentity: 'benchmark-workspace',
  cwd, expiresAt: Date.now() + 120_000,
  operation: {kind: 'file_write', relativePath: path, expectedContentHash: null, contentHash: sha256(text)}});
const hasCode = code => error => error instanceof RuntimeError && error.code === code;
const payload = i => `// case ${i}\n`.padEnd(PAYLOAD_BYTES - 1, 'x') + '\n';

// A minimal file-durable atomic replacement, without path, authority or journal checks.
// Both paths sync the file and (on POSIX) its parent. Neither is a power-loss experiment.
async function durableWrite(directory, path, text) {
  const temporary = join(directory, `.stage-${randomUUID()}`);
  const handle = await open(temporary, 'wx', 0o600);
  try {await handle.writeFile(text, 'utf8'); await handle.sync();} finally {await handle.close();}
  await rename(temporary, join(directory, path));
  if (process.platform !== 'win32') {
    const parent = await open(directory, 'r');
    try {await parent.sync();} finally {await parent.close();}
  }
}

try {
  const baselineRoot = join(root, 'baseline'), controlledRoot = join(root, 'controlled');
  await mkdir(baselineRoot, {mode: 0o700}); await mkdir(controlledRoot, {mode: 0o700});
  const workspace = await ControlledWorkspace.open(controlledRoot);
  const journalPath = join(root, 'execution.sqlite');
  journal = new ExecutionJournal(journalPath, scope);

  for (let i = -WARMUP; i < SAMPLES; i++) {
    const path = `case-${i + WARMUP}.ts`, text = payload(i), action = descriptor(workspace.root, path, text);
    const caller = authority(action.sessionId);
    let baselineMs, approvedMs;
    const baseline = async () => {const start = performance.now(); await durableWrite(baselineRoot, path, text); baselineMs = performance.now() - start;};
    const controlled = async () => {
      const start = performance.now();
      const prepared = journal.prepare(action, caller);
      journal.decide(action.requestId, prepared.fingerprint, caller, 'approve');
      await workspace.write(path, text, null, {descriptor: action, authority: caller, journal, signal});
      approvedMs = performance.now() - start;
    };
    // Alternate order instead of always giving one path the first disk/cache access.
    if ((i + WARMUP) % 2) {await controlled(); await baseline();} else {await baseline(); await controlled();}
    assert.equal(await readFile(join(baselineRoot, path), 'utf8'), text);
    assert.equal((await workspace.read(path)).text, text);
    assert.equal(journal.get(action.requestId).state, 'completed');
    const before = await stat(join(workspace.root, path), {bigint: true});
    const replayStart = performance.now();
    const replay = await workspace.write(path, text, null, {descriptor: action, authority: caller, journal, signal});
    const replayMs = performance.now() - replayStart;
    const after = await stat(join(workspace.root, path), {bigint: true});
    assert.equal(replay.hash, sha256(text));
    assert.equal(after.ino, before.ino); assert.equal(after.mtimeNs, before.mtimeNs);
    if (i >= 0) {
      timings.durableWriteMs.push(baselineMs); timings.approvedWriteMs.push(approvedMs);
      timings.completedReplayMs.push(replayMs);
      counts.approvedWrites++; counts.completedReplaysWithoutRewrite++;
    }
  }

  // Fixed negative cases are reported separately from valid-path latency.
  for (let i = 0; i < SAMPLES; i++) {
    const path = `denied-${i}.ts`, text = payload(i), action = descriptor(workspace.root, path, text);
    const caller = authority(action.sessionId), prepared = journal.prepare(action, caller);
    await assert.rejects(workspace.write(path, text, null, {descriptor: action, authority: caller, journal, signal}), hasCode('HOST_APPROVAL_REQUIRED'));
    await assert.rejects(stat(join(workspace.root, path)), {code: 'ENOENT'});
    counts.unapprovedWritesBlocked++;
    assert.throws(() => journal.decide(action.requestId, prepared.fingerprint, {...caller, actorId: 'other-person', role: 'collaborator'}, 'approve'), hasCode('HOST_APPROVAL_REQUIRED'));
    counts.nonOwnerApprovalsBlocked++;
    journal.decide(action.requestId, prepared.fingerprint, caller, 'approve');
    await assert.rejects(workspace.write(path, text + '// changed\n', null, {descriptor: action, authority: caller, journal, signal}), hasCode('REQUEST_CONFLICT'));
    await assert.rejects(stat(join(workspace.root, path)), {code: 'ENOENT'});
    counts.changedWritesBlocked++;
  }

  for (let i = 0; i < RECOVERIES; i++) {
    const action = descriptor(workspace.root, `interrupted-${i}.ts`, payload(i), `interrupted-session-${i}`);
    const caller = authority(action.sessionId), prepared = journal.prepare(action, caller);
    journal.decide(action.requestId, prepared.fingerprint, caller, 'approve');
    assert.equal(journal.reserve(action, caller).kind, 'execute');
    journal.close(); journal = undefined;
    const start = performance.now();
    journal = new ExecutionJournal(journalPath, scope);
    assert.throws(() => journal.reserve(action, caller), hasCode('UNCERTAIN_EFFECT'));
    timings.recoveryMs.push(performance.now() - start);
    assert.equal(journal.get(action.requestId).state, 'uncertain');
    counts.interruptedReservationsHeld++;
  }

  const keys = await generatePhoneKeys(), publicKey = await exportPublic(keys.signing.publicKey);
  assert.equal(keys.signing.privateKey.extractable, false);
  for (let i = -WARMUP; i < SAMPLES; i++) {
    const envelope = buildEnvelope({pairingId: '11111111-1111-4111-8111-111111111111',
      sessionId: '22222222-2222-4222-8222-222222222222', runGeneration: 1,
      kind: 'approve', target: {actionId: randomUUID(), actionFingerprint: sha256(payload(i))}, now: Date.now()});
    const start = performance.now();
    const signed = await signControl(envelope, keys.signing.privateKey);
    const serviceAccepted = verifyService(envelopeSchema.parse(envelope), signed.signature, publicKey);
    const hostAccepted = await verifyControl(signed, publicKey);
    const elapsed = performance.now() - start;
    assert.equal(serviceAccepted, true); assert.equal(hostAccepted, true);
    if (i < 0) continue;
    timings.signedControlMs.push(elapsed); counts.validControlsAcceptedByBothVerifiers++;
    // Change a different schema-valid field on each iteration; never re-sign it.
    const changed = structuredClone(envelope);
    switch (i % 5) {
      case 0: changed.runGeneration++; break;
      case 1: changed.sessionId = '44444444-4444-4444-8444-444444444444'; break;
      case 2: changed.target.actionId = randomUUID(); break;
      case 3: changed.target.actionFingerprint = 'f'.repeat(64); break;
      case 4: changed.kind = 'reject'; break;
    }
    assert.equal(verifyService(envelopeSchema.parse(changed), signed.signature, publicKey), false);
    assert.equal(await verifyControl({envelope: changed, signature: signed.signature}, publicKey), false);
    counts.mutatedControlsRejectedByBothVerifiers++;
  }
} finally {
  journal?.close();
  await rm(root, {recursive: true, force: true});
}

function stats(samples) {
  assert.ok(samples.length > 0 && samples.every(x => Number.isFinite(x) && x >= 0));
  const sorted = [...samples].sort((a, b) => a - b);
  // Nearest-rank percentiles; all raw observations are retained below.
  const at = p => sorted[Math.ceil(p * sorted.length) - 1];
  return {n: samples.length, p50Ms: at(0.5), p95Ms: at(0.95), minMs: sorted[0], maxMs: sorted.at(-1), samplesMs: samples};
}
for (const [name, count] of Object.entries(counts)) assert.equal(count, name === 'interruptedReservationsHeld' ? RECOVERIES : SAMPLES, name);
assert.equal(git('status', '--porcelain', '--', ...sourcePaths), '', 'Production sources changed during the run.');
for (const path of sourcePaths) assert.equal(sha256(await readFile(join(repo, path))), sources[path], `Source changed: ${path}`);
console.log(JSON.stringify({schemaVersion: 1, measuredAt: new Date().toISOString(),
  sourceCommit: git('rev-parse', 'HEAD'), productionSourcesUnmodified: true, sourceSha256: sources,
  runnerSha256: sha256(await readFile(fileURLToPath(import.meta.url))),
  environment: {node: process.version, platform: process.platform, osRelease: release(), arch: process.arch, cpu: cpus()[0]?.model},
  protocol: {samples: SAMPLES, warmupPerWriteAndSignaturePath: WARMUP, recoverySamples: RECOVERIES,
    payloadBytes: PAYLOAD_BYTES, order: 'alternating baseline/approved write', percentile: 'nearest-rank',
    sqlite: 'file-backed, journal_mode=DELETE, synchronous=FULL',
    scope: 'Local components; no model, network, database service, UI, human timing, or competitor execution.'},
  counts, timings: Object.fromEntries(Object.entries(timings).map(([name, values]) => [name, stats(values)]))}, null, 2));
