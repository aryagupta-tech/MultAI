import { buildApp } from './app.js';
import { readConfig } from './config.js';
import { createDatabase } from './db.js';
import { migrate } from './migrations.js';

const config = readConfig();
const db = createDatabase(config.databaseUrl);
try {
  await migrate(db);
  const app = await buildApp({db, config, logger: true});
  let closing = false;
  const close = async () => {
    if (closing) return;
    closing = true;
    await app.close();
    await db.end();
  };
  const stop = () => void close().catch(() => {
    process.stderr.write('Backend shutdown failed.\n');
    process.exitCode = 1;
  });
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
  await app.listen({host: config.host, port: config.port});
} catch {
  process.stderr.write('Backend startup failed. Check configuration, database availability and migration integrity.\n');
  await db.end();
  process.exitCode = 1;
}
