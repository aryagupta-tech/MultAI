import assert from 'node:assert/strict';
import {mkdtemp, readdir, readFile, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {test} from 'node:test';
import {migrate} from '../src/migrations.js';
import {transaction} from '../src/db.js';
import {createTestContext} from './helpers.js';

test('migration lock handles concurrent startup and rejects changed applied SQL', async t => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  await Promise.all([migrate(ctx.db), migrate(ctx.db), migrate(ctx.db)]);
  const folder = await mkdtemp(join(tmpdir(), 'multai-migrations-'));
  t.after(() => rm(folder, {recursive: true, force: true}));
  const source = new URL('../migrations/', import.meta.url);
  for (const name of await readdir(source)) {
    const original = await readFile(new URL(name, source), 'utf8');
    await writeFile(join(folder, name), `${original}\n-- changed after applying\n`);
  }
  await assert.rejects(migrate(ctx.db, pathToFileURL(`${folder}/`)), /differ from source/);
  const count = await ctx.db.query('SELECT count(*)::int AS count FROM schema_migrations');
  assert.equal(count.rows[0]?.count, 2);
});

test('transaction failure rolls back the full mutation', async t => {
  const ctx = await createTestContext();
  t.after(() => ctx.close());
  await assert.rejects(transaction(ctx.db, async client => {
    await client.query("INSERT INTO users(id,google_sub,display_name) VALUES(gen_random_uuid(),'rollback-probe','Synthetic')");
    throw new Error('Synthetic failure');
  }), /Synthetic failure/);
  const result = await ctx.db.query("SELECT 1 FROM users WHERE google_sub='rollback-probe'");
  assert.equal(result.rowCount, 0);
});
