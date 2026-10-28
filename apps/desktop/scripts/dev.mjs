// Starts Vite and launches Electron against it. Pass --demo to load labeled demo fixtures.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const demo = process.argv.includes('--demo');

const server = await createServer({ root, mode: demo ? 'demo' : 'development' });
await server.listen();
const url = server.resolvedUrls?.local[0];
if (!url) throw new Error('Vite did not report a local URL.');

const node = process.execPath;
await new Promise((resolve, reject) => {
  const child = spawn(node, [path.join(root, 'scripts/build-electron.mjs'), '--dev'], {
    stdio: 'inherit',
    env: { ...process.env, MULTAI_DEV_SERVER_URL: url },
  });
  child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`electron build exited ${code}`))));
});

const electron = createRequire(import.meta.url)('electron');
const app = spawn(electron, [root], { stdio: 'inherit' });
app.on('exit', async (code) => {
  await server.close();
  process.exit(code ?? 0);
});
