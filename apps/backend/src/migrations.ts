import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import type { Database } from './db.js';
import { transaction } from './db.js';

const defaultDirectory = new URL('../migrations/', import.meta.url);

/** One advisory transaction lock covers discovery, checksum validation and DDL. */
export async function migrate(db: Database, directory: URL = defaultDirectory): Promise<void> {
  const names = (await readdir(directory)).filter(name => /^\d{3}_[a-z_]+\.sql$/.test(name)).sort();
  if (names.length === 0) throw new Error('No migrations found.');
  const migrations = await Promise.all(names.map(async name => {
    const sql = await readFile(new URL(name, directory), 'utf8');
    return { name, sql, checksum: createHash('sha256').update(sql).digest('hex') };
  }));
  await transaction(db, async client => {
    await client.query("SELECT pg_advisory_xact_lock(hashtextextended('multai.migrations.v1', 0))");
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const applied = await client.query<{name: string; checksum: string}>('SELECT name, checksum FROM schema_migrations ORDER BY name');
    for (const [index, row] of applied.rows.entries()) {
      if (migrations[index]?.name !== row.name || migrations[index]?.checksum !== row.checksum) {
        throw new Error('Applied migrations differ from source; restore the original migration files.');
      }
    }
    for (const migration of migrations.slice(applied.rows.length)) {
      await client.query(migration.sql);
      await client.query('INSERT INTO schema_migrations (name,checksum) VALUES ($1,$2)', [migration.name, migration.checksum]);
    }
  });
}
