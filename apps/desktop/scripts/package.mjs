// Packages the built app into release/. Only the bundled output is staged: no source,
// node_modules, fixtures or credentials go into the package. macOS builds an app bundle for this
// machine; --win and --linux build installers (NSIS; AppImage, .deb and .tar.gz) for x64 and arm64.
import { packager } from '@electron/packager';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createThirdPartyNotices } from './third-party-notices.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const stage = path.join(root, 'release', 'stage');
const out = path.join(root, 'release');
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const electronVersion = createRequire(import.meta.url)('electron/package.json').version;
// --release packages the public identity (multai:// links, hosted service); the default stays a
// development build that can be installed beside it.
const release = process.argv.includes('--release');
const target = process.argv.includes('--win') ? 'win32' : process.argv.includes('--linux') ? 'linux' : process.platform;
const identity = release
  ? { bundleId: 'dev.multai.desktop', copyright: 'Copyright © 2026 MultAI', linkName: 'MultAI links', scheme: 'multai' }
  : { bundleId: 'dev.multai.desktop.development', copyright: 'MultAI development build', linkName: 'MultAI development links', scheme: 'multai-dev' };

// npm is a .cmd script on Windows, which Node only starts through a shell.
// The app bundles the runtime's compiled output, so build it first; otherwise a stale copy ships.
execFileSync('npm', ['run', 'build', '--workspace', '@multai/runtime'], { cwd: path.resolve(root, '../..'), stdio: 'inherit', shell: process.platform === 'win32' });
execFileSync('npm', ['run', release ? 'build:release' : 'build'], { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });

await rm(stage, { recursive: true, force: true });
await mkdir(stage, { recursive: true });
await cp(path.join(root, 'dist'), path.join(stage, 'dist'), { recursive: true });
const repositoryRoot = path.resolve(root, '../..');
const notices = await createThirdPartyNotices({ desktopRoot: root, repositoryRoot });
await cp(path.join(repositoryRoot, 'LICENSE'), path.join(stage, 'LICENSE'));
await writeFile(path.join(stage, 'THIRD_PARTY_NOTICES.txt'), notices.content);
await writeFile(path.join(stage, 'package.json'), JSON.stringify({
  name: 'multai-desktop',
  productName: 'MultAI',
  version: pkg.version,
  private: true,
  description: 'Work on one AI coding session together.',
  // The .deb maintainer field requires an address.
  author: { name: 'MultAI', email: 'noreply@multai.si' },
  homepage: 'https://multai.si',
  main: 'dist/electron/main.cjs',
}, null, 2));

const git = (...a) => { try { return execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim(); } catch { return ''; } };
const provenance = (platform) => ({
  version: pkg.version,
  channel: release ? 'production' : 'development',
  bundleId: identity.bundleId,
  commit: git('rev-parse', 'HEAD'),
  dirty: git('status', '--porcelain') !== '',
  builtAt: new Date().toISOString(),
  electron: electronVersion,
  platform,
  thirdPartyNoticesSha256: notices.sha256,
  thirdPartyPackages: notices.packages.map(({ name, version, license }) => ({ name, version, license })),
});

