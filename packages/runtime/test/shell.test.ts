import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, readFile, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {executeApprovedShell} from '../src/shell.js';
import {ExecutionJournal} from '../src/journal.js';
import {fingerprint} from '../src/policy.js';
import type {ActionDescriptor, Authority} from '../src/policy.js';

async function fixture(script: string) {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'multai-shell-')));
  const journal = new ExecutionJournal(join(folder, 'journal.sqlite'), {serviceOrigin: 'https://synthetic.example', accountId: 'owner', deviceId: 'host'});
  const descriptor: ActionDescriptor = {version: 1, requestId: randomUUID(), sessionId: 'session', originalOwnerId: 'owner', originalDeviceId: 'host', accountGeneration: 1, sessionGeneration: 1, runtimeGeneration: 1, connectionId: 'connection', payerId: 'owner', resourceIdentity: 'test-command', cwd: folder, expiresAt: Date.now() + 60_000, operation: {kind: 'shell', executable: await realpath(process.execPath), argv: ['-e', script], commandText: null}};
  const authority: Authority = {actorId: 'owner', actorDeviceId: 'host', role: 'owner', sessionId: 'session', originalOwnerId: 'owner', originalDeviceId: 'host', accountGeneration: 1, sessionGeneration: 1, runtimeGeneration: 1, connectionId: 'connection', payerId: 'owner', mode: 'build', connected: true};
  journal.prepare(descriptor, authority);
  return {folder, journal, descriptor, authority, approve() {journal.decide(descriptor.requestId, fingerprint(descriptor), authority, 'approve');}, async close() {journal.close(); await rm(folder, {recursive: true, force: true});}};
}

test('only an exact approved command dispatches, inherits no credential environment and replays once', {skip: process.platform === 'win32'}, async t => {
  const x = await fixture("console.log(process.env.MULTAI_SYNTHETIC_SECRET ?? 'absent'); console.log('verified');"); t.after(() => x.close());
  process.env.MULTAI_SYNTHETIC_SECRET = 'synthetic-secret';
  t.after(() => {delete process.env.MULTAI_SYNTHETIC_SECRET;});
  const options = {...x, signal: new AbortController().signal};
  await assert.rejects(executeApprovedShell(options), /approval/);
  x.approve();
  await assert.rejects(executeApprovedShell({...options, authority: {...x.authority, mode: 'plan'}}), /Plan mode/);
  const result = await executeApprovedShell(options);
  assert.equal(result.exitCode, 0);
  assert.equal(result.output, 'absent\nverified\n');
  assert.deepEqual(await executeApprovedShell(options), result);
  assert.equal(x.journal.pending().length, 1);
});

test('command output is bounded and split secret bytes are redacted before publication', {skip: process.platform === 'win32'}, async t => {
  const secret = 'sk-synthetic-secret-never-valid-12345';
  const script = `process.stdout.write(${JSON.stringify(secret.slice(0, 10))}); setTimeout(()=>{process.stdout.write(${JSON.stringify(secret.slice(10))});process.stdout.write('x'.repeat(1000));},10);`;
  const x = await fixture(script); t.after(() => x.close()); x.approve();
  const result = await executeApprovedShell({...x, signal: new AbortController().signal, secrets: [secret], maxOutputBytes: 50});
  assert.equal(result.truncated, true);
  assert.ok(result.output.startsWith('[REDACTED]'));
  assert.ok(!result.output.includes('sk-synthetic'));
  assert.ok(Buffer.byteLength(result.output) <= 50);
});

test('real process cancellation kills the process group and marks the effect uncertain', {skip: process.platform === 'win32'}, async t => {
  const x = await fixture("require('fs').writeFileSync('started',String(process.pid)); setInterval(()=>{},1000)"); t.after(() => x.close()); x.approve();
  const controller = new AbortController();
  const promise = executeApprovedShell({...x, signal: controller.signal});
  let pid: number | undefined;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {pid = Number(await readFile(join(x.folder, 'started'), 'utf8')); break;} catch {}
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(pid);
  controller.abort();
  await assert.rejects(promise);
  assert.equal(x.journal.get(x.descriptor.requestId).state, 'uncertain');
  assert.throws(() => process.kill(pid!, 0), {code: 'ESRCH'});
  await assert.rejects(executeApprovedShell({...x, signal: new AbortController().signal}), /uncertain/);
});
