// Packages the built app for the current platform into release/. Only the bundled output is
// staged: no source, node_modules, fixtures or credentials go into the package.
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

execFileSync('npm', ['run', 'build'], { cwd: root, stdio: 'inherit' });

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
  main: 'dist/electron/main.cjs',
}, null, 2));

const iconPath = path.join(root, 'build', 'icon.icns');
const [appDir] = await packager({
  dir: stage,
  out,
  name: 'MultAI',
  executableName: 'MultAI',
  appBundleId: 'dev.multai.desktop.development',
  appVersion: pkg.version,
  appCopyright: 'MultAI development build',
  electronVersion,
  asar: true,
  overwrite: true,
  prune: false,
  platform: process.platform,
  arch: process.arch,
  ...(await exists(iconPath) ? { icon: iconPath } : {}),
  protocols: [{ name: 'MultAI development links', schemes: ['multai-dev'] }],
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
const git = (...a) => { try { return execFileSync('git', a, { cwd: root, encoding: 'utf8' }).trim(); } catch { return ''; } };
await writeFile(path.join(appDir, 'build-manifest.json'), JSON.stringify({
  version: pkg.version,
  commit: git('rev-parse', 'HEAD'),
  dirty: git('status', '--porcelain') !== '',
  builtAt: new Date().toISOString(),
  electron: electronVersion,
  platform: `${process.platform}-${process.arch}`,
  appAsarSha256: createHash('sha256').update(await readFile(asar)).digest('hex'),
  thirdPartyNoticesSha256: notices.sha256,
  thirdPartyPackages: notices.packages.map(({ name, version, license }) => ({ name, version, license })),
  signing: process.platform === 'darwin' ? 'ad-hoc (not notarized)' : 'unsigned',
}, null, 2));

console.log(`packaged: ${appDir}`);

async function exists(p) {
  try { await readFile(p); return true; } catch { return false; }
}
