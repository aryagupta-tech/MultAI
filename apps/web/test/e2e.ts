// End-to-end: a real backend process on a disposable PostgreSQL, the desktop's real RemoteControlHost
// and ApprovalBroker acting as the original host (with a synthetic agent instead of a model), and real
// browsers emulating phones: Chromium as Android Chrome (Pixel 7) and WebKit as iPhone Safari (iPhone 15).
// Identities are synthetic and seeded directly; no Google or model provider is contacted.
//
//   TEST_DATABASE_URL=postgresql://… node --import tsx apps/web/test/e2e.ts [--only=chromium|webkit]
import assert from 'node:assert/strict';
import {spawn, type ChildProcess} from 'node:child_process';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import pg from 'pg';
import {chromium, devices, webkit, type Browser, type BrowserContext, type Page} from 'playwright';
import type {ActionDescriptor} from '@multai/runtime';
import {ApprovalBroker} from '../../desktop/electron/inference/approvals.ts';
import {RemoteControlHost, type TrustedPhone} from '../../desktop/electron/service/remote-control.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, '../../..');
const PORT = 4319, ORIGIN = `http://127.0.0.1:${PORT}`;
const shots = path.join(process.env.E2E_SHOTS ?? path.join(repo, 'apps/web/test/screenshots'));
mkdirSync(shots, {recursive: true});
const only = process.argv.find(arg => arg.startsWith('--only='))?.slice(7);
const results: {name: string; ok: boolean; detail?: string}[] = [];
const sha = (value: string) => createHash('sha256').update(value).digest('hex');
const secret = () => randomBytes(32).toString('base64url');
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// ---------------------------------------------------------------- Service and database

