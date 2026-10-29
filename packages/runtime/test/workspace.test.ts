import assert from 'node:assert/strict';
import {test} from 'node:test';
import {chmod, lstat, mkdtemp, mkdir, readFile, realpath, rename, rm, symlink, link, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ControlledWorkspace} from '../src/workspace.js';
import {ExecutionJournal} from '../src/journal.js';
import {fingerprint, sha256} from '../src/policy.js';
import type {ActionDescriptor, Authority} from '../src/policy.js';

async function fixture() {
  const folder = await realpath(await mkdtemp(join(tmpdir(), 'multai-workspace-')));
  const root = join(folder, 'working'); await mkdir(root);
  const workspace = await ControlledWorkspace.open(root);
  const journal = new ExecutionJournal(join(folder, 'journal.sqlite'), {serviceOrigin: 'https://synthetic.example', accountId: 'owner', deviceId: 'host'});
  const descriptor = (path: string, content: string, expectedHash: string | null = null): ActionDescriptor => ({version: 1, requestId: randomUUID(), sessionId: 'session', originalOwnerId: 'owner', originalDeviceId: 'host', accountGeneration: 1, sessionGeneration: 1, runtimeGeneration: 1, connectionId: 'connection', payerId: 'owner', resourceIdentity: path, cwd: workspace.root, expiresAt: Date.now() + 60_000, operation: {kind: 'file_write', relativePath: path, contentHash: sha256(content), expectedContentHash: expectedHash}});
  const authority: Authority = {actorId: 'owner', actorDeviceId: 'host', role: 'owner', sessionId: 'session', originalOwnerId: 'owner', originalDeviceId: 'host', accountGeneration: 1, sessionGeneration: 1, runtimeGeneration: 1, connectionId: 'connection', payerId: 'owner', mode: 'build', connected: true};
  const approve = (action: ActionDescriptor) => {journal.prepare(action, authority); journal.decide(action.requestId, fingerprint(action), authority, 'approve'); return {descriptor: action, authority, journal, signal: new AbortController().signal};};
  return {folder, root, workspace, journal, descriptor, authority, approve, async close() {journal.close(); await rm(folder, {recursive: true, force: true});}};
}

test('controlled workspace reads, searches, writes exact reviewed content and replays saved outcome', async t => {
  const x = await fixture(); t.after(() => x.close());
  const content = 'export const answer = 42;\n';
  const action = x.descriptor('answer.ts', content);
  const approval = x.approve(action);
  const result = await x.workspace.write('answer.ts', content, null, approval);
  assert.equal(result.hash, sha256(content));
  assert.equal((await x.workspace.read('answer.ts')).text, content);
  assert.equal((await x.workspace.list()).entries[0]?.name, 'answer.ts');
  assert.equal((await x.workspace.search('answer')).matches[0]?.line, 1);
  await writeFile(join(x.root, 'answer.ts'), 'External edit');
  assert.deepEqual(await x.workspace.write('answer.ts', content, null, approval), result);
  assert.equal(await readFile(join(x.root, 'answer.ts'), 'utf8'), 'External edit');
  assert.equal(x.journal.pending().length, 1);
});

test('stale file hashes, altered descriptors, Plan, missing approval and canceled authority cannot write', async t => {
  const x = await fixture(); t.after(() => x.close());
  await writeFile(join(x.root, 'existing.ts'), 'Old');
  const action = x.descriptor('existing.ts', 'New', sha256('Old'));
  const approval = x.approve(action);
  await writeFile(join(x.root, 'existing.ts'), 'Changed externally');
  await assert.rejects(x.workspace.write('existing.ts', 'New', sha256('Old'), approval), /changed/);
  assert.equal(await readFile(join(x.root, 'existing.ts'), 'utf8'), 'Changed externally');
  x.journal.invalidateSession('session');
  assert.equal(x.journal.get(action.requestId).state, 'uncertain');
  await assert.rejects(x.workspace.write('elsewhere.ts', 'New', null, approval), /does not match/);
  const plan = {...approval, authority: {...x.authority, mode: 'plan' as const}};
  await assert.rejects(x.workspace.write('existing.ts', 'New', sha256('Old'), plan), /Plan mode/);
  const fresh = x.descriptor('fresh.ts', 'Fresh');
  x.journal.prepare(fresh, x.authority);
  await assert.rejects(x.workspace.write('fresh.ts', 'Fresh', null, {...approval, descriptor: fresh}), /approval/);
  const canceled = new AbortController(); canceled.abort();
  await assert.rejects(x.workspace.write('fresh.ts', 'Fresh', null, {...approval, descriptor: fresh, signal: canceled.signal}));
  await assert.rejects(readFile(join(x.root, 'fresh.ts')));
});

