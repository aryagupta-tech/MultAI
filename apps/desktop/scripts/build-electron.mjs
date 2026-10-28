// Bundles the Electron main and preload processes and stamps build provenance.
import { build } from 'esbuild';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const args = new Set(process.argv.slice(2));
const devServerUrl = args.has('--dev') ? process.env.MULTAI_DEV_SERVER_URL ?? '' : '';

function git(...argv) {
  try {
    return execFileSync('git', argv, { cwd: root, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

const pkg = JSON.parse(readFileSync(path.join(root, 'package.json'), 'utf8'));
const buildInfo = {
  version: pkg.version,
  commit: git('rev-parse', '--short=12', 'HEAD') || 'unknown',
  dirty: git('status', '--porcelain', '--', '.') !== '',
  builtAt: new Date().toISOString(),
  channel: devServerUrl ? 'development' : args.has('--demo') ? 'demo' : 'production',
};

const shared = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node22',
  external: ['electron'],
  logLevel: 'warning',
  define: {
    __BUILD_INFO__: JSON.stringify(buildInfo),
    __DEV_SERVER_URL__: JSON.stringify(devServerUrl),
  },
};

await Promise.all([
  build({ ...shared, entryPoints: [path.join(root, 'electron/main.ts')], outfile: path.join(root, 'dist/electron/main.cjs') }),
  build({ ...shared, entryPoints: [path.join(root, 'electron/preload.ts')], outfile: path.join(root, 'dist/electron/preload.cjs') }),
]);

console.log(`electron bundles built (${buildInfo.channel}, ${buildInfo.commit}${buildInfo.dirty ? '-dirty' : ''})`);