if (target !== 'darwin') {
  const { build, Platform, Arch } = await import('electron-builder');
  const linux = target === 'linux';
  // electron-builder's protocols only reach Linux and macOS; NSIS needs the link handler written
  // itself, so links work before the first launch and nothing points at a removed app afterwards.
  const nsisInclude = path.join(stage, 'installer.nsh');
  const key = `Software\\Classes\\${identity.scheme}`;
  await writeFile(nsisInclude, [
    '!macro customInstall',
    `  WriteRegStr HKCU "${key}" "" "URL:${identity.linkName}"`,
    `  WriteRegStr HKCU "${key}" "URL Protocol" ""`,
    `  WriteRegStr HKCU "${key}\\DefaultIcon" "" "$INSTDIR\\\${APP_EXECUTABLE_FILENAME},0"`,
    `  WriteRegStr HKCU "${key}\\shell\\open\\command" "" '"$INSTDIR\\\${APP_EXECUTABLE_FILENAME}" "%1"'`,
    '!macroend',
    '!macro customUnInstall',
    `  DeleteRegKey HKCU "${key}"`,
    '!macroend',
    '',
  ].join('\r\n'));
  const artifacts = await build({
    projectDir: stage,
    targets: (linux ? Platform.LINUX : Platform.WINDOWS).createTarget(linux ? ['AppImage', 'deb', 'tar.gz'] : ['nsis'], Arch.x64, Arch.arm64),
    publish: 'never',
    config: {
      appId: identity.bundleId,
      productName: 'MultAI',
      executableName: linux ? 'multai' : 'MultAI',
      copyright: identity.copyright,
      electronVersion,
      asar: true,
      npmRebuild: false,
      directories: { output: path.join(out, linux ? 'linux' : 'win'), buildResources: path.join(root, 'build') },
      files: ['dist/**/*', 'package.json'],
      extraFiles: [{ from: 'LICENSE', to: 'LICENSE.multai.txt' }, 'THIRD_PARTY_NOTICES.txt'],
      artifactName: release ? 'MultAI-${version}-${arch}.${ext}' : 'MultAI-dev-${version}-${arch}.${ext}',
      // Registers multai:// in the Linux desktop entry (MimeType); Windows uses installer.nsh above.
      protocols: [{ name: identity.linkName, schemes: [identity.scheme] }],
      win: { icon: path.join(root, 'build', 'icon.png'), signAndEditExecutable: true },
      // Per-user install: no administrator prompt, and uninstalling keeps the user's sign-in data.
      nsis: { oneClick: false, perMachine: false, allowElevation: false, allowToChangeInstallationDirectory: false, deleteAppDataOnUninstall: false, createDesktopShortcut: true, shortcutName: 'MultAI', include: nsisInclude },
      linux: { icon: path.join(root, 'build', 'icon.png'), category: 'Development', synopsis: 'Work on one AI coding session together.', maintainer: 'MultAI <noreply@multai.si>', desktop: { entry: { StartupWMClass: 'MultAI' } } },
      deb: { depends: ['libgtk-3-0 | libgtk-3-0t64', 'libnotify4', 'libnss3', 'libxss1', 'libxtst6', 'xdg-utils', 'libatspi2.0-0 | libatspi2.0-0t64', 'libuuid1', 'libsecret-1-0'] },
    },
  });
  await writeFile(path.join(out, linux ? 'linux' : 'win', 'build-manifest.json'), JSON.stringify({ ...provenance(`${target}-x64,arm64`), artifacts: artifacts.filter(a => !a.endsWith('.blockmap') && !a.endsWith('.yml')).map(a => path.basename(a)), signing: 'unsigned' }, null, 2));
  for (const artifact of artifacts) console.log(`packaged: ${artifact}`);
  process.exit(0);
}

const iconPath = path.join(root, 'build', 'icon.icns');
const [appDir] = await packager({
  dir: stage,
  out,
  name: 'MultAI',
  executableName: 'MultAI',
  appBundleId: identity.bundleId,
  appVersion: pkg.version,
  appCopyright: identity.copyright,
  electronVersion,
  asar: true,
  overwrite: true,
  prune: false,
  platform: process.platform,
  arch: process.arch,
  ...(await exists(iconPath) ? { icon: iconPath } : {}),
  protocols: [{ name: identity.linkName, schemes: [identity.scheme] }],
  extendInfo: { LSApplicationCategoryType: 'public.app-category.developer-tools' },
});
// Keep readable standalone copies beside the application as well as inside app.asar.
await cp(path.join(stage, 'LICENSE'), path.join(appDir, 'LICENSE.multai.txt'));
await cp(path.join(stage, 'THIRD_PARTY_NOTICES.txt'), path.join(appDir, 'THIRD_PARTY_NOTICES.txt'));

if (process.platform === 'darwin') {
  const app = path.join(appDir, 'MultAI.app');
  // Ad-hoc signature: required for Apple Silicon to launch a locally built app. This is not a
  // Developer ID signature and says nothing about trust for downloaded copies.
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', app], { stdio: 'inherit' });
}

// Provenance: record what was packaged from which source state.
const asar = path.join(appDir, process.platform === 'darwin' ? 'MultAI.app/Contents/Resources/app.asar' : 'resources/app.asar');
await writeFile(path.join(appDir, 'build-manifest.json'), JSON.stringify({
  ...provenance(`${process.platform}-${process.arch}`),
  appAsarSha256: createHash('sha256').update(await readFile(asar)).digest('hex'),
  signing: process.platform === 'darwin' ? 'ad-hoc (not notarized)' : 'unsigned',
}, null, 2));

console.log(`packaged: ${appDir}`);

async function exists(p) {
  try { await readFile(p); return true; } catch { return false; }
}
