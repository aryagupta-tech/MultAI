import { readConfig } from './config.js';
import { createDatabase } from './db.js';
import { migrate } from './migrations.js';

const db = createDatabase(readConfig().databaseUrl);
try {
  await migrate(db);
  process.stdout.write('Database migrations applied.\n');
} catch {
  process.stderr.write('Migration failed. Check database connectivity and migration integrity.\n');
  process.exitCode = 1;
} finally {
  await db.end();
}
