// Test-only acceptance for an installed or unpacked release build on Windows, Linux or macOS.
// Never staged into a package. Drives the real app over the DevTools protocol, as a person and
// the OS would: launch, service connection, multai:// links, single instance and quitting.
//
//   node scripts/platform-acceptance.mjs <app executable> [--os-open "<command that opens a URL>"]
//
// --os-open runs e.g. `xdg-open` or `cmd /c start ""` with an invite link, to prove the operating
// system routes multai:// to this installation. Without it the link is passed the way an OS
// passes it: as an argument to a second launch.
import { spawn, execSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const [executable, ...rest] = process.argv.slice(2);
const osOpenIndex = rest.indexOf('--os-open');
const osOpen = osOpenIndex >= 0 ? rest[osOpenIndex + 1] : null;
const extraArgs = (process.env.MULTAI_ACCEPTANCE_ARGS ?? '').split(' ').filter(Boolean);
if (!executable) throw new Error('Usage: platform-acceptance.mjs <app executable> [--os-open "<command>"]');

const port = 9339;
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: Boolean(ok), detail: String(detail).slice(0, 300) }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${String(detail).slice(0, 160)})` : ''}`); };

async function page() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const found = list.find(t => t.type === 'page');
      if (found) return found.webSocketDebuggerUrl;
    } catch { /* not listening yet */ }
    await sleep(500);
  }
  throw new Error('The app never opened a debuggable window.');
}

async function evaluate(expression) {
  const ws = new WebSocket(await page());
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', reject, { once: true }); });
  try {
    return await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('DevTools evaluation timed out')), 15_000);
      ws.addEventListener('message', event => {
        const message = JSON.parse(event.data);
        if (message.id !== 1) return;
        clearTimeout(timer);
        if (message.result?.exceptionDetails) reject(new Error(message.result.exceptionDetails.text));
        else resolve(message.result?.result?.value);
      });
      ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
  } finally { ws.close(); }
}

async function until(expression, timeoutMs = 20_000) {
  const end = Date.now() + timeoutMs;
  let last;
  while (Date.now() < end) {
    try { last = await evaluate(expression); if (last) return last; } catch (error) { last = error.message; }
    await sleep(500);
  }
  return last ?? null;
}

const token = 'A'.repeat(43);
const link = `multai://join?token=${token}`;
const app = spawn(executable, [`--remote-debugging-port=${port}`, ...extraArgs], { stdio: ['ignore', 'pipe', 'pipe'] });
let appOutput = '';
app.stdout.on('data', d => { appOutput += d; });
app.stderr.on('data', d => { appOutput += d; });
let exited = null;
app.once('exit', code => { exited = code ?? 0; });

try {
  const loaded = await until("document.readyState === 'complete' && document.body.innerText.length > 50 && document.title");
  check('app starts and renders its window', loaded === 'MultAI', loaded);

  const build = await until('(async () => JSON.stringify(await window.multai.getBuildInfo()))()');
  const info = build ? JSON.parse(build) : {};
  check('reports this platform', info.platform === process.platform, info.platform);
  check('is the production channel', info.channel === 'production', info.channel);
  check('talks to the hosted service', info.serviceOrigin === 'https://api.multai.si', info.serviceOrigin);

  const isolation = await evaluate("typeof require === 'undefined' && typeof process === 'undefined' && Object.isFrozen(window.multai)");
  check('renderer has no Node access and a frozen bridge', isolation === true, isolation);

  const health = await until("(async () => { const h = await window.multai.service.health(); return h.reachable && h.database === 'ready' && JSON.stringify(h); })()", 30_000);
  check('reaches api.multai.si and its database from this machine', typeof health === 'string', health || appOutput.slice(-300));

  const status = await evaluate('(async () => (await window.multai.service.authState()).status)()').catch(e => e.message);
  check('reports a sign-in state without crashing', ['signed-out', 'signed-in'].includes(status), status);

  // The OS hands a clicked link to a second launch, which forwards it and exits.
  if (osOpen) execSync(`${osOpen} "${link}"`, { stdio: 'ignore', shell: true });
  else spawn(executable, [link], { stdio: 'ignore' });
  const joined = await until("document.querySelector('[role=dialog]')?.innerText.includes('Sign in first') ? 'join dialog (signed out)' : document.querySelector('[role=dialog] input')?.value", 20_000);
  check(osOpen ? 'the OS routes multai:// links to the running app' : 'a link passed to a second launch reaches the running app', Boolean(joined), joined);
  await evaluate("[...document.querySelectorAll('button')].find(b => /OK|Cancel/.test(b.innerText))?.click(); true").catch(() => undefined);

  const malformed = spawn(executable, ['multai://join?token=<script>alert(1)</script>'], { stdio: 'ignore' });
  const malformedExit = await Promise.race([new Promise(resolve => malformed.once('exit', resolve)), sleep(15_000).then(() => 'still running')]);
  await sleep(1000);
  const afterMalformed = await evaluate("document.querySelector('[role=dialog]') ? 'dialog opened' : 'ignored'");
  check('a malformed link is ignored', afterMalformed === 'ignored', afterMalformed);
  check('a second launch hands off and exits', malformedExit !== 'still running', malformedExit);
  check('the first instance is still running', exited === null, exited);

  // macOS keeps apps running with no window open, by convention.
  if (process.platform !== 'darwin') {
    await evaluate('window.close(); true').catch(() => undefined);
    const closed = await Promise.race([new Promise(resolve => app.once('exit', () => resolve(true))), sleep(15_000).then(() => exited !== null)]);
    check('quits cleanly when its window closes', closed, exited);
  }
} catch (error) {
  check('acceptance run completed', false, `${error.message} | ${appOutput.slice(-400)}`);
} finally {
  if (exited === null) app.kill();
}

const failed = results.filter(r => !r.ok);
console.log(JSON.stringify({ platform: `${process.platform}-${process.arch}`, passed: results.length - failed.length, failed: failed.length, results }));
// The app's output pipes would otherwise keep this process alive.
process.exit(failed.length ? 1 : 0);