const base = process.env.TEST_DATABASE_URL;
if (!base) throw new Error('Set TEST_DATABASE_URL to a disposable PostgreSQL.');
const dbName = `multai_e2e_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const admin = new pg.Pool({connectionString: base, max: 1});
await admin.query(`CREATE DATABASE ${dbName}`);
const url = new URL(base); url.pathname = `/${dbName}`;
const db = new pg.Pool({connectionString: url.toString(), max: 4});
let service: ChildProcess | undefined;
async function startService() {
  service = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {cwd: path.join(repo, 'apps/backend'), stdio: ['ignore', 'ignore', 'pipe'],
    env: {...process.env, NODE_ENV: 'test', HOST: '127.0.0.1', PORT: String(PORT), DATABASE_URL: url.toString(), PUBLIC_ORIGIN: ORIGIN, COMPANION_DIR: path.join(repo, 'apps/web/dist'), COMPANION_APP_ORIGINS: 'https://localhost'}});
  service.stderr?.on('data', chunk => process.stderr.write(`[service] ${chunk}`));
  for (let i = 0; i < 100; i++) {
    try {if ((await fetch(`${ORIGIN}/health/ready`)).ok) return;} catch {/* starting */}
    await wait(200);
  }
  throw new Error('Service did not start.');
}

async function seedUser(name: string) {
  const user = {userId: randomUUID(), deviceId: randomUUID(), authSessionId: randomUUID(), token: secret(), refresh: secret()};
  await db.query('INSERT INTO users (id,google_sub,display_name) VALUES ($1,$2,$3)', [user.userId, `synthetic-${randomUUID()}`, name]);
  await db.query('INSERT INTO workspaces (id,owner_id,name) VALUES ($1,$2,$3)', [randomUUID(), user.userId, `${name} workspace`]);
  await db.query('INSERT INTO devices (id,user_id,name) VALUES ($1,$2,$3)', [user.deviceId, user.userId, `${name} device`]);
  await db.query("INSERT INTO auth_sessions (id,user_id,device_id,expires_at) VALUES ($1,$2,$3,now()+interval '30 days')", [user.authSessionId, user.userId, user.deviceId]);
  await db.query("INSERT INTO access_tokens (token_hash,auth_session_id,expires_at) VALUES ($1,$2,now()+interval '1 hour')", [sha(user.token), user.authSessionId]);
  await db.query("INSERT INTO refresh_tokens (token_hash,auth_session_id,expires_at) VALUES ($1,$2,now()+interval '30 days')", [sha(user.refresh), user.authSessionId]);
  return user;
}
type User = Awaited<ReturnType<typeof seedUser>>;
async function call<T = Record<string, any>>(user: User | null, method: string, route: string, body?: unknown): Promise<T> {
  const response = await fetch(`${ORIGIN}${route}`, {method, headers: {...(user ? {authorization: `Bearer ${user.token}`} : {}), ...(body === undefined ? {} : {'content-type': 'application/json'})}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  const text = await response.text();
  const data = text ? JSON.parse(text) : null;
  if (!response.ok) {const error = new Error(`${method} ${route} → ${response.status} ${text}`) as Error & {code?: string}; error.code = data?.error?.code; throw error;}
  return data as T;
}

// ---------------------------------------------------------------- The desktop host (synthetic agent)

function desktop(host: User) {
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

// ---------------------------------------------------------------- Browser helpers

const tiny = `data:image/png;base64,${Buffer.from('89504e470d0a1a0a0000000d49484452000000c8000000960806000000' + '0'.repeat(10), 'hex').toString('base64')}`;
async function screenshotData(): Promise<string> {
  // A real 200×150 PNG drawn by the browser, small enough for the 110 kB share limit.
  const page = await (await chromium.launch()).newPage();
  const data = await page.evaluate(() => {const canvas = document.createElement('canvas'); canvas.width = 200; canvas.height = 150; const g = canvas.getContext('2d')!; g.fillStyle = '#fff'; g.fillRect(0, 0, 200, 150); g.fillStyle = '#000'; g.fillRect(20, 20, 160, 30); g.fillStyle = '#c00'; g.fillRect(60, 90, 80, 30); return canvas.toDataURL('image/png');});
  await page.context().browser()?.close();
  return data;
}
void tiny;

async function noHorizontalOverflow(page: Page, label: string) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
  assert.ok(overflow <= 1, `${label}: page scrolls sideways by ${overflow}px`);
}
// WebKit screenshots make Playwright inject a stylesheet, which the page's CSP (rightly) refuses. That
// console line is the harness's own; console output is not counted while a screenshot is taken.
let capturing = false;
async function snap(page: Page, name: string) {
  capturing = true;
  try {await page.screenshot({path: path.join(shots, `${name}.png`), fullPage: false, caret: 'initial'}); await wait(50);}
  finally {capturing = false;}
}
async function step(name: string, work: () => Promise<void>) {
  const started = Date.now();
  try {await work(); results.push({name, ok: true}); process.stdout.write(`✔ ${name} (${Date.now() - started} ms)\n`);}
  catch (error) {results.push({name, ok: false, detail: String(error)}); process.stdout.write(`✖ ${name}\n  ${String(error).split('\n').slice(0, 6).join('\n  ')}\n`);}
}

// ---------------------------------------------------------------- Scenarios

async function scenario(engine: 'chromium' | 'webkit') {
  const profile = engine === 'chromium' ? devices['Pixel 7'] : devices['iPhone 15'];
  const label = engine === 'chromium' ? 'Android Chrome (Pixel 7, emulated)' : 'iPhone Safari (iPhone 15, WebKit emulated)';
  const browser: Browser = await (engine === 'chromium' ? chromium : webkit).launch();
  const host = await seedUser('E2E host');
  const teammate = await seedUser('E2E teammate');
  const {remote, approvals, decided} = desktop(host);
  await remote.start();
  const created = await call(host, 'POST', '/v1/sessions', {requestId: randomUUID(), title: `Checkout fix (${engine})`, message: {kind: 'instruction', text: 'Fix the double-charge bug in checkout.'}});
  const sessionId = created.session.id as string;
  await call(host, 'PATCH', `/v1/sessions/${sessionId}/mode`, {mode: 'build', expectedGeneration: created.session.runtimeGeneration});
  const errors: string[] = [];
  const watch = (page: Page) => {
    page.on('pageerror', error => errors.push(`pageerror: ${error.message}`));
    page.on('console', message => {if (message.type() === 'error' && !capturing && !/Failed to load resource|net::ERR_INTERNET_DISCONNECTED|NetworkError|Load failed|status of 4\d\d/u.test(message.text())) errors.push(`console: ${message.text()} @ ${message.location().url}:${message.location().lineNumber}`);});
    page.on('dialog', dialog => {errors.push(`dialog: ${dialog.message()}`); void dialog.dismiss();});
  };
  const owner: BrowserContext = await browser.newContext({...profile});
  const phone = await owner.newPage(); watch(phone);

  await step(`${label}: companion is served with a strict CSP and loads`, async () => {
    const response = await phone.goto(`${ORIGIN}/app/`);
    assert.equal(response?.status(), 200);
    assert.match(response!.headers()['content-security-policy'] ?? '', /script-src 'self'/u);
    await phone.getByRole('heading', {name: 'Companion'}).waitFor();
    await noHorizontalOverflow(phone, 'home');
    await snap(phone, `${engine}-home`);
  });

  let pairingId = '';
  await step(`${label}: desktop-initiated pairing with matching check digits`, async () => {
    const offer = await remote.createPairing([sessionId], 86_400);
    pairingId = offer.id;
    await phone.goto(`${ORIGIN}/app/#pair=${offer.code.replaceAll('-', '')}`);
    // Opened from the home screen this is an in-page hash change; it is handled, then removed.
    await phone.waitForFunction(() => location.hash === '', undefined, {timeout: 5_000});
    await phone.getByRole('button', {name: 'Pair this phone'}).click();
    const sas = await phone.locator('.c-sas').textContent({timeout: 10_000});
    const review = await remote.reviewPairing(offer.id);
    assert.equal(review.status, 'awaiting_confirmation');
    assert.equal(review.verificationCode, sas, 'desktop and phone show the same six digits');
    await snap(phone, `${engine}-pair-check`);
    await remote.confirmPairing(offer.id, [sessionId]);
    await phone.getByRole('heading', {name: 'Owner control'}).waitFor({timeout: 10_000});
    const cookies = await owner.cookies();
    const controllerCookie = cookies.find(cookie => cookie.name === 'multai_controller');
    assert.ok(controllerCookie?.httpOnly, 'the owner credential is an HttpOnly cookie');
    assert.equal(controllerCookie?.sameSite, 'Strict');
    assert.equal(await phone.evaluate(() => document.cookie.includes('multai_controller')), false, 'page script cannot read it');
    assert.equal(await phone.evaluate(() => Object.keys(localStorage).some(key => /credential/u.test(localStorage.getItem(key) ?? ''))), false);
  });

  await step(`${label}: start the selected instruction and approve the exact command`, async () => {
    await phone.getByRole('button', {name: /Checkout fix/u}).click();
    await phone.getByText('Fix the double-charge bug in checkout.').waitFor();
    await phone.getByText('Desktop online', {exact: false}).first().waitFor({timeout: 20_000});
    await phone.getByRole('radio').first().check();
    await phone.getByRole('button', {name: 'Start selected'}).click();
    await phone.getByRole('alertdialog').getByRole('button', {name: 'Confirm'}).click();
    await phone.getByText('Waiting for your approval').waitFor({timeout: 20_000});
    await phone.locator('pre[aria-label="Exact command"]', {hasText: 'npm test'}).waitFor();
    await snap(phone, `${engine}-approval`);
    await noHorizontalOverflow(phone, 'approval');
    await phone.getByRole('button', {name: 'Approve'}).waitFor();
    await phone.waitForFunction(() => !document.querySelector('.c-approval .c-btn-primary')?.hasAttribute('disabled'), undefined, {timeout: 20_000});
    await phone.getByRole('button', {name: 'Approve'}).click();
    await phone.getByText('The desktop did it').first().waitFor({timeout: 20_000});
    await phone.getByText('Run completed', {exact: false}).first().waitFor({timeout: 20_000});
    assert.equal(decided.at(-1)?.approved, true, 'the desktop approved exactly once');
    const acknowledged = await db.query("SELECT payload FROM shared_events WHERE session_id=$1 AND type='control.acknowledged' ORDER BY sequence", [sessionId]);
    assert.deepEqual(acknowledged.rows.map(row => [row.payload.kind, row.payload.outcome]), [['start', 'accepted'], ['approve', 'accepted']]);
    await snap(phone, `${engine}-completed`);
  });

  await step(`${label}: reload and resume keep the pairing; old requests stay answered`, async () => {
    await phone.reload();
    await phone.getByRole('button', {name: 'Owner control', exact: true}).click();
    await phone.getByRole('button', {name: /Checkout fix/u}).click();
    await phone.getByText('The desktop did it').first().waitFor({timeout: 10_000});
  });

  await step(`${label}: Stop cancels execution and its waiting approval`, async () => {
    await call(host, 'POST', `/v1/sessions/${sessionId}/messages`, {requestId: randomUUID(), kind: 'instruction', text: 'Also add a regression test.'});
    await phone.getByText('Also add a regression test.').waitFor({timeout: 10_000});
    await phone.getByRole('radio').first().check();
    await phone.getByRole('button', {name: 'Start selected'}).click();
    await phone.getByRole('alertdialog').getByRole('button', {name: 'Confirm'}).click();
    await phone.getByText('Waiting for your approval').waitFor({timeout: 20_000});
    assert.equal(approvals.list().length, 1);
    await phone.getByRole('button', {name: 'Stop', exact: true}).click();
    await phone.getByRole('alertdialog').getByRole('button', {name: 'Confirm'}).click();
    await phone.getByText('Waiting for your approval').waitFor({state: 'detached', timeout: 20_000});
    assert.equal(approvals.list().length, 0, 'the waiting approval is gone with the run');
    assert.equal(decided.at(-1)?.approved, false, 'nothing was approved after Stop');
    await phone.getByText('Stopped', {exact: false}).first().waitFor({timeout: 20_000});
  });

  await step(`${label}: an open owner screen stays within a shared home-IP request budget`, async () => {
    let count = 0;
    const counter = (request: {url(): string}) => {if (request.url().includes('/v1/')) count++;};
    phone.on('request', counter);
    await wait(30_000);
    phone.off('request', counter);
    const perMinute = count * 2;
    process.stdout.write(`  phone requests while idle on the owner screen: ${perMinute}/min\n`);
    assert.ok(perMinute <= 40, `${perMinute} requests per minute`);
  });

  await step(`${label}: offline shows plainly and nothing runs late`, async () => {
    await owner.setOffline(true);
    await phone.getByText('You’re offline').waitFor({timeout: 10_000});
    await snap(phone, `${engine}-offline`);
    await owner.setOffline(false);
    await phone.getByText('You’re offline').waitFor({state: 'detached', timeout: 15_000});
  });

  await step(`${label}: desktop asleep or gone is shown as offline`, async () => {
    await remote.suspend();
    await phone.getByText('Desktop is asleep').first().waitFor({timeout: 15_000});
    await remote.resume();
    await phone.getByText('Desktop online', {exact: false}).first().waitFor({timeout: 20_000});
  });

  await step(`${label}: rotation keeps the layout usable`, async () => {
    const size = profile.viewport;
    await phone.setViewportSize({width: size.height, height: size.width});
    await noHorizontalOverflow(phone, 'landscape');
    await snap(phone, `${engine}-landscape`);
    await phone.setViewportSize(size);
  });

  await step(`${label}: revoking on the desktop ends owner control immediately`, async () => {
    await remote.revokePairing(pairingId);
    await phone.getByText('This phone was removed on the desktop', {exact: false}).waitFor({timeout: 20_000});
    const status = await phone.evaluate(async () => (await fetch('/v1/controller/status', {headers: {'x-multai-client': 'web'}, credentials: 'same-origin'})).status);
    assert.equal(status, 403);
  });
  await owner.close();

  // A teammate signed in with Google (synthetic): the refresh token is an HttpOnly cookie, as after a real sign-in.
  const collaboration = await browser.newContext({...profile});
  await collaboration.addCookies([{name: 'multai_web_refresh', value: teammate.refresh, url: `${ORIGIN}/v1/web/auth`, httpOnly: true, sameSite: 'Strict'}]);
  const invitation = await call(host, 'POST', `/v1/sessions/${sessionId}/invitations`, {expiresInSeconds: 3600});
  const join = await call(teammate, 'POST', '/v1/invitations/join', {token: invitation.invitation.token});
  await call(host, 'POST', `/v1/sessions/${sessionId}/join-requests/${join.requestId}/admit`, {role: 'collaborator'});
  const shot = await screenshotData();
  const shared = await call(host, 'POST', `/v1/sessions/${sessionId}/reviewer-screenshots`, {image: shot, label: 'Checkout total'});
  const mate = await collaboration.newPage(); watch(mate);

  await step(`${label}: a collaborator sees the session, cannot control it, and XSS stays text`, async () => {
    await mate.goto(`${ORIGIN}/app/`);
    await mate.getByText('Signed in as', {exact: false}).waitFor({timeout: 10_000});
    await mate.getByRole('button', {name: 'Open sessions'}).click();
    await mate.getByRole('button', {name: /Checkout fix/u}).click();
    await mate.getByText('Fix the double-charge bug in checkout.').waitFor();
    const xss = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    await mate.getByLabel('Message to the team').fill(xss);
    await mate.getByRole('button', {name: 'Send'}).click();
    await mate.getByText(xss).waitFor({timeout: 10_000});
    assert.equal(await mate.locator('img[src="x"]').count(), 0);
    assert.equal(await mate.getByRole('button', {name: 'Approve'}).count(), 0, 'no owner controls for a collaborator');
    const denied = await mate.evaluate(async id => (await fetch(`/v1/controller/sessions/${id}`, {headers: {'x-multai-client': 'web'}})).status, sessionId);
    assert.equal(denied, 403);
    await noHorizontalOverflow(mate, 'session');
    await snap(mate, `${engine}-collaborator`);
  });

  await step(`${label}: phone keyboard does not hide the composer`, async () => {
    const box = await mate.getByLabel('Message to the team').boundingBox();
    assert.ok(box && box.y + box.height <= (mate.viewportSize()?.height ?? 0) + 1, 'composer is on screen');
  });

  await step(`${label}: mark a problem region on a shared screenshot`, async () => {
    await mate.getByRole('tab', {name: /Screenshots/u}).click();
    const frame = mate.locator('.c-shot-frame').first();
    await frame.waitFor();
    const box = (await frame.boundingBox())!;
    await mate.mouse.move(box.x + box.width * 0.3, box.y + box.height * 0.6);
    await mate.mouse.down();
    await mate.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.8, {steps: 5});
    // Dragging past the edge is clamped to the image.
    await mate.mouse.move(box.x + box.width * 1.5, box.y + box.height * 1.5, {steps: 3});
    await mate.mouse.up();
    await mate.getByLabel('What’s wrong here?').fill('The red total overlaps the button.');
    await mate.getByRole('button', {name: 'Send marked feedback'}).click();
    await mate.getByRole('button', {name: 'Send marked feedback'}).isDisabled();
    let row;
    for (let i = 0; i < 40 && !row; i++) {row = (await db.query("SELECT payload FROM shared_events WHERE session_id=$1 AND type='reviewer.comment' AND actor_id IS NOT NULL", [sessionId])).rows[0]; if (!row) await wait(250);}
    assert.ok(row, 'the comment was stored');
    const region = row.payload.region;
    assert.equal(row.payload.screenshotId, shared.id);
    assert.ok(region.x >= 0 && region.y >= 0 && region.x + region.width <= 1.000001 && region.y + region.height <= 1.000001, `region in bounds: ${JSON.stringify(region)}`);
    assert.ok(Math.abs(region.x - 0.3) < 0.05 && Math.abs(region.y - 0.6) < 0.05, `region starts where dragged: ${JSON.stringify(region)}`);
    await snap(mate, `${engine}-screenshot`);
  });
  await collaboration.close();

  // A browser reviewer (guest) with a review invitation.
  const guestContext = await browser.newContext({...profile});
  const guest = await guestContext.newPage(); watch(guest);
  await step(`${label}: a guest reviewer is admitted, reviews and comments`, async () => {
    const review = await call(host, 'POST', `/v1/sessions/${sessionId}/reviewer-invitations`, {});
    await guest.goto(`${ORIGIN}/app/#review=${review.invitation.token}`);
    assert.equal(new URL(guest.url()).hash, '');
    await guest.getByLabel('Your name').fill('Riya (QA)');
    await guest.getByRole('button', {name: 'Ask to join'}).click();
    await guest.getByText('Waiting for the host to admit you').waitFor({timeout: 10_000});
    const listed = await call(host, 'GET', `/v1/sessions/${sessionId}/reviewers`);
    const reviewer = listed.reviewers.find((item: {name: string}) => item.name === 'Riya (QA)');
    await call(host, 'POST', `/v1/sessions/${sessionId}/reviewers/${reviewer.id}`, {decision: 'admit'});
    await guest.getByText('Browser reviewer · Riya (QA)').waitFor({timeout: 15_000});
    await guest.getByLabel('Feedback for the team').fill('Checkout looks right on my phone.');
    await guest.getByRole('button', {name: 'Send'}).click();
    await guest.getByText('Checkout looks right on my phone.').waitFor({timeout: 15_000});
    assert.equal(await guest.getByRole('button', {name: 'Approve'}).count(), 0);
    await snap(guest, `${engine}-guest`);
    await call(host, 'POST', `/v1/sessions/${sessionId}/reviewers/${reviewer.id}`, {decision: 'revoke'});
    await guest.getByText('Review ended').waitFor({timeout: 15_000});
  });
  await guestContext.close();

  await step(`${label}: no script errors or unexpected dialogs`, async () => {assert.deepEqual(errors, []);});
  await remote.stop();
  await browser.close();
}

try {
  await startService();
  for (const engine of ['chromium', 'webkit'] as const) if (!only || only === engine) await scenario(engine);
} finally {
  service?.kill('SIGTERM');
  await wait(500);
  await db.end();
  await admin.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`).catch(() => undefined);
  await admin.end();
  writeFileSync(path.join(shots, 'results.json'), `${JSON.stringify({at: new Date().toISOString(), results}, null, 2)}\n`);
  const failed = results.filter(result => !result.ok).length;
  process.stdout.write(`\n${results.length - failed}/${results.length} browser steps passed\n`);
  process.exitCode = failed ? 1 : 0;
}
