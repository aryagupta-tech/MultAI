import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const backend = new URL('../apps/backend/', import.meta.url);
const files = [];
for (const folder of ['dist', 'migrations']) {
  for (const name of await readdir(new URL(`${folder}/`, backend))) {
    if (name === 'build-manifest.json') continue;
    const relative = `${folder}/${name}`;
    const content = await readFile(new URL(relative, backend));
    files.push({ path: relative, bytes: content.length, sha256: createHash('sha256').update(content).digest('hex') });
  }
}
const manifest = {
  product: 'MultAI', component: 'collaboration-service', version: '0.0.0-dev.1', developmentBuild: true,
  sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {cwd: root, encoding: 'utf8'}).trim(),
  sourceDirty: execFileSync('git', ['status', '--porcelain'], {cwd: root, encoding: 'utf8'}).trim().length > 0,
  builtAt: new Date().toISOString(), node: process.version, files,
};
await writeFile(new URL('dist/build-manifest.json', backend), `${JSON.stringify(manifest, null, 2)}\n`);
