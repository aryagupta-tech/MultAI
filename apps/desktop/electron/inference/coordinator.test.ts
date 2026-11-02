import {afterEach, beforeEach, describe, expect, test, vi} from 'vitest';
import {mkdtemp, mkdir, readFile, readdir, realpath, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {createHash, randomUUID} from 'node:crypto';
import type {ActionDescriptor, RunAgentOptions, ProviderCredentials, ToolCall} from '@multai/runtime';
import {ExecutionJournal} from '@multai/runtime';
import {HostCoordinator} from './coordinator';
import {PLAN_SYSTEM} from './split';
import {execFileSync} from 'node:child_process';
import {writeFile} from 'node:fs/promises';
import {ProjectRegistry} from './projects';
import {McpHost} from './mcp';
import {publicProviderFetch} from './network';
import type {HostRunChange} from '../../src/bridge/execution';

const runtime = vi.hoisted(() => ({run: vi.fn()}));
vi.mock('@multai/runtime', async () => ({...await vi.importActual<typeof import('@multai/runtime')>('@multai/runtime'), runAgent: runtime.run}));
vi.mock('electron', () => ({app: {getPath: () => '/tmp/multai-synthetic-coordinator'}, shell: {openExternal: vi.fn()}, safeStorage: {isEncryptionAvailable: () => true}}));

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {for (const close of cleanup.splice(0)) await close(); vi.restoreAllMocks();});
beforeEach(() => {
  runtime.run.mockReset();
  runtime.run.mockImplementation(async (options: RunAgentOptions) => {
    await options.beforeRequest?.(options.signal);
    await options.onEvent?.({type: 'text.delta', text: 'Synthetic completion'});
    return {text: 'Synthetic completion', iterations: 1};
  });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(yes => {resolve = yes;});
  return {promise, resolve};
}

async function fixture() {
  const directory = await realpath(await mkdtemp(join(tmpdir(), 'multai-coordinator-')));
  const state = {generation: 1, userId: randomUUID(), deviceId: randomUUID(), mode: 'build' as 'plan' | 'build', instruction: 'Synthetic selected instruction'};
  const input = {sessionId: randomUUID(), instructionId: randomUUID(), connectionId: randomUUID(), model: 'synthetic-model'};
  const runId = randomUUID();
  const credentials: ProviderCredentials = {kind: 'openai', apiKey: 'opaque-private-key-with-quote"and-slash\\12345'};
  const requests: {method: string; route: string; body: Record<string, unknown> | undefined; generation: number}[] = [];
  let sequence = 0;
  const respond = async (method: string, route: string, body?: unknown): Promise<unknown> => {
    const value = body as Record<string, unknown> | undefined;
    requests.push({method, route, body: value, generation: state.generation});
    if (method === 'GET') return {session: {runtimeGeneration: 1, capabilities: {manage: true}, status: 'inactive'}};
    if (route.endsWith('/runs')) return {
      run: {id: runId, sessionId: route.split('/')[3], connectionId: value?.connectionId, model: value?.model, generation: 2, mode: state.mode},
      messages: [], selectedInstruction: {id: value?.instructionId, authorId: state.userId, text: state.instruction}, decisions: [],
    };
    if (route.endsWith('/events')) return {sequence: ++sequence};
    if (route.endsWith('/actions')) return {actionId: (value?.descriptor as {requestId?: string})?.requestId, status: 'pending'};
    if (route.includes('/actions/')) {
      const status = value?.decision === 'complete' ? 'completed' : value?.decision === 'consume' ? 'consumed' : value?.decision === 'approve' ? 'approved' : 'rejected';
      return {actionId: route.split('/').at(-1), status};
    }
    if (route.endsWith('/finish')) return {status: value?.status};
    if (route.endsWith('/stop')) return {stopped: true};
    return {leaseExpiresAt: new Date(Date.now() + 30000).toISOString()};
  };
  const account = {
    origin: 'https://synthetic-collaboration.example',
    get accountGeneration() {return state.generation;},
    identitySnapshot: vi.fn(async () => ({userId: state.userId, deviceId: state.deviceId, generation: state.generation})),
    request: vi.fn(respond),
  };
  const connections = {resolve: vi.fn(async () => credentials), models: vi.fn(async () => [{id: input.model, name: 'Synthetic model'}])};
  const changes: HostRunChange[] = [];
  const confirm = vi.fn(async (_descriptor: ActionDescriptor, _hash: string, _signal: AbortSignal, _preview?: string) => true);
  const projects = new ProjectRegistry(() => join(directory, 'projects.json'));
  const host = new HostCoordinator({account, connections, projects, mcp: new McpHost(async () => []), dataDirectory: () => directory, confirm, emit: change => {changes.push(change);}});
  cleanup.push(async () => {await host.invalidate(); await rm(directory, {recursive: true, force: true});});
  const terminal = async () => {await vi.waitFor(() => expect(changes.at(-1)?.status).toMatch(/^(?:completed|failed|stopped)$/u), {timeout: 5000});};
  const scopeDirectory = async () => join(directory, 'runtime-v1', (await readdir(join(directory, 'runtime-v1')))[0]!);
  const workspace = async () => join(await scopeDirectory(), 'workspaces', input.sessionId);
  return {directory, state, input, runId, credentials, requests, respond, account, connections, changes, confirm, host, terminal, scopeDirectory, workspace, projects};
}

describe('synthetic host integration with real private workspace and SQLite journal', () => {
  test('one synchronous start slot blocks a second run and selection during asynchronous lookup', async () => {
    const x = await fixture();
    const gate = deferred<{id: string; name: string}[]>();
    x.connections.models.mockImplementationOnce(() => gate.promise);
    const first = x.host.run(x.input);
    try {
      await vi.waitFor(() => expect(x.connections.models).toHaveBeenCalledTimes(1));
      await expect(x.host.run({...x.input, sessionId: randomUUID()})).rejects.toMatchObject({code: 'SESSION_ACTIVE'});
      await expect(x.host.select({connectionId: x.input.connectionId, model: x.input.model})).rejects.toMatchObject({code: 'SESSION_ACTIVE'});
    } finally {gate.resolve([{id: x.input.model, name: 'Synthetic model'}]);}
    await first; await x.terminal();
    expect(x.requests.filter(request => request.route.endsWith('/runs'))).toHaveLength(1);
    expect(runtime.run).toHaveBeenCalledTimes(1);
    expect((runtime.run.mock.calls[0]![0] as RunAgentOptions).fetch).toBe(publicProviderFetch);
  });

  test('account switch during model lookup cannot claim, publish or dispatch as the new account', async () => {
    const x = await fixture();
    const gate = deferred<{id: string; name: string}[]>();
    x.connections.models.mockImplementationOnce(() => gate.promise);
    const starting = x.host.run(x.input).catch(error => error as Error);
    await vi.waitFor(() => expect(x.connections.models).toHaveBeenCalledTimes(1));
    x.state.generation++; x.state.userId = randomUUID(); x.state.deviceId = randomUUID();
    gate.resolve([{id: x.input.model, name: 'Synthetic model'}]);
    expect(await starting).toMatchObject({code: 'STALE_ACCOUNT'});
    // The session is read alongside the model lookup; nothing is claimed or published.
    expect(x.requests.filter(request => request.method !== 'GET')).toHaveLength(0);
    expect(runtime.run).not.toHaveBeenCalled();
  });

  test('Stop while a claim response is pending fences that exact claim and never starts a provider', async () => {
    const x = await fixture();
    const gate = deferred<void>();
    x.account.request.mockImplementation(async (method, route, body) => {
      const response = await x.respond(method, route, body);
      if (route.endsWith('/runs')) await gate.promise;
      return response;
    });
    const starting = x.host.run(x.input).catch(error => error as Error);
    await vi.waitFor(() => expect(x.requests.some(request => request.route.endsWith('/runs'))).toBe(true));
    const stop = x.host.stop(x.input.sessionId);
    gate.resolve();
    expect(await starting).toBeInstanceOf(Error); await stop;
    expect(runtime.run).not.toHaveBeenCalled();
    expect(x.requests.filter(request => request.route.endsWith('/stop'))).toEqual([expect.objectContaining({route: `/v1/sessions/${x.input.sessionId}/stop`, body: expect.objectContaining({runId: x.runId, leaseToken: expect.any(String)})})]);
    expect(x.requests.some(request => request.route.endsWith('/finish'))).toBe(false);
  });

  test('invalidation during identity lookup holds the start slot until stale work is fenced', async () => {
    const x = await fixture();
    const snapshot = {userId: x.state.userId, deviceId: x.state.deviceId, generation: x.state.generation};
    const gate = deferred<typeof snapshot>();
    x.account.identitySnapshot.mockImplementationOnce(() => gate.promise);
    const starting = x.host.run(x.input).catch(error => error as Error);
    const invalidating = x.host.invalidate();
    await expect(x.host.run(x.input)).rejects.toMatchObject({code: 'SESSION_ACTIVE'});
    gate.resolve(snapshot);
    expect(await starting).toBeInstanceOf(Error); await invalidating;
    expect(x.connections.resolve).not.toHaveBeenCalled();
    expect(runtime.run).not.toHaveBeenCalled();
  });

  test('local journal initialization happens before the server claim', async () => {
    const x = await fixture();
    await x.host.prepareWorkspace(x.input.sessionId);
    await mkdir(join(await x.scopeDirectory(), 'effects.sqlite'));
    await expect(x.host.run(x.input)).rejects.toBeInstanceOf(Error);
    expect(x.requests.some(request => request.route.endsWith('/runs'))).toBe(false);
    expect(runtime.run).not.toHaveBeenCalled();
  });

  test('claim identity mismatch is cleaned up with its own lease before provider dispatch', async () => {
    const x = await fixture();
    x.account.request.mockImplementation(async (method, route, body) => {
      const response = await x.respond(method, route, body);
      if (route.endsWith('/runs')) (response as {run: {model: string}}).run.model = 'different-model';
      return response;
    });
    await expect(x.host.run(x.input)).rejects.toMatchObject({code: 'STALE_EXECUTION'});
    expect(runtime.run).not.toHaveBeenCalled();
    expect(x.requests.filter(request => request.route.endsWith('/finish'))).toHaveLength(1);
  });

  test('exact approval gates a real write and acknowledges its effect only after shared confirmation', async () => {
    const x = await fixture();
    runtime.run.mockImplementation(async (options: RunAgentOptions) => {
      await options.beforeRequest?.(options.signal);
      const call: ToolCall = {id: 'synthetic-call', name: 'write_file', arguments: {path: 'verified.ts', content: 'export const verified = true;\n', expectedHash: null}};
      await options.executeTool!(call, options.signal);
      return {text: 'Wrote verified.ts.', iterations: 2};
    });
    await x.host.run(x.input); await x.terminal();
    expect(x.changes.at(-1)?.status).toBe('completed');
    expect(await readFile(join(await x.workspace(), 'verified.ts'), 'utf8')).toBe('export const verified = true;\n');
    expect(x.confirm).toHaveBeenCalledTimes(1);
    expect(x.confirm.mock.calls[0]?.[3]).toBe('export const verified = true;\n');
    expect(x.confirm.mock.calls[0]?.[0]).toMatchObject({operation: {kind: 'file_write', contentHash: createHash('sha256').update(x.confirm.mock.calls[0]![3]!).digest('hex')}});
    const decisions = x.requests.filter(request => request.route.includes('/actions/')).map(request => request.body?.decision);
    expect(decisions).toEqual(['approve', 'consume', 'complete']);
    await x.host.invalidate();
    const journal = new ExecutionJournal(join(await x.scopeDirectory(), 'effects.sqlite'), {serviceOrigin: x.account.origin, accountId: x.state.userId, deviceId: x.state.deviceId});
    try {expect(journal.pending()).toHaveLength(0);} finally {journal.close();}
  });

  test('rejection and Plan independently prevent native writes even with a malicious synthetic engine', async () => {
    for (const mode of ['reject', 'plan'] as const) {
      const x = await fixture();
      if (mode === 'reject') x.confirm.mockResolvedValue(false); else x.state.mode = 'plan';
      runtime.run.mockImplementation(async (options: RunAgentOptions) => {
        const result = await options.executeTool!({id: 'synthetic-call', name: 'write_file', arguments: {path: 'must-not-exist.ts', content: 'unsafe', expectedHash: null}}, options.signal);
        return {text: JSON.stringify(result), iterations: 1};
      });
      await x.host.run(x.input); await x.terminal();
      await expect(readFile(join(await x.workspace(), 'must-not-exist.ts'))).rejects.toMatchObject({code: 'ENOENT'});
      expect(x.requests.some(request => request.body?.decision === 'consume')).toBe(false);
      if (mode === 'plan') {expect(x.confirm).not.toHaveBeenCalled(); expect(x.changes.at(-1)?.status).toBe('failed');}
    }
  });

  test('oversized file writes fail before approval rather than showing an incomplete preview', async () => {
    const x = await fixture();
    runtime.run.mockImplementation(async (options: RunAgentOptions) => {
      await options.executeTool!({id: 'synthetic-oversized', name: 'write_file', arguments: {path: 'too-large.ts', content: 'x'.repeat(16001), expectedHash: null}}, options.signal);
      return {text: 'Must not reach this completion', iterations: 1};
    });
    await x.host.run(x.input); await x.terminal();
    expect(x.changes.at(-1)).toMatchObject({status: 'failed', error: {code: 'WRITE_REVIEW_LIMIT'}});
    expect(x.confirm).not.toHaveBeenCalled();
    expect(x.requests.some(request => request.route.endsWith('/actions'))).toBe(false);
    await expect(readFile(join(await x.workspace(), 'too-large.ts'))).rejects.toMatchObject({code: 'ENOENT'});
  });

  test('lost activity acknowledgement retains both durable effect and event records', async () => {
    const x = await fixture();
    x.account.request.mockImplementation(async (method, route, body) => {
      if (route.endsWith('/events') && (body as {type?: string})?.type === 'activity.completed') throw new Error('Synthetic lost acknowledgement');
      return x.respond(method, route, body);
    });
    runtime.run.mockImplementation(async (options: RunAgentOptions) => {
      await options.executeTool!({id: 'synthetic-call', name: 'write_file', arguments: {path: 'written-once.ts', content: 'once', expectedHash: null}}, options.signal);
      return {text: 'Done', iterations: 1};
    });
    await x.host.run(x.input); await x.terminal(); await x.host.invalidate();
    expect(await readFile(join(await x.workspace(), 'written-once.ts'), 'utf8')).toBe('once');
    const journal = new ExecutionJournal(join(await x.scopeDirectory(), 'effects.sqlite'), {serviceOrigin: x.account.origin, accountId: x.state.userId, deviceId: x.state.deviceId});
    try {
      const events = journal.pending();
      expect(events.some(event => event.id.startsWith('effect:'))).toBe(true);
      expect(events.some(event => (event.payload as {type?: string}).type === 'activity.completed')).toBe(true);
    } finally {journal.close();}
  });

  test('shared text redacts opaque and escaped keys across delta boundaries and obeys JSON byte bounds', async () => {
    const x = await fixture();
    const secret = x.credentials.apiKey;
    const text = `${'safe '.repeat(150)}${secret}${'\n'.repeat(10000)}`;
    runtime.run.mockImplementation(async (options: RunAgentOptions) => {
      const clock = vi.spyOn(Date, 'now');
      const started = Date.now();
      try {
        clock.mockReturnValue(started + 1100);
        await options.onEvent?.({type: 'text.delta', text: `${'safe '.repeat(150)}${secret.slice(0, 12)}`});
        clock.mockReturnValue(started + 2200);
        await options.onEvent?.({type: 'text.delta', text: `${secret.slice(12)}${'\n'.repeat(10000)}`});
      } finally {clock.mockRestore();}
      return {text, iterations: 1};
    });
    await x.host.run(x.input); await x.terminal();
    const published = x.requests.filter(request => request.route.endsWith('/events')).map(request => request.body!);
    expect(published.length).toBeGreaterThan(1);
    for (const event of published) expect(Buffer.byteLength(JSON.stringify(event.payload))).toBeLessThanOrEqual(20000);
    const shared = published.map(event => (event.payload as {text?: string}).text ?? '').join('');
    expect(shared).not.toContain(secret);
    expect(shared).not.toContain(secret.slice(0, 12));
    expect(shared).toContain('[REDACTED]');
    expect(published.find(event => event.type === 'agent.completed')?.payload).toMatchObject({truncated: true});
  });

  test('read activity shares metadata without mirroring selected file contents', async () => {
    const x = await fixture();
    runtime.run.mockImplementation(async (options: RunAgentOptions) => {
      await options.executeTool!({id: 'synthetic-list', name: 'list_files', arguments: {path: ''}}, options.signal);
      return {text: 'Listed', iterations: 1};
    });
    await x.host.run(x.input); await x.terminal();
    const activity = x.requests.find(request => request.route.endsWith('/events') && request.body?.type === 'activity.completed');
    expect(activity?.body?.payload).toMatchObject({tool: 'list_files', summary: 'Listed workspace entries', path: ''});
    expect(activity?.body?.payload).not.toHaveProperty('result');
  });
});

describe('parallel agents', () => {
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, {cwd, encoding: 'utf8', env: {...process.env, GIT_AUTHOR_NAME: 'T', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 'T', GIT_COMMITTER_EMAIL: 't@example.com'}});
  async function project(x: Awaited<ReturnType<typeof fixture>>) {
    const repo = join(x.directory, 'shop');
    await mkdir(join(repo, 'src'), {recursive: true});
    git(repo, 'init', '-q', '-b', 'main');
    await writeFile(join(repo, 'src', 'cart.js'), 'export const total = items => items.length;\n');
    git(repo, 'add', '-A'); git(repo, 'commit', '-qm', 'init');
    const registered = await x.projects.register(repo);
    const root = await x.host.prepareWorkspace(x.input.sessionId, {projectId: registered.projectId, carry: false, title: 'split'});
    return {repo, root};
  }
  const userText = (options: RunAgentOptions) => String(options.messages.at(-1)?.content ?? '');
  const write = (path: string, content: string, expectedHash: string | null = null): ToolCall => ({id: randomUUID(), name: 'write_file', arguments: {path, content, expectedHash}});
  const events = (x: Awaited<ReturnType<typeof fixture>>) => x.requests.filter(request => request.route.endsWith('/events')).map(request => request.body as {type: string; payload: Record<string, unknown>});

  test('plans with the run\'s model, builds the parts at the same time, takes turns on approvals and merges into the chat', async () => {
    const x = await fixture();
    const {root} = await project(x);
    x.state.instruction = '/split Add an API and a page';
    let building = 0, peak = 0, approving = 0, overlapping = false;
    x.confirm.mockImplementation(async () => {approving++; if (approving > 1) overlapping = true; await new Promise(resolve => setTimeout(resolve, 20)); approving--; return true;});
    const started = [deferred<void>(), deferred<void>()];
    runtime.run.mockImplementation(async (options: RunAgentOptions) => {
      if (options.system === PLAN_SYSTEM) return {text: JSON.stringify({parts: [{title: 'API', task: 'Write src/api.js', files: ['src/api.js']}, {title: 'Page', task: 'Write src/page.js', files: ['src/page.js']}]}), iterations: 1};
      const lane = Number(/You are agent (\d) of 2/u.exec(userText(options))?.[1]);
      building++; peak = Math.max(peak, building);
      started[lane - 1]!.resolve();
      await Promise.all(started.map(item => item.promise)); // neither finishes before both have started
      const file = lane === 1 ? 'src/api.js' : 'src/page.js';
      expect(options.tools?.some(tool => tool.name === 'codebase_search')).toBe(false);
      expect(await options.executeTool!(write(file, `// agent ${lane}\n`), options.signal)).toMatchObject({path: file});
      building--;
      return {text: `Agent ${lane} wrote ${file}.`, iterations: 2};
    });
    await x.host.run(x.input); await x.terminal();
    expect(x.changes.at(-1)?.status).toBe('completed');
    expect(peak).toBe(2);
    expect(overlapping).toBe(false);
    expect(x.confirm).toHaveBeenCalledTimes(2);
    expect(await readFile(join(root, 'src', 'api.js'), 'utf8')).toBe('// agent 1\n');
    expect(await readFile(join(root, 'src', 'page.js'), 'utf8')).toBe('// agent 2\n');
    const published = events(x);
    expect(published.find(event => event.payload.tool === 'split')?.payload).toMatchObject({lanes: [{index: 1, title: 'API'}, {index: 2, title: 'Page'}]});
    expect(published.filter(event => event.payload.tool === 'lane' && event.payload.state === 'done').map(event => event.payload.lane).sort()).toEqual([1, 2]);
    expect(published.some(event => event.payload.tool === 'write_file' && event.payload.lane === 1 && String(event.payload.summary).startsWith('Agent 1 · '))).toBe(true);
    const report = published.find(event => event.type === 'agent.completed')!.payload.text as string;
    expect(report).toMatch(/2 agents worked on this in parallel/u);
    expect(report).toMatch(/Agent 1 · API\*\*: merged/u);
    // The workers' worktrees are gone.
    expect(git(root, 'worktree', 'list')).not.toMatch(/\.lane-/u);
  });

  test('Stop keeps the run and lane worktrees alive until every sibling finishes unwinding', async () => {
    const x = await fixture();
    const {root} = await project(x);
    x.state.instruction = '/split Two parts';
    const started = [deferred<void>(), deferred<void>()];
    const aborted = [deferred<void>(), deferred<void>()];
    const release = deferred<void>();
    runtime.run.mockImplementation(async (options: RunAgentOptions) => {
      if (options.system === PLAN_SYSTEM) return {text: JSON.stringify({parts: [{title: 'One', task: 'a', files: []}, {title: 'Two', task: 'b', files: []}]}), iterations: 1};
      const lane = Number(/You are agent (\d) of 2/u.exec(userText(options))?.[1]);
      options.signal.addEventListener('abort', () => aborted[lane - 1]!.resolve(), {once: true});
      started[lane - 1]!.resolve();
      await aborted[lane - 1]!.promise;
      // A process/tool in the second lane takes longer to terminate than the first provider.
      if (lane === 2) await release.promise;
      options.signal.throwIfAborted();
      throw new Error('Expected Stop');
    });
    await x.host.run(x.input);
    await Promise.all(started.map(item => item.promise));
    let stopped = false;
    const stopping = x.host.stop(x.input.sessionId).then(() => {stopped = true;});
    try {
      await Promise.all(aborted.map(item => item.promise));
      await new Promise(resolve => setTimeout(resolve, 200));
      expect(stopped).toBe(false);
      expect(git(root, 'worktree', 'list').match(/\.lane-/gu)).toHaveLength(2);
      expect(x.changes.at(-1)?.status).not.toBe('stopped');
    } finally {release.resolve(); await stopping;}
    expect(x.changes.at(-1)?.status).toBe('stopped');
    expect(git(root, 'worktree', 'list')).not.toMatch(/\.lane-/u);
    expect(git(root, 'status', '--porcelain')).toBe('');
  });

  test('a part that conflicts gets one more pass in the chat\'s worktree, and a failed agent doesn\'t stop the others', async () => {
    const x = await fixture();
    const {root} = await project(x);
    x.state.instruction = '/split Change the total three ways';
    const cartHash = createHash('sha256').update('export const total = items => items.length;\n').digest('hex');
    let resolver = '';
    runtime.run.mockImplementation(async (options: RunAgentOptions) => {
      if (options.system === PLAN_SYSTEM) return {text: JSON.stringify({parts: [{title: 'One', task: 'a', files: ['src/cart.js']}, {title: 'Two', task: 'b', files: ['src/two.js']}, {title: 'Three', task: 'c', files: []}]}), iterations: 1};
      const text = userText(options);
      if (text.includes('overlap work that is already merged')) {
        resolver = text;
        const current = createHash('sha256').update('export const total = () => 1;\n').digest('hex');
        await options.executeTool!(write('src/cart.js', 'export const total = () => 12;\n', current), options.signal);
        return {text: 'Combined both.', iterations: 2};
      }
      const lane = Number(/You are agent (\d) of 3/u.exec(text)?.[1]);
      if (lane === 3) throw new Error('synthetic provider failure');
      // Agent 2 ignores its plan and edits agent 1's file too.
      await options.executeTool!(write('src/cart.js', `export const total = () => ${lane};\n`, cartHash), options.signal);
      return {text: `done ${lane}`, iterations: 1};
    });
    await x.host.run(x.input); await x.terminal();
    expect(x.changes.at(-1)?.status).toBe('completed');
    expect(resolver).toMatch(/Agent 2 \(“Two”\)/u);
    expect(resolver).toMatch(/-export const total = items => items.length;/u);
    expect(await readFile(join(root, 'src', 'cart.js'), 'utf8')).toBe('export const total = () => 12;\n');
    const published = events(x);
    expect(published.find(event => event.type === 'activity.failed' && event.payload.lane === 3)).toBeTruthy();
    const report = published.find(event => event.type === 'agent.completed')!.payload.text as string;
    expect(report).toMatch(/Agent 1 · One\*\*: merged/u);
    expect(report).toMatch(/Agent 2 · Two\*\*: merged after a final pass/u);
    expect(report).toMatch(/Agent 3 · Three\*\*: stopped/u);
  });

  test('routes "agent 2: …" to that agent and other directions to every agent', async () => {
    const x = await fixture();
    await project(x);
    x.state.instruction = '/split Two parts';
    let claimed = false;
    x.account.request.mockImplementation(async (method: string, route: string, body?: unknown) => {
      if (route.endsWith('/claim')) {
        if (claimed) return {instructions: []};
        claimed = true;
        return {instructions: [{id: randomUUID(), authorId: x.state.userId, text: 'agent 2: use cents'}, {id: randomUUID(), authorId: x.state.userId, text: 'keep it small'}]};
      }
      return x.respond(method, route, body);
    });
    const heard: Record<number, string[]> = {1: [], 2: []};
    runtime.run.mockImplementation(async (options: RunAgentOptions) => {
      if (options.system === PLAN_SYSTEM) return {text: '{"parts":[{"title":"A","task":"a","files":["a.js"]},{"title":"B","task":"b","files":["b.js"]}]}', iterations: 1};
      const lane = Number(/You are agent (\d) of 2/u.exec(userText(options))?.[1]);
      for (let i = 0; i < 3; i++) {heard[lane]!.push(...await options.steer!(options.signal)); await new Promise(resolve => setTimeout(resolve, 600));}
      return {text: 'ok', iterations: 1};
    });
    await x.host.run(x.input);
    await vi.waitFor(() => expect(x.changes.at(-1)?.status).toBe('completed'), {timeout: 10000});
    expect(heard[1]!.join('\n')).not.toMatch(/use cents/u);
    expect(heard[1]!.join('\n')).toMatch(/keep it small/u);
    expect(heard[2]!.join('\n')).toMatch(/use cents/u);
    expect(heard[2]!.join('\n')).toMatch(/keep it small/u);
  }, 15000);

  test('an agent that stops before changing its files is asked once to finish, and its summary is its last paragraph', async () => {
    const x = await fixture();
    const {root} = await project(x);
    x.state.instruction = '/split Two parts';
    const asked: string[][] = [];
    runtime.run.mockImplementation(async (options: RunAgentOptions) => {
      if (options.system === PLAN_SYSTEM) return {text: '{"parts":[{"title":"A","task":"a","files":["a.js"]},{"title":"B","task":"b","files":["b.js"]}]}', iterations: 1};
      const lane = Number(/You are agent (\d) of 2/u.exec(String(options.messages.find(message => /You are agent/u.test(String(message.content)))?.content))?.[1]);
      (asked[lane] ??= []).push(userText(options));
      if (lane === 2 && asked[2]!.length === 1) return {text: 'Reading the files first.', iterations: 1};
      await options.executeTool!(write(lane === 1 ? 'a.js' : 'b.js', `// ${lane}\n`), options.signal);
      return {text: `Step one done.\n\nWrote ${lane === 1 ? 'a.js' : 'b.js'} and checked it.`, iterations: 2};
    });
    await x.host.run(x.input); await x.terminal();
    expect(asked[1]).toHaveLength(1);
    expect(asked[2]).toHaveLength(2);
    expect(asked[2]![1]).toMatch(/Your part isn't done yet: none of b\.js changed/u);
    expect(await readFile(join(root, 'b.js'), 'utf8')).toBe('// 2\n');
    const report = events(x).find(event => event.type === 'agent.completed')!.payload.text as string;
    expect(report).toMatch(/Wrote b\.js and checked it\./u);
    expect(report).not.toMatch(/Step one done/u);
    expect(events(x).find(event => event.payload.tool === 'merge')?.payload.summary).toBe('Merged 2 agents’ work into this chat');
  });

  test('an agent that never changes its files says so instead of looking done', async () => {
    const x = await fixture();
    await project(x);
    x.state.instruction = '/split Two parts';
    runtime.run.mockImplementation(async (options: RunAgentOptions) => {
      if (options.system === PLAN_SYSTEM) return {text: '{"parts":[{"title":"A","task":"a","files":["a.js"]},{"title":"Docs","task":"b","files":["README.md"]}]}', iterations: 1};
      const lane = Number(/You are agent (\d) of 2/u.exec(String(options.messages.find(message => /You are agent/u.test(String(message.content)))?.content))?.[1]);
      if (lane === 1) await options.executeTool!(write('a.js', '// a\n'), options.signal);
      return {text: 'All done.', iterations: 1};
    });
    await x.host.run(x.input); await x.terminal();
    expect(events(x).find(event => event.payload.tool === 'lane' && event.payload.lane === 2)?.payload.summary).toBe('Agent 2 · Finished without changing README.md');
    expect(events(x).find(event => event.type === 'agent.completed')!.payload.text).toMatch(/Agent 2 · Docs\*\*: didn’t change `README\.md`/u);
  });

  test('needs a project, Build mode and a task', async () => {
    for (const [setup, code] of [['private', 'SPLIT_NEEDS_PROJECT'], ['plan', 'SPLIT_NEEDS_BUILD'], ['empty', 'SPLIT_NEEDS_TASK']] as const) {
      const x = await fixture();
      if (setup === 'private') await x.host.prepareWorkspace(x.input.sessionId); else await project(x);
      if (setup === 'plan') x.state.mode = 'plan';
      x.state.instruction = setup === 'empty' ? '/split' : '/split Build it';
      await x.host.run(x.input); await x.terminal();
      expect(x.changes.at(-1)?.status).toBe('failed');
      expect(events(x).find(event => event.type === 'activity.failed')?.payload.code).toBe(code);
      expect(runtime.run).not.toHaveBeenCalled();
      runtime.run.mockClear();
    }
  });
});

describe('team verification uses actual host checks and a separate read-only reviewer',()=>{
  const requirement=(command:string|null)=>({id:randomUUID(),text:'Never create a duplicate order',checkCommand:command,version:1,state:'approved'});
  function acceptance(x:Awaited<ReturnType<typeof fixture>>,criteria:ReturnType<typeof requirement>[]){
    x.account.request.mockImplementation(async(method,route,body)=>{
      const response=await x.respond(method,route,body);
      if(method==='GET'&&route.endsWith('/acceptance'))return {revision:null,criteria};
      if(method==='GET'&&route.endsWith('/conflict-context'))return {fingerprint:'a'.repeat(64),requiresReview:false,pending:[]};
      if(method==='GET')return {session:{runtimeGeneration:1,capabilities:{manage:true},status:'inactive',mode:x.state.mode}};
      if(route.endsWith('/runs'))return {...response as object,messages:[{role:'assistant',content:'Builder said everything passed without checking'}],decisions:[{id:randomUUID(),text:'Private builder background'}]};
      if(route.endsWith('/messages'))return {event:{payload:{messageId:x.input.instructionId}}};
      return response;
    });
  }

  test('publishes a real nonzero shell outcome and does not let reviewer prose manufacture a pass',async()=>{
    const x=await fixture(),agreed=requirement("printf 'duplicate order'; exit 7");acceptance(x,[agreed]);
    runtime.run.mockImplementation(async(options:RunAgentOptions)=>{
      await options.beforeRequest?.(options.signal);
      expect(options.messages).toHaveLength(1);const context=String(options.messages[0]!.content);
      expect(context).toContain('duplicate order');expect(context).toContain('"exitCode":7');expect(context).not.toContain('Builder said');expect(context).not.toContain('Private builder background');
      expect(options.tools?.map(tool=>tool.name).sort()).toEqual(['codebase_search','list_files','read_file','search_files']);
      await expect(Promise.resolve().then(()=>options.executeTool!({id:'malicious-write',name:'write_file',arguments:{path:'weakened.ts',content:'true',expectedHash:null}},options.signal))).rejects.toMatchObject({code:'VERIFIER_READ_ONLY'});
      await expect(Promise.resolve().then(()=>options.executeTool!({id:'malicious-command',name:'run_command',arguments:{command:'true'}},options.signal))).rejects.toMatchObject({code:'VERIFIER_READ_ONLY'});
      return {text:'Synthetic reviewer incorrectly says passed',iterations:1};
    });
    await x.host.run({...x.input,verification:true});await x.terminal();
    expect(x.changes.at(-1)?.status).toBe('completed');expect(x.confirm).toHaveBeenCalledTimes(1);expect(x.confirm.mock.calls[0]![0].operation).toMatchObject({commandText:agreed.checkCommand});
    const evidence=x.requests.filter(item=>item.route.endsWith('/acceptance/evidence'));
    expect(evidence).toHaveLength(1);expect(evidence[0]!.body).toMatchObject({criterionId:agreed.id,criterionVersion:1,kind:'command',command:agreed.checkCommand,exitCode:7,output:'duplicate order'});
    expect(evidence[0]!.body).not.toHaveProperty('status');
    expect(x.requests.findIndex(item=>item.route.endsWith('/finish'))).toBeLessThan(x.requests.findIndex(item=>item.route.endsWith('/acceptance/evidence')));
    await expect(readFile(join(await x.workspace(),'weakened.ts'))).rejects.toMatchObject({code:'ENOENT'});
  });

  test('rejecting the exact check produces no evidence even if the reviewer declares success',async()=>{
    const x=await fixture();acceptance(x,[requirement("printf 'must not execute' > forbidden.txt")]);x.confirm.mockResolvedValue(false);
    runtime.run.mockResolvedValue({text:'All passed',iterations:1});await x.host.run({...x.input,verification:true});await x.terminal();
    expect(x.changes.at(-1)?.status).toBe('completed');expect(x.requests.filter(item=>item.route.endsWith('/acceptance/evidence'))).toHaveLength(0);
    await expect(readFile(join(await x.workspace(),'forbidden.txt'))).rejects.toMatchObject({code:'ENOENT'});
    expect(x.requests.some(item=>item.body?.decision==='consume')).toBe(false);
  });

  test('a real check that modifies source cannot publish a successful verdict for its old source',async()=>{
    const x=await fixture();acceptance(x,[requirement("printf 'changed' > cart.ts")]);await x.host.prepareWorkspace(x.input.sessionId);await writeFile(join(await x.workspace(),'cart.ts'),'before');
    await x.host.run({...x.input,verification:true});await x.terminal();
    expect(await readFile(join(await x.workspace(),'cart.ts'),'utf8')).toBe('changed');expect(x.requests.filter(item=>item.route.endsWith('/acceptance/evidence'))).toHaveLength(0);
    expect(String((runtime.run.mock.calls[0]![0] as RunAgentOptions).messages[0]!.content)).toContain('source changed during the check');
  });

  test('Stop during independent review prevents late proof publication',async()=>{
    const x=await fixture();acceptance(x,[requirement("printf 'checked'")]);const entered=deferred<void>(),release=deferred<void>();
    runtime.run.mockImplementation(async()=>{entered.resolve();await release.promise;return {text:'Late review',iterations:1};});
    await x.host.run({...x.input,verification:true});await entered.promise;
    const stopping=x.host.stop(x.input.sessionId);release.resolve();await stopping;await x.terminal();
    expect(x.requests.filter(item=>item.route.endsWith('/acceptance/evidence'))).toHaveLength(0);expect(x.changes.at(-1)?.status).toBe('stopped');
  });

  test('explicit verification refuses pending team directions before posting or executing',async()=>{
    const x=await fixture();acceptance(x,[requirement('true')]);
    const base=x.account.request.getMockImplementation()!;
    x.account.request.mockImplementation(async(method,route,body)=>{
      if(route.endsWith('/conflict-context')){await x.respond(method,route,body);return {fingerprint:'a'.repeat(64),requiresReview:false,pending:[{id:randomUUID(),authorId:x.state.userId,authorName:'Host',text:'Still building',revision:1}]};}
      return base(method,route,body);
    });
    await expect(x.host.verify({sessionId:x.input.sessionId,connectionId:x.input.connectionId,model:x.input.model})).rejects.toMatchObject({code:'VERIFICATION_PENDING'});
    expect(x.requests.filter(item=>item.method!=='GET')).toHaveLength(0);expect(runtime.run).not.toHaveBeenCalled();expect(x.confirm).not.toHaveBeenCalled();
  });

  test('idle revision synchronization reads actual source without a model or shell',async()=>{
    const x=await fixture();acceptance(x,[requirement(null)]);await x.host.prepareWorkspace(x.input.sessionId);const root=await x.workspace();await writeFile(join(root,'cart.ts'),'first');
    const before=await x.host.syncVerification(x.input.sessionId);expect(before.revision).toMatch(/^[a-f0-9]{64}$/u);
    await writeFile(join(root,'cart.ts'),'second');const after=await x.host.syncVerification(x.input.sessionId);expect(after.revision).not.toBe(before.revision);
    expect(runtime.run).not.toHaveBeenCalled();expect(x.confirm).not.toHaveBeenCalled();expect(x.requests.some(item=>item.route.endsWith('/runs'))).toBe(false);
  });
  test('a requirement revised, withdrawn or replaced after claim cannot execute an outdated command',async()=>{
    for(const replacement of [{version:2},{state:'withdrawn'},{checkCommand:'replacement command'}]){
      const x=await fixture(),original=requirement("printf 'obsolete' > forbidden.txt");acceptance(x,[original]);
      const base=x.account.request.getMockImplementation()!;let reads=0;
      x.account.request.mockImplementation(async(method,route,body)=>{
        const response=await base(method,route,body);
        if(method==='GET'&&route.endsWith('/acceptance')&&++reads>1)return {revision:null,criteria:[{...original,...replacement}]};
        return response;
      });
      await x.host.run({...x.input,verification:true});await x.terminal();
      expect(x.changes.at(-1)).toMatchObject({status:'failed',error:{code:'VERIFICATION_CHANGED'}});
      expect(x.confirm).not.toHaveBeenCalled();expect(x.requests.some(item=>item.route.endsWith('/actions'))).toBe(false);expect(x.requests.some(item=>item.route.endsWith('/acceptance/evidence'))).toBe(false);
      await expect(readFile(join(await x.workspace(),'forbidden.txt'))).rejects.toMatchObject({code:'ENOENT'});
    }
    expect(runtime.run).not.toHaveBeenCalled();
  });

  test('unavailable verification model or credentials leave no orphan pending instruction',async()=>{
    for(const unavailable of ['model','credentials'] as const){
      const x=await fixture();acceptance(x,[requirement('true')]);
      if(unavailable==='model')x.connections.models.mockResolvedValue([]);else x.connections.resolve.mockRejectedValue(new Error('Synthetic credential unavailable'));
      await expect(x.host.verify({sessionId:x.input.sessionId,connectionId:x.input.connectionId,model:x.input.model})).rejects.toBeDefined();
      expect(x.requests.filter(item=>item.method!=='GET')).toHaveLength(0);expect(x.confirm).not.toHaveBeenCalled();
    }
    expect(runtime.run).not.toHaveBeenCalled();
  });

  test('provider reviewer outage preserves actual check evidence and makes no AI review claim',async()=>{
    const x=await fixture(),agreed=requirement("printf 'real fixture result'; exit 3");acceptance(x,[agreed]);
    runtime.run.mockRejectedValue(new Error('Synthetic provider timeout containing private error details'));
    await x.host.run({...x.input,verification:true});await x.terminal();
    expect(x.changes.at(-1)?.status).toBe('completed');
    const evidence=x.requests.filter(item=>item.route.endsWith('/acceptance/evidence'));
    expect(evidence).toHaveLength(1);expect(evidence[0]!.body).toMatchObject({criterionId:agreed.id,kind:'command',exitCode:3,output:'real fixture result'});
    const shared=x.requests.filter(item=>item.route.endsWith('/events')).map(item=>item.body);
    expect(shared.some(item=>item?.type==='activity.failed')).toBe(true);
    expect(JSON.stringify(shared)).toContain('No AI review is claimed');expect(JSON.stringify(shared)).not.toContain('private error details');
  });

});
