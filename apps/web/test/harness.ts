// Shared by the browser and Android end-to-end runs: a real service process on a disposable database,
// synthetic identities, and the desktop's real RemoteControlHost + ApprovalBroker acting as the original
// host with a synthetic agent (no model provider is contacted).
import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import type {ActionDescriptor} from '@multai/runtime';
import {ApprovalBroker} from '../../desktop/electron/inference/approvals.ts';
import {RemoteControlHost, type TrustedPhone} from '../../desktop/electron/service/remote-control.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
export const repo = path.resolve(here, '../../..');
export const PORT = Number(process.env.E2E_PORT ?? 4319), ORIGIN = `http://127.0.0.1:${PORT}`;
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
export const secret = () => randomBytes(32).toString('base64url');
export const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
void assert;


export const base = process.env.TEST_DATABASE_URL;
if (!base) throw new Error('Set TEST_DATABASE_URL to a disposable PostgreSQL.');
export const dbName = `multai_e2e_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
export const admin = new pg.Pool({connectionString: base, max: 1});
await admin.query(`CREATE DATABASE ${dbName}`);
const url = new URL(base); url.pathname = `/${dbName}`;
export const db = new pg.Pool({connectionString: url.toString(), max: 4});
let service: ChildProcess | undefined;
export async function startService(environment: 'test' | 'development' = 'test') {
  service = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {cwd: path.join(repo, 'apps/backend'), stdio: ['ignore', 'ignore', 'pipe'],
    env: {...process.env, NODE_ENV: environment, HOST: '127.0.0.1', PORT: String(PORT), DATABASE_URL: url.toString(), PUBLIC_ORIGIN: ORIGIN, COMPANION_DIR: path.join(repo, 'apps/web/dist'), COMPANION_APP_ORIGINS: 'https://localhost'}});
  service.stderr?.on('data', chunk => process.stderr.write(`[service] ${chunk}`));
  for (let i = 0; i < 100; i++) {
    try {if ((await fetch(`${ORIGIN}/health/ready`)).ok) return;} catch {/* starting */}
    await wait(200);
  }
  throw new Error('Service did not start.');
}

export async function seedUser(name: string) {
  const user = {userId: randomUUID(), deviceId: randomUUID(), authSessionId: randomUUID(), token: secret(), refresh: secret()};
  await db.query('INSERT INTO users (id,google_sub,display_name) VALUES ($1,$2,$3)', [user.userId, `synthetic-${randomUUID()}`, name]);
  await db.query('INSERT INTO workspaces (id,owner_id,name) VALUES ($1,$2,$3)', [randomUUID(), user.userId, `${name} workspace`]);
  await db.query('INSERT INTO devices (id,user_id,name) VALUES ($1,$2,$3)', [user.deviceId, user.userId, `${name} device`]);
  await db.query("INSERT INTO auth_sessions (id,user_id,device_id,expires_at) VALUES ($1,$2,$3,now()+interval '30 days')", [user.authSessionId, user.userId, user.deviceId]);
  await db.query("INSERT INTO access_tokens (token_hash,auth_session_id,expires_at) VALUES ($1,$2,now()+interval '1 hour')", [sha(user.token), user.authSessionId]);
  await db.query("INSERT INTO refresh_tokens (token_hash,auth_session_id,expires_at) VALUES ($1,$2,now()+interval '30 days')", [sha(user.refresh), user.authSessionId]);
  return user;
}
export type User = Awaited<ReturnType<typeof seedUser>>;
export async function call<T = Record<string, any>>(user: User | null, method: string, route: string, body?: unknown): Promise<T> {
  const response = await fetch(`${ORIGIN}${route}`, {method, headers: {...(user ? {authorization: `Bearer ${user.token}`} : {}), ...(body === undefined ? {} : {'content-type': 'application/json'})}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {const error = new Error(`${method} ${route} → ${response.status} ${text}`) as Error & {code?: string}; error.code = data?.error?.code; throw error;}
  return data as T;
}


export function desktop(host: User) {
  const approvals = new ApprovalBroker(() => undefined);
  const runs = new Map<string, {id: string; lease: string; controller: AbortController; heartbeat: NodeJS.Timeout}>();
  const decided: {id: string; approved: boolean}[] = [];
  let trusted: TrustedPhone[] = [];
  const finish = async (sessionId: string, status: 'completed' | 'failed') => {
    const run = runs.get(sessionId); if (!run) return;
    clearInterval(run.heartbeat); runs.delete(sessionId);
    await call(host, 'POST', `/v1/sessions/${sessionId}/runs/${run.id}/finish`, {leaseToken: run.lease, status}).catch(() => undefined);
    remote.runChanged({sessionId, status});
  };
  const coordinator = {
    async run(input: {sessionId: string; instructionId: string; connectionId: string; model: string; resolution?: string; resolutionFingerprint?: string}) {
      const session = await call(host, 'GET', `/v1/sessions/${input.sessionId}`);
      const lease = secret();
      const started = await call(host, 'POST', `/v1/sessions/${input.sessionId}/runs`, {requestId: randomUUID(), connectionId: input.connectionId, model: input.model, instructionId: input.instructionId, leaseToken: lease, expectedGeneration: session.session.runtimeGeneration, ...(input.resolution ? {resolution: input.resolution, resolutionFingerprint: input.resolutionFingerprint} : {})});
      const controller = new AbortController();
      const run = {id: started.run.id as string, lease, controller, heartbeat: setInterval(() => void call(host, 'POST', `/v1/sessions/${input.sessionId}/runs/${started.run.id}/heartbeat`, {leaseToken: lease}).catch(() => undefined), 8_000)};
      runs.set(input.sessionId, run);
      remote.runChanged({sessionId: input.sessionId, status: 'running'});
      // The synthetic agent asks to run one command, exactly as the real coordinator does.
      void (async () => {
        const descriptor: ActionDescriptor = {version: 1, requestId: randomUUID(), sessionId: input.sessionId, originalOwnerId: host.userId, originalDeviceId: host.deviceId, accountGeneration: 1, sessionGeneration: started.run.generation, runtimeGeneration: started.run.generation, connectionId: input.connectionId, payerId: host.userId, resourceIdentity: `workspace:${input.sessionId}`, cwd: '/private/synthetic-e2e', expiresAt: Date.now() + 120_000, operation: {kind: 'shell', executable: '/bin/sh', argv: ['-c', 'npm test'], commandText: 'npm test'}};
        const requested = await call(host, 'POST', `/v1/sessions/${input.sessionId}/runs/${run.id}/actions`, {leaseToken: lease, descriptor});
        const approved = await approvals.request(descriptor, controller.signal, undefined, requested.fingerprint);
        decided.push({id: descriptor.requestId, approved});
        if (controller.signal.aborted) return;
        await call(host, 'POST', `/v1/sessions/${input.sessionId}/runs/${run.id}/actions/${descriptor.requestId}`, {leaseToken: lease, fingerprint: requested.fingerprint, decision: approved ? 'approve' : 'reject'});
        if (approved) {
          await call(host, 'POST', `/v1/sessions/${input.sessionId}/runs/${run.id}/actions/${descriptor.requestId}`, {leaseToken: lease, fingerprint: requested.fingerprint, decision: 'consume'});
          await call(host, 'POST', `/v1/sessions/${input.sessionId}/runs/${run.id}/actions/${descriptor.requestId}`, {leaseToken: lease, fingerprint: requested.fingerprint, decision: 'complete'});
          await call(host, 'POST', `/v1/sessions/${input.sessionId}/runs/${run.id}/events`, {leaseToken: lease, eventId: randomUUID(), type: 'agent.completed', payload: {text: 'Synthetic agent: tests pass after the fix.'}});
        }
        await finish(input.sessionId, approved ? 'completed' : 'failed');
      })().catch(error => process.stderr.write(`[desktop] ${error}\n`));
      return {runId: run.id};
    },
    async stop(sessionId: string) {
      const run = runs.get(sessionId);
      run?.controller.abort();
      if (run) clearInterval(run.heartbeat);
      runs.delete(sessionId);
      await call(host, 'POST', `/v1/sessions/${sessionId}/stop`);
      remote.runChanged({sessionId, status: 'stopped'});
      return null;
    },
    conflictContext: (sessionId: string) => call<{fingerprint: string; requiresReview: boolean; pending: {id: string; authorId: string; authorName: string; text: string; revision: number}[]}>(host, 'GET', `/v1/sessions/${sessionId}/conflict-context`),
    selection: async () => ({connectionId: randomUUID(), model: 'synthetic-e2e-model'}),
    lockedActions: async () => [],
  };
  const remote = new RemoteControlHost({request: (method, route, body) => call(host, method, route, body), accountGeneration: () => 1, identity: async () => ({userId: host.userId, deviceId: host.deviceId}),
    trust: () => ({load: async () => trusted, save: async value => {trusted = value;}}), coordinator: coordinator as never, approvals});
  return {remote, approvals, decided, trusted: () => trusted};
}


export async function stopService() {
  service?.kill('SIGTERM');
  await wait(500);
  await db.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => undefined);
  await admin.end();
}

/** A host session in Build mode with one pending instruction from the host. */
export async function hostSession(host: User, title: string, instruction = 'Fix the double-charge bug in checkout.') {
  const created = await call(host, 'POST', '/v1/sessions', {requestId: randomUUID(), title, message: {kind: 'instruction', text: instruction}});
  await call(host, 'PATCH', `/v1/sessions/${created.session.id}/mode`, {mode: 'build', expectedGeneration: created.session.runtimeGeneration});
  return created.session.id as string;
}