test('private paths, traversal, symlinks, hard links and binary/oversized files are denied', async t => {
  const x = await fixture(); t.after(() => x.close());
  await writeFile(join(x.folder, 'outside.txt'), 'Private outside');
  await writeFile(join(x.root, '.env'), 'PROVIDER_KEY=synthetic');
  await writeFile(join(x.root, 'binary.txt'), Buffer.from([0, 1, 2]));
  await writeFile(join(x.root, 'large.txt'), 'x'.repeat(262145));
  await writeFile(join(x.root, 'looks-normal.ts'), 'export const accidentalKey = "sk-synthetic-not-a-real-credential-123456";');
  await symlink(join(x.folder, 'outside.txt'), join(x.root, 'escape.txt'));
  await link(join(x.folder, 'outside.txt'), join(x.root, 'hard.txt'));
  for (const path of ['../outside.txt', '/etc/passwd', '.env', 'escape.txt', 'hard.txt', 'binary.txt', 'large.txt', 'looks-normal.ts']) await assert.rejects(x.workspace.read(path));
  const list = await x.workspace.list();
  assert.ok(list.omitted.some(item => item.name === '.env'));
  assert.ok(list.omitted.some(item => item.name === 'escape.txt'));
  assert.equal(await readFile(join(x.folder, 'outside.txt'), 'utf8'), 'Private outside');
});

test('root and parent substitution are revalidated and a UTF-8 BOM participates in exact hashes', async t => {
  const x = await fixture(); t.after(() => x.close());
  await writeFile(join(x.root, 'bom.txt'), '\ufeffhello');
  const bom = await x.workspace.read('bom.txt');
  assert.equal(bom.hash, sha256('\ufeffhello'));
  await mkdir(join(x.root, 'nested'));
  const action = x.descriptor('nested/new.ts', 'Safe');
  const approval = x.approve(action);
  await rename(join(x.root, 'nested'), join(x.folder, 'old-nested'));
  await symlink(x.folder, join(x.root, 'nested'));
  await assert.rejects(x.workspace.write('nested/new.ts', 'Safe', null, approval), /Links/);
  await assert.rejects(readFile(join(x.folder, 'new.ts')));
  await rename(x.root, join(x.folder, 'moved'));
  await mkdir(x.root);
  await assert.rejects(x.workspace.list(), /workspace changed/i);
  assert.equal(await realpath(x.root), x.root);
});

test('atomic text replacement preserves ordinary executable bits and strips special bits', async t => {
  const x = await fixture(); t.after(() => x.close());
  const original = '#!/bin/sh\nprintf old\n';
  const replacement = '#!/bin/sh\nprintf new\n';
  await writeFile(join(x.root, 'script.sh'), original);
  await chmod(join(x.root, 'script.sh'), 0o1755);
  assert.equal((await lstat(join(x.root, 'script.sh'))).mode & 0o7777, 0o1755);
  const action = x.descriptor('script.sh', replacement, sha256(original));
  await x.workspace.write('script.sh', replacement, sha256(original), x.approve(action));
  assert.equal(await readFile(join(x.root, 'script.sh'), 'utf8'), replacement);
  assert.equal((await lstat(join(x.root, 'script.sh'))).mode & 0o7777, 0o755);
  const fresh = x.descriptor('new.ts', 'export const fresh = true;');
  await x.workspace.write('new.ts', 'export const fresh = true;', null, x.approve(fresh));
  assert.equal((await lstat(join(x.root, 'new.ts'))).mode & 0o7777, 0o600);
});
