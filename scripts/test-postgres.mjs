import { spawn, execFileSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';

// A disposable real server; no existing database or volume is touched.
const name = `multai-test-${randomUUID()}`;
const password = randomBytes(24).toString('hex');
const image = 'postgres:18-alpine@sha256:10a5c69a83035ab5239f5620d708520e8b28f5aa1f2b20143e6024532edadfb5';
const docker = args => execFileSync('docker', args, {encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']}).trim();
let started = false;
try {
  docker(['run', '--detach', '--rm', '--name', name, '-e', `POSTGRES_PASSWORD=${password}`, '-e', 'POSTGRES_DB=multai_test', '-p', '127.0.0.1::5432', image]);
  started = true;
  let ready = false;
  for (let i = 0; i < 60; i++) {
    try { docker(['exec', name, 'pg_isready', '-U', 'postgres', '-d', 'multai_test']); ready = true; break; } catch {}
    await new Promise(resolve => setTimeout(resolve, 500));
  }
  if (!ready) throw new Error('Test PostgreSQL did not become ready.');
  const port = docker(['port', name, '5432/tcp']).split(':').at(-1);
  process.stdout.write('Running integration suite against disposable PostgreSQL 18.\n');
  const child = spawn('npm', ['test'], {
    stdio: 'inherit',
    env: {...process.env, TEST_DATABASE_URL: `postgresql://postgres:${password}@127.0.0.1:${port}/multai_test`},
  });
  const code = await new Promise((resolve,reject) => { child.on('exit', resolve); child.on('error', reject); });
  process.exitCode = code ?? 1;
} catch (error) {
  process.stderr.write(`${error instanceof Error && !('stderr' in error) ? error.message : 'Could not run local Docker test database.'}\n`);
  process.exitCode = 1;
} finally {
  if (started) docker(['stop', '--time', '3', name]);
}
