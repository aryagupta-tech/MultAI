'use strict';

// This test-only entrypoint is never staged into the packaged application.
// Node launches the pinned Electron executable; Electron then loads the actual
// compiled main, preload and renderer with an isolated temporary profile.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const {spawn, execFileSync} = require('node:child_process');
const PREFIX = 'MULTAI_NATIVE_SMOKE ';
const appRoot = path.resolve(__dirname, '..');
const repositoryRoot = path.resolve(appRoot, '..', '..');

if (!process.versions.electron) {
  launch().catch(() => {
    process.stdout.write(`${JSON.stringify({ok: false, error: {code: 'native_smoke_launcher_failed'}})}\n`);
    process.exitCode = 1;
  });
} else {
  nativeHarness();
}

async function launch() {
  const main = path.join(appRoot, 'dist', 'electron', 'main.cjs');
  const preload = path.join(appRoot, 'dist', 'electron', 'preload.cjs');
  const renderer = path.join(appRoot, 'dist', 'renderer', 'index.html');
  for (const file of [main, preload, renderer]) if (!fs.statSync(file).isFile()) throw new Error('Build the desktop first.');
  const profile = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'multai-native-smoke-')));
  fs.chmodSync(profile, 0o700);
  let expectedCommit = '';
  try {expectedCommit = execFileSync('git', ['rev-parse', '--short=12', 'HEAD'], {cwd: repositoryRoot, encoding: 'utf8'}).trim();} catch { /* A source checkout is required for this development smoke. */ }
  let child;
  let watchdog;
  let hardKill;
  let report;
  let timedOut = false;
  let interrupted = false;
  let output = '';
  const kill = () => {
    if (!child?.pid) return;
    try {
      if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
      else child.kill('SIGTERM');
    } catch { /* The test process already exited. */ }
    hardKill = setTimeout(() => {
      try {if (process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL');} catch {}
    }, 300);
    hardKill.unref();
  };
  const interrupt = () => {interrupted = true; kill();};
  try {
    const executable = require('electron');
    const environment = {...process.env, MULTAI_NATIVE_SMOKE_PROFILE: profile, MULTAI_NATIVE_SMOKE_COMMIT: expectedCommit};
    // The smoke never imports API/provider credentials from its launch environment.
    for (const name of ['OPENAI_API_KEY', 'ANTHROPIC_API_KEY', 'KIMI_API_KEY', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_CLIENT_ID', 'ACCESS_TOKEN', 'REFRESH_TOKEN', 'ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS', 'NODE_PATH']) delete environment[name];
    child = spawn(executable, [__filename], {cwd: appRoot, env: environment, stdio: ['ignore', 'pipe', 'ignore'], detached: process.platform !== 'win32'});
    process.once('SIGINT', interrupt);
    process.once('SIGTERM', interrupt);
    watchdog = setTimeout(() => {timedOut = true; kill();}, 20_000);
    child.stdout.on('data', bytes => {
      output += bytes.toString('utf8');
      if (output.length > 65_536) output = output.slice(-65_536);
      let newline;
      while ((newline = output.indexOf('\n')) >= 0) {
        const line = output.slice(0, newline); output = output.slice(newline + 1);
        if (!line.startsWith(PREFIX)) continue;
        try {report = JSON.parse(line.slice(PREFIX.length));} catch { /* Only structured harness output is returned. */ }
      }
    });
    const exit = await new Promise((resolve, reject) => {child.once('error', reject); child.once('close', (code, signal) => resolve({code, signal}));});
    if (timedOut) report = {ok: false, error: {code: 'native_smoke_timeout', deadlineMs: 20000}};
    else if (interrupted) report = {ok: false, error: {code: 'native_smoke_interrupted'}};
    else if (!report || exit.code !== 0) report = {ok: false, error: {code: 'native_process_exited'}, ...(report ? {details: report} : {})};
    process.stdout.write(`${JSON.stringify(report)}\n`);
    process.exitCode = report.ok === true ? 0 : 1;
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (hardKill) clearTimeout(hardKill);
    process.removeListener('SIGINT', interrupt);
    process.removeListener('SIGTERM', interrupt);
    // This path is generated above, never accepted from the environment or user.
    fs.rmSync(profile, {recursive: true, force: true, maxRetries: 3, retryDelay: 100});
  }
}

function nativeHarness() {
  const {app, BrowserWindow, dialog, safeStorage} = require('electron');
  const profile = process.env.MULTAI_NATIVE_SMOKE_PROFILE;
  let step = 'initialize';
  let desired;
  let finishing = false;
  let shutdown;
  let protocolAttempts = 0;
  let protocolName = '';
  const assert = (condition, code) => {if (!condition) throw new Error(code);};
  const write = value => fs.writeSync(1, `${PREFIX}${JSON.stringify(value)}\n`);
  const finish = (ok, details) => {
    if (finishing) return;
    finishing = true;
    desired = ok ? {ok: true, ...details} : {ok: false, error: {code: 'native_smoke_failed', step, detail: details}};
    try {for (const window of BrowserWindow.getAllWindows()) window.destroy();} catch {}
    shutdown = setTimeout(() => {write({ok: false, error: {code: 'native_shutdown_timeout', step}}); app.exit(1);}, 2000);
    app.quit();
  };
  app.once('will-quit', () => {if (shutdown) clearTimeout(shutdown); write(desired ?? {ok: false, error: {code: 'native_exited_before_assertions', step}});});
  process.on('uncaughtException', () => finish(false, 'uncaught_exception'));
  process.on('unhandledRejection', () => finish(false, 'unhandled_rejection'));
  try {
    assert(typeof profile === 'string' && path.basename(profile).startsWith('multai-native-smoke-'), 'isolated_profile_required');
    assert(fs.lstatSync(profile).isDirectory() && !fs.lstatSync(profile).isSymbolicLink(), 'invalid_profile');
    step = 'isolated_native_paths';
    const appData = path.join(profile, 'app-data');
    const sessions = path.join(profile, 'chromium-session');
    const initial = path.join(profile, 'initial-user-data');
    for (const directory of [appData, sessions, initial]) fs.mkdirSync(directory, {mode: 0o700});
    app.setPath('appData', appData);
    app.setPath('userData', initial);
    app.setPath('sessionData', sessions);
    step = 'software_test_hooks';
    // Record intent, but never replace an installed application's OS link handler.
    app.setAsDefaultProtocolClient = scheme => {protocolAttempts++; protocolName = scheme; return false;};
    // These changes affect only the test application's own process/windows.
    BrowserWindow.prototype.show = function () {};
    BrowserWindow.prototype.showInactive = function () {};
    dialog.showErrorBox = () => finish(false, 'unexpected_startup_dialog');
    dialog.showMessageBox = async () => {finish(false, 'unexpected_approval_dialog'); return {response: 0, checkboxChecked: false};};
    dialog.showOpenDialog = async () => {finish(false, 'unexpected_folder_dialog'); return {canceled: true, filePaths: []};};
    app.whenReady().then(() => {if (process.platform === 'darwin') app.dock?.hide();});
    app.once('browser-window-created', (_event, window) => {
      const contents = window.webContents;
      contents.once('did-fail-load', (_loadEvent, _code, _description, _url, mainFrame) => {if (mainFrame) finish(false, 'renderer_load_failed');});
      contents.once('did-finish-load', () => {
        void (async () => {
          step = 'native_window';
          const preferences = contents.getLastWebPreferences();
          assert(preferences.sandbox === true && preferences.contextIsolation === true && preferences.nodeIntegration === false, 'renderer_security_preferences');
          const relativeProfile = path.relative(profile, app.getPath('userData'));
          assert(relativeProfile && relativeProfile !== '..' && !relativeProfile.startsWith(`..${path.sep}`) && !path.isAbsolute(relativeProfile), 'profile_scope');
          step = 'renderer_ready';
          let ready = false;
          for (let attempt = 0; attempt < 100; attempt++) {
            ready = await contents.executeJavaScript("Boolean(window.multai && document.querySelector('#root')?.childElementCount)");
            if (ready) break;
            await new Promise(resolve => setTimeout(resolve, 25));
          }
          assert(ready, 'compiled_renderer_did_not_mount');
          step = 'preload_and_ipc';
          const observed = await contents.executeJavaScript(`(async () => {
            const build = await window.multai.getBuildInfo();
            const health = await window.multai.service.health();
            const auth = await window.multai.service.authState();
            const connections = await window.multai.inference.list();
            return {
              build, health, authStatus: auth.status,
              inferenceDenied: connections.ok === false,
              inferenceError: connections.ok === false ? connections.error.code : null,
              nodeUnavailable: typeof process === 'undefined' && typeof require === 'undefined',
              bridgeFrozen: Object.isFrozen(window.multai),
              rendererMounted: Boolean(document.querySelector('#root')?.childElementCount),
              titlePresent: document.body.textContent.includes('MultAI')
            };
          })()`);
          assert(observed.nodeUnavailable && observed.bridgeFrozen && observed.rendererMounted && observed.titlePresent, 'renderer_bridge_contract');
          assert(observed.authStatus === 'signed-out', 'fresh_profile_must_be_signed_out');
          assert(observed.inferenceDenied && observed.inferenceError === 'signed_out', 'signed_out_inference_boundary');
          assert(observed.build.channel === 'development' && typeof observed.build.dirty === 'boolean' && Number.isFinite(Date.parse(observed.build.builtAt)), 'development_build_provenance');
          assert(process.env.MULTAI_NATIVE_SMOKE_COMMIT && observed.build.commit === process.env.MULTAI_NATIVE_SMOKE_COMMIT, 'compiled_commit_mismatch');
          assert(observed.health.reachable === true && observed.health.database === 'ready', 'real_backend_not_ready');
          assert(protocolAttempts === 1 && protocolName === 'multai-dev', 'development_protocol_intent');
          step = 'untrusted_window_ipc';
          const untrusted = new BrowserWindow({show: false, webPreferences: {preload: path.join(appRoot, 'dist', 'electron', 'preload.cjs'), sandbox: true, contextIsolation: true, nodeIntegration: false}});
          await untrusted.loadURL('data:text/html,<title>MultAI software-test untrusted document</title>');
          const untrustedRejected = await untrusted.webContents.executeJavaScript("window.multai.getBuildInfo().then(() => false, () => true)");
          untrusted.destroy();
          assert(untrustedRejected === true, 'untrusted_window_bridge_was_accepted');
          step = 'os_crypto_capability';
          const available = safeStorage.isEncryptionAvailable();
          const backend = process.platform === 'linux' ? safeStorage.getSelectedStorageBackend() : process.platform === 'darwin' ? 'macOS-keychain' : process.platform === 'win32' ? 'Windows-DPAPI' : 'unknown';
          const approvedBackend = available && backend !== 'basic_text';
          let roundTrip = process.env.MULTAI_NATIVE_SMOKE_KEYRING === '1' ? 'unavailable' : 'not_requested';
          if (process.env.MULTAI_NATIVE_SMOKE_KEYRING === '1' && approvedBackend) {
            const synthetic = crypto.randomBytes(32).toString('hex');
            const encrypted = safeStorage.encryptString(synthetic);
            assert(safeStorage.decryptString(encrypted) === synthetic, 'os_crypto_round_trip');
            roundTrip = 'passed';
          }
          const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
          step = 'complete';
          finish(true, {
            component: 'compiled-desktop-native-smoke',
            platform: `${process.platform}-${process.arch}`,
            executable: process.execPath,
            versions: {electron: process.versions.electron, node: process.versions.node, chromium: process.versions.chrome},
            build: observed.build,
            artifacts: {mainSha256: sha256(path.join(appRoot, 'dist', 'electron', 'main.cjs')), preloadSha256: sha256(path.join(appRoot, 'dist', 'electron', 'preload.cjs')), rendererIndexSha256: sha256(path.join(appRoot, 'dist', 'renderer', 'index.html'))},
            checks: {compiledRendererMounted: true, preloadAndRealIpc: true, isolatedTemporaryProfile: true, sandboxAndContextIsolation: true, rendererNodeUnavailable: true, untrustedWindowIpcRejected: true, signedOutInferenceDenied: true, realBackendDatabaseReady: true},
            identityReadiness: observed.health.identity,
            protocol: {intentRecorded: protocolName, osRegistrationPerformed: false},
            osCrypto: {available, backend, approvedBackend, roundTrip},
            liveGoogleSignInVerified: false,
            liveProviderInferenceVerified: false,
          });
        })().catch(error => finish(false, error instanceof Error && /^[a-z_]{1,80}$/u.test(error.message) ? error.message : 'assertion_failed'));
      });
    });
    step = 'compiled_main_startup';
    require(path.join(appRoot, 'dist', 'electron', 'main.cjs'));
  } catch {finish(false, 'initialization_failed');}
}
