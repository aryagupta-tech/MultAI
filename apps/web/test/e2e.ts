// End-to-end: a real backend process on a disposable PostgreSQL, the desktop's real RemoteControlHost
// and ApprovalBroker acting as the original host (with a synthetic agent instead of a model), and real
// browsers emulating phones: Chromium as Android Chrome (Pixel 7) and WebKit as iPhone Safari (iPhone 15).
// Identities are synthetic and seeded directly; no Google or model provider is contacted.
//
//   TEST_DATABASE_URL=postgresql://… node --import tsx apps/web/test/e2e.ts [--only=chromium|webkit]
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {chromium, devices, webkit, type Browser, type BrowserContext, type Page} from 'playwright';
import {ORIGIN, call, db, desktop, repo, seedUser, startService, stopService, wait} from './harness.ts';

const shots = path.join(process.env.E2E_SHOTS ?? path.join(repo, 'apps/web/test/screenshots'));
mkdirSync(shots, {recursive: true});
const only = process.argv.find(arg => arg.startsWith('--only='))?.slice(7);
const results: {name: string; ok: boolean; detail?: string}[] = [];

// ---------------------------------------------------------------- Browser helpers

async function screenshotData(): Promise<string> {
  // A real 200×150 PNG drawn by the browser, small enough for the 110 kB share limit.
  const page = await (await chromium.launch()).newPage();
  const data = await page.evaluate(() => {const canvas = document.createElement('canvas'); canvas.width = 200; canvas.height = 150; const g = canvas.getContext('2d')!; g.fillStyle = '#fff'; g.fillRect(0, 0, 200, 150); g.fillStyle = '#000'; g.fillRect(20, 20, 160, 30); g.fillStyle = '#c00'; g.fillRect(60, 90, 80, 30); return canvas.toDataURL('image/png');});
  await page.context().browser()?.close();
  return data;
}

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
  await stopService();
  writeFileSync(path.join(shots, 'results.json'), `${JSON.stringify({at: new Date().toISOString(), results}, null, 2)}\n`);
  const failed = results.filter(result => !result.ok).length;
  process.stdout.write(`\n${results.length - failed}/${results.length} browser steps passed\n`);
  process.exitCode = failed ? 1 : 0;
}
