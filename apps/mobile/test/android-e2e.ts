// Android emulator run of the installed test build (si.multai.companion.test): the real APK, WebView and
// Keystore plugin against a local service reached through `adb reverse`, with the desktop's real
// RemoteControlHost as the original host. Covers pairing, start + approve, Stop, process death,
// rotation, an in-place update that keeps the pairing, and uninstall. This is an emulator, not a phone.
//
//   TEST_DATABASE_URL=… ANDROID_HOME=… node --import tsx apps/mobile/test/android-e2e.ts <v1.apk> <v2.apk>
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {mkdirSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {_android as android, type AndroidDevice, type Page} from 'playwright';
import {PORT, call, desktop, hostSession, repo, seedUser, startService, stopService, wait} from '../../web/test/harness.ts';

const [v1, v2] = process.argv.slice(2);
if (!v1 || !v2) throw new Error('Pass the version 1 and version 2 test APKs.');
const sdk = process.env.ANDROID_HOME!;
const adb = (...args: string[]) => execFileSync(path.join(sdk, 'platform-tools/adb'), args, {encoding: 'utf8'}).trim();
const APP = 'si.multai.companion.test';
const shots = path.join(repo, 'apps/mobile/test/screenshots');
mkdirSync(shots, {recursive: true});
const results: {name: string; ok: boolean; detail?: string}[] = [];
async function step(name: string, work: () => Promise<void>) {
  try {await work(); results.push({name, ok: true}); process.stdout.write(`✔ ${name}\n`);}
  catch (error) {results.push({name, ok: false, detail: String(error)}); process.stdout.write(`✖ ${name}\n  ${String(error).split('\n').slice(0, 6).join('\n  ')}\n`);}
}
const screencap = (name: string) => writeFileSync(path.join(shots, `${name}.png`), execFileSync(path.join(sdk, 'platform-tools/adb'), ['exec-out', 'screencap', '-p']));

let device: AndroidDevice | undefined;
/** Launches the app and attaches to its WebView through Playwright's Android driver (test builds only). */
async function attach(): Promise<Page> {
  device ??= (await android.devices())[0];
  if (!device) throw new Error('No Android device or emulator is connected.');
  adb('shell', 'am', 'start', '-W', '-n', `${APP}/si.multai.companion.MainActivity`);
  // After a force-stop the app runs in a new process; attach to that process's WebView, not a stale one.
  const pid = Number(adb('shell', 'pidof', APP));
  const webview = device.webViews().find(view => view.pid() === pid) ?? await device.waitForEvent('webview', {predicate: view => view.pid() === pid, timeout: 20_000});
  const page = await webview.page();
  await page.waitForLoadState();
  return page;
}

try {
  await startService('development');
  adb('reverse', `tcp:${PORT}`, `tcp:${PORT}`);
  const host = await seedUser('Android e2e host');
  const {remote, approvals, decided} = desktop(host);
  await remote.start();
  const sessionId = await hostSession(host, 'Checkout fix (Android)');
  try {adb('uninstall', APP);} catch {/* not installed */}

  await step('install the version 1 test APK', async () => {
    adb('install', v1);
    assert.match(adb('shell', 'dumpsys', 'package', APP), /versionCode=1 /u);
  });

  let page = await attach();
  await step('the app opens on the home screen inside the WebView, with its CSP', async () => {
    await page.getByRole('heading', {name: 'Companion'}).waitFor({timeout: 15_000});
    assert.match(await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute('content') ?? '', /connect-src http:\/\/localhost:4319;/u);
    assert.match(await page.textContent('body') ?? '', /Android app/u);
    screencap('android-home');
  });

  let pairingId = '';
  await step('pairing from the app with matching check digits; the credential goes to the Keystore', async () => {
    const offer = await remote.createPairing([sessionId], 86_400);
    pairingId = offer.id;
    await page.getByRole('button', {name: 'Pair as owner'}).click();
    await page.getByLabel('Pairing code').fill(offer.code.toLowerCase());
    await page.getByRole('button', {name: 'Pair this phone'}).click();
    const sas = await page.locator('.c-sas').textContent({timeout: 15_000});
    const review = await remote.reviewPairing(offer.id);
    assert.equal(review.platform, 'android');
    assert.match(review.deviceName ?? '', /Android app/u);
    assert.equal(review.verificationCode, sas);
    screencap('android-pair-check');
    await remote.confirmPairing(offer.id, [sessionId]);
    await page.getByRole('heading', {name: 'Owner control'}).waitFor({timeout: 15_000});
    // Nothing secret in web storage: the credential is in the Keystore plugin, the keys are non-extractable.
    const stored = await page.evaluate(() => JSON.stringify({...localStorage}));
    assert.doesNotMatch(stored, /"controller\.credential"/u);
    const extractable = await page.evaluate(async () => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {const r = indexedDB.open('multai-companion'); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);});
      const keys = await new Promise<{signing: CryptoKeyPair}>((resolve) => {const r = db.transaction('keys').objectStore('keys').get('controller-keys'); r.onsuccess = () => resolve(r.result);});
      return keys.signing.privateKey.extractable;
    });
    assert.equal(extractable, false);
    const prefs = adb('shell', 'run-as', APP, 'cat', `/data/data/${APP}/shared_prefs/multai_secure_v1.xml`);
    assert.match(prefs, /controller\.credential/u, 'the credential is stored by the Keystore plugin');
    assert.doesNotMatch(prefs, /[A-Za-z0-9_-]{43}<\/string>/u, 'and only as ciphertext');
  });

  await step('start the chosen instruction and approve the exact command from the app', async () => {
    await page.getByRole('button', {name: /Checkout fix/u}).click();
    await page.getByText('Desktop online', {exact: false}).first().waitFor({timeout: 25_000});
    await page.getByRole('radio').first().check();
    await page.getByRole('button', {name: 'Start selected'}).click();
    await page.getByRole('alertdialog').getByRole('button', {name: 'Confirm'}).click();
    await page.getByText('Waiting for your approval').waitFor({timeout: 25_000});
    await page.waitForFunction(() => !document.querySelector('.c-approval .c-btn-primary')?.hasAttribute('disabled'), undefined, {timeout: 25_000});
    screencap('android-approval');
    await page.getByRole('button', {name: 'Approve'}).click();
    await page.getByText('The desktop did it').first().waitFor({timeout: 25_000});
    await page.getByText('Run completed', {exact: false}).first().waitFor({timeout: 25_000});
    assert.equal(decided.at(-1)?.approved, true);
  });

  await step('Stop from the app cancels the run and its waiting approval', async () => {
    await call(host, 'POST', `/v1/sessions/${sessionId}/messages`, {requestId: crypto.randomUUID(), kind: 'instruction', text: 'Also add a regression test.'});
    await page.getByText('Also add a regression test.').waitFor({timeout: 15_000});
    await page.getByRole('radio').first().check();
    await page.getByRole('button', {name: 'Start selected'}).click();
    await page.getByRole('alertdialog').getByRole('button', {name: 'Confirm'}).click();
    await page.getByText('Waiting for your approval').waitFor({timeout: 25_000});
    await page.getByRole('button', {name: 'Stop', exact: true}).click();
    await page.getByRole('alertdialog').getByRole('button', {name: 'Confirm'}).click();
    await page.getByText('Waiting for your approval').waitFor({state: 'detached', timeout: 25_000});
    assert.equal(approvals.list().length, 0);
    assert.equal(decided.at(-1)?.approved, false);
  });

  await step('rotation keeps state and layout', async () => {
    adb('shell', 'settings', 'put', 'system', 'accelerometer_rotation', '0');
    adb('shell', 'settings', 'put', 'system', 'user_rotation', '1');
    await wait(2_000);
    const overflow = await page.evaluate(() => ({wide: window.innerWidth > window.innerHeight, overflow: document.documentElement.scrollWidth - window.innerWidth}));
    assert.ok(overflow.wide, 'the screen rotated');
    assert.ok(overflow.overflow <= 1, `no sideways scroll (${overflow.overflow})`);
    // The screen is the same one, not reloaded: the activity handles rotation itself.
    await page.getByRole('heading', {name: 'Checkout fix (Android)'}).waitFor();
    await page.getByText('The desktop did it').first().waitFor();
    screencap('android-landscape');
    adb('shell', 'settings', 'put', 'system', 'user_rotation', '0');
    await wait(1_000);
  });

  await step('process death: a killed app comes back paired, with its request history', async () => {
    adb('shell', 'am', 'force-stop', APP);
    page = await attach();
    await page.getByRole('button', {name: 'Owner control', exact: true}).click({timeout: 15_000});
    await page.getByRole('button', {name: /Checkout fix/u}).click();
    await page.getByText('The desktop did it').first().waitFor({timeout: 15_000});
  });

  await step('update in place to version 2 keeps the pairing', async () => {
    adb('install', '-r', v2);
    assert.match(adb('shell', 'dumpsys', 'package', APP), /versionCode=2 /u);
    page = await attach();
    await page.getByRole('button', {name: 'Owner control', exact: true}).click({timeout: 15_000});
    await page.getByText('Checkout fix (Android)').waitFor({timeout: 15_000});
    screencap('android-after-update');
  });

  await step('a downgrade over version 2 is refused', async () => {
    let refused = false;
    try {adb('install', '-r', v1);} catch (error) {refused = /INSTALL_FAILED_VERSION_DOWNGRADE/u.test(String((error as {stderr?: unknown}).stderr ?? error)); }
    assert.ok(refused, 'downgrade must be refused');
  });

  await step('revoking on the desktop ends owner control in the app', async () => {
    await remote.revokePairing(pairingId);
    await page.getByText('This phone was removed on the desktop', {exact: false}).waitFor({timeout: 25_000});
    const prefs = adb('shell', 'run-as', APP, 'cat', `/data/data/${APP}/shared_prefs/multai_secure_v1.xml`);
    assert.doesNotMatch(prefs, /controller\.credential/u, 'the dead credential is erased from the Keystore storage');
  });

  await step('uninstall removes the app and its data', async () => {
    adb('uninstall', APP);
    assert.doesNotMatch(adb('shell', 'pm', 'list', 'packages', APP), new RegExp(APP.replaceAll('.', '\\.'), 'u'));
  });
  await remote.stop();
} finally {
  await device?.close().catch(() => undefined);
  try {adb('reverse', '--remove-all');} catch {/* ignore */}
  await stopService();
  writeFileSync(path.join(shots, 'results.json'), `${JSON.stringify({at: new Date().toISOString(), device: 'Android emulator (not a physical phone)', results}, null, 2)}\n`);
  const failed = results.filter(result => !result.ok).length;
  process.stdout.write(`\n${results.length - failed}/${results.length} Android emulator steps passed\n`);
  process.exitCode = failed ? 1 : 0;
}
