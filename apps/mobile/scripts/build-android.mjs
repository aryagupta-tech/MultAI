// Builds the MultAI Companion APK.
//   --release  signed with the private key from ~/.multai/android (or MULTAI_ANDROID_SIGNING), for https://api.multai.si
//   --test     debug-signed `.test` app for an emulator, talking to a local service through `adb reverse`
// Needs JDK 21 (JAVA_HOME) and the Android SDK (ANDROID_HOME) with platform 36 and build-tools 36.0.0.
import {execFileSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const release = process.argv.includes('--release');
const test = process.argv.includes('--test');
if (release === test) throw new Error('Choose --release or --test.');
const sdk = process.env.ANDROID_HOME ?? process.env.ANDROID_SDK_ROOT;
if (!sdk || !existsSync(path.join(sdk, 'build-tools', '36.0.0'))) throw new Error('Set ANDROID_HOME to an Android SDK with build-tools 36.0.0.');
if (!process.env.JAVA_HOME) throw new Error('Set JAVA_HOME to a JDK 21.');
const origin = release ? 'https://api.multai.si' : (process.env.MULTAI_SERVICE_ORIGIN ?? 'http://localhost:4319');
const run = (command, args, options = {}) => execFileSync(command, args, {cwd: root, stdio: 'inherit', ...options, env: {...process.env, ...options.env}});
const git = (...args) => execFileSync('git', args, {cwd: root, encoding: 'utf8'}).trim();
const sourceStatus = () => git('status', '--porcelain', '--', ':(top)*', ':(top,exclude)apps/mobile/release', ':(top,exclude)apps/mobile/build-test', ':(top,exclude)apps/mobile/test/screenshots');
const sourceCommit = git('rev-parse', 'HEAD');
if (release && sourceStatus()) throw new Error('Release builds require committed source. Commit the changes first; test builds may use a dirty checkout.');

run('npx', ['vite', 'build'], {env: {MULTAI_SERVICE_ORIGIN: origin, MULTAI_ANDROID_TEST: test ? '1' : '0'}});
run('npx', ['cap', 'sync', 'android']);
const config = path.join(root, 'android/app/src/main/assets/capacitor.config.json');
// Only test builds can be inspected with Chrome DevTools.
writeFileSync(config, JSON.stringify({...JSON.parse(readFileSync(config, 'utf8')), android: {allowMixedContent: false, captureInput: false, webContentsDebuggingEnabled: test}}, null, '\t'));
writeFileSync(path.join(root, 'android/local.properties'), `sdk.dir=${sdk}\n`);
const testVersion = test && process.env.MULTAI_TEST_VERSION_CODE ? Number(process.env.MULTAI_TEST_VERSION_CODE) : null;
if (testVersion !== null && !(Number.isInteger(testVersion) && testVersion > 0)) throw new Error('MULTAI_TEST_VERSION_CODE must be a positive integer.');
run('./gradlew', ['--no-daemon', '--quiet', release ? 'assembleRelease' : 'assembleDebug', ...(testVersion ? [`-PmultaiTestVersionCode=${testVersion}`] : [])], {cwd: path.join(root, 'android')});

const built = path.join(root, 'android/app/build/outputs/apk', release ? 'release/app-release.apk' : 'debug/app-debug.apk');
const properties = Object.fromEntries(readFileSync(path.join(root, 'version.properties'), 'utf8').trim().split('\n').map(line => line.split('=')));
const versionName = properties.versionName, versionCode = String(testVersion ?? properties.versionCode);
const outDir = path.join(root, release ? 'release' : 'build-test');
mkdirSync(outDir, {recursive: true});
const name = release ? `multai-companion-${versionName}.apk` : `multai-companion-test-${versionName}-${versionCode}.apk`;
const target = path.join(outDir, name);
copyFileSync(built, target);
const apksigner = path.join(sdk, 'build-tools', '36.0.0', 'apksigner');
const certs = execFileSync(apksigner, ['verify', '--verbose', '--print-certs', target], {encoding: 'utf8'});
if (!/^Verifies$/mu.test(certs) || !/Verified using v[23] scheme \(APK Signature Scheme v[23]\): true/u.test(certs)) throw new Error('APK signature did not verify.');
const certificate = /Signer #1 certificate SHA-256 digest: ([0-9a-f]{64})/u.exec(certs)?.[1];
if (!certificate) throw new Error('The APK signing certificate is missing.');
const badging = execFileSync(path.join(sdk, 'build-tools', '36.0.0', 'aapt2'), ['dump', 'badging', target], {encoding: 'utf8'});
const applicationId = release ? 'si.multai.companion' : 'si.multai.companion.test';
const packaged = /^package: name='([^']+)' versionCode='([^']+)' versionName='([^']+)'/mu.exec(badging);
if (!packaged || packaged[1] !== applicationId || packaged[2] !== versionCode || packaged[3] !== `${versionName}${test ? '-test' : ''}`) throw new Error('The APK package/version does not match this build.');
if (release && /^application-debuggable/mu.test(badging)) throw new Error('A release APK must not be debuggable.');
if (git('rev-parse', 'HEAD') !== sourceCommit || (release && sourceStatus())) throw new Error('Source changed during the build. Retry from the intended commit.');
const sha256 = createHash('sha256').update(readFileSync(target)).digest('hex');
const manifest = {
  product: 'MultAI Companion', applicationId, versionName, versionCode: Number(versionCode),
  service: origin, file: name, sha256, signingCertificateSha256: certificate.toUpperCase().match(/../gu).join(':'),
  sourceCommit, sourceDirty: sourceStatus().length > 0, builtAt: new Date().toISOString(),
};
writeFileSync(path.join(outDir, `${name}.json`), `${JSON.stringify(manifest, null, 2)}\n`);
writeFileSync(path.join(outDir, `${name}.sha256`), `${sha256}  ${name}\n`);
process.stdout.write(`${target}\nSHA-256 ${sha256}\nSigning certificate ${manifest.signingCertificateSha256}\n`);
