import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp, readFile, realpath, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {executeApprovedShell, hostShell} from '../src/shell.js';
import {ExecutionJournal} from '../src/journal.js';
import {fingerprint} from '../src/policy.js';
import type {ActionDescriptor, Authority} from '../src/policy.js';

async function fixture(script: string, shellCommand?: string) {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'multai-shell-')));
  const journal = new ExecutionJournal(join(folder, 'journal.sqlite'), {serviceOrigin: 'https://synthetic.example', accountId: 'owner', deviceId: 'host'});
  const descriptor: ActionDescriptor = {version: 1, requestId: randomUUID(), sessionId: 'session', originalOwnerId: 'owner', originalDeviceId: 'host', accountGeneration: 1, sessionGeneration: 1, runtimeGeneration: 1, connectionId: 'connection', payerId: 'owner', resourceIdentity: 'test-command', cwd: folder, expiresAt: Date.now() + 60_000, operation: shellCommand === undefined ? {kind: 'shell', executable: await realpath(process.execPath), argv: ['-e', script], commandText: null} : {kind: 'shell', executable: await realpath(hostShell(shellCommand).executable), argv: hostShell(shellCommand).argv, commandText: shellCommand}};
  const authority: Authority = {actorId: 'owner', actorDeviceId: 'host', role: 'owner', sessionId: 'session', originalOwnerId: 'owner', originalDeviceId: 'host', accountGeneration: 1, sessionGeneration: 1, runtimeGeneration: 1, connectionId: 'connection', payerId: 'owner', mode: 'build', connected: true};
  journal.prepare(descriptor, authority);
  return {folder, journal, descriptor, authority, approve() {journal.decide(descriptor.requestId, fingerprint(descriptor), authority, 'approve');}, async close() {journal.close(); await rm(folder, {recursive: true, force: true});}};
}

test('only an exact approved command dispatches, inherits no credential environment and replays once', async t => {
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

test('command output is bounded and split secret bytes are redacted before publication', async t => {
  const secret = 'sk-synthetic-secret-never-valid-12345';
  const script = `process.stdout.write(${JSON.stringify(secret.slice(0, 10))}); setTimeout(()=>{process.stdout.write(${JSON.stringify(secret.slice(10))});process.stdout.write('x'.repeat(1000));},10);`;
  const x = await fixture(script); t.after(() => x.close()); x.approve();
  const result = await executeApprovedShell({...x, signal: new AbortController().signal, secrets: [secret], maxOutputBytes: 50});
  assert.equal(result.truncated, true);
  assert.ok(result.output.startsWith('[REDACTED]'));
  assert.ok(!result.output.includes('sk-synthetic'));
  assert.ok(Buffer.byteLength(result.output) <= 50);
});

test('large and JSON-escaped shell output fits the durable journal and replays without dispatch', async t => {
  for (const [text, maximum] of [['x'.repeat(65_536), undefined], ['\0\n"\\'.repeat(20_000), 131_072]] as const) {
    const x = await fixture(`process.stdout.write(${JSON.stringify(text.slice(0, 4))}.repeat(${text.length / 4}))`);
    t.after(() => x.close()); x.approve();
    const options = {...x, signal: new AbortController().signal, maxOutputBytes: maximum};
    const result = await executeApprovedShell(options);
    assert.equal(result.exitCode, 0);
    assert.equal(result.truncated, true);
    assert.ok(text.startsWith(result.output));
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 65_536);
    assert.equal(x.journal.get(x.descriptor.requestId).state, 'completed');
    assert.deepEqual(await executeApprovedShell(options), result);
    assert.equal(x.journal.pending().length, 1);
  }
});

test('shell output limits preserve whole Unicode characters without exceeding the byte budget', async t => {
  const x = await fixture("process.stdout.write('🌍🌍')"); t.after(() => x.close()); x.approve();
  const result = await executeApprovedShell({...x, signal: new AbortController().signal, maxOutputBytes: 5});
  assert.equal(result.output, '🌍');
  assert.equal(result.truncated, true);
  assert.ok(Buffer.byteLength(result.output) <= 5);
});

test('real process cancellation kills the process group and marks the effect uncertain', async t => {
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

const node = process.execPath;
const quoted = (value: string) => `"${value}"`;
const alive = (pid: number) => {try {process.kill(pid, 0); return true;} catch {return false;}};

test('the host shell runs the exact reviewed text, including a quoted program path', async t => {
  // Starts with a quote: the case cmd.exe /s mangles unless the text is wrapped exactly once.
  const command = `${quoted(node)} -e "console.log('a b', process.argv.length)"`;
  const x = await fixture('', command); t.after(() => x.close()); x.approve();
  const result = await executeApprovedShell({...x, signal: new AbortController().signal});
  assert.equal(result.exitCode, 0, result.output);
  assert.equal(result.output.trim(), 'a b 1');
});

test('a failing command reports its exit code without retrying', async t => {
  const x = await fixture('', `${quoted(node)} -e "process.exit(7)"`); t.after(() => x.close()); x.approve();
  const result = await executeApprovedShell({...x, signal: new AbortController().signal});
  assert.equal(result.exitCode, 7);
  assert.deepEqual(await executeApprovedShell({...x, signal: new AbortController().signal}), result);
});

test('background processes a finished command left running are ended', async t => {
  const child = `require('fs').writeFileSync('bg', String(process.pid)); setInterval(() => {}, 1000)`;
  const background = process.platform === 'win32'
    ? `start "" /b ${quoted(node)} -e "${child}" & ${quoted(node)} -e "setTimeout(() => {}, 1500)"`
    : `${quoted(node)} -e "${child}" & ${quoted(node)} -e "setTimeout(() => {}, 1500)"`;
  const x = await fixture('', background); t.after(() => x.close()); x.approve();
  const result = await executeApprovedShell({...x, signal: new AbortController().signal});
  assert.equal(result.exitCode, 0, result.output);
  const pid = Number(await readFile(join(x.folder, 'bg'), 'utf8'));
  assert.ok(pid > 0);
  for (let attempt = 0; attempt < 50 && alive(pid); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(alive(pid), false, 'background child survived the command');
});

test('a timed-out command and everything it started are stopped and marked uncertain', async t => {
  const child = `require('fs').writeFileSync('bg', String(process.pid)); setInterval(() => {}, 1000)`;
  const command = process.platform === 'win32'
    ? `start "" /b ${quoted(node)} -e "${child}" & ${quoted(node)} -e "setInterval(() => {}, 1000)"`
    : `${quoted(node)} -e "${child}" & ${quoted(node)} -e "setInterval(() => {}, 1000)"`;
  const x = await fixture('', command); t.after(() => x.close()); x.approve();
  await assert.rejects(executeApprovedShell({...x, signal: new AbortController().signal, timeoutMs: 2500}), /deadline/);
  assert.equal(x.journal.get(x.descriptor.requestId).state, 'uncertain');
  const pid = Number(await readFile(join(x.folder, 'bg'), 'utf8'));
  for (let attempt = 0; attempt < 50 && alive(pid); attempt++) await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(alive(pid), false);
});
