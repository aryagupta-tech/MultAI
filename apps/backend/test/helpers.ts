import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import { buildApp } from '../src/app.js';
import type { Config } from '../src/config.js';
import { migrate } from '../src/migrations.js';
import type { Actor } from '../src/types.js';
import type { OidcClient } from '../src/oidc.js';

export const testConfig: Config = {
  host: '127.0.0.1', port: 4310, databaseUrl: 'postgresql://unused@127.0.0.1/test',
  publicOrigin: 'http://127.0.0.1:4310', desktopCallbackUri: 'multai-dev://auth/callback', environment: 'test',
};

export async function createTestContext(options: {config?: Config; oidc?: OidcClient} = {}) {
  const connectionString = process.env.TEST_DATABASE_URL;
  if (!connectionString) throw new Error('Run npm run test:integration to use disposable PostgreSQL.');
  const schema = `test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({connectionString, max: 1});
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const db = new Pool({connectionString, options: `-c search_path=${schema}`, max: 12});
  try {
    await migrate(db);
    const app = await buildApp({db, config: options.config ?? testConfig, ...(options.oidc ? {oidc: options.oidc} : {})});
    return {
      db, app,
      async close() {
        await app.close();
        await db.end();
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
      },
    };
  } catch (error) {
    await db.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
    throw error;
  }
}

/** Explicit synthetic test identity. Never exposed by an HTTP route. */
export async function seedActor(db: Pool, name = 'Synthetic user'): Promise<{actor: Actor; token: string; refreshToken: string}> {
  const actor = {userId: randomUUID(), deviceId: randomUUID(), authSessionId: randomUUID()};
  const token = randomBytes(32).toString('base64url');
  const refreshToken = randomBytes(32).toString('base64url');
  await db.query('INSERT INTO users (id,google_sub,display_name) VALUES ($1,$2,$3)', [actor.userId, randomUUID(), name]);
  await db.query('INSERT INTO workspaces (id,owner_id,name) VALUES ($1,$2,$3)', [randomUUID(), actor.userId, `${name} workspace`]);
  await db.query('INSERT INTO devices (id,user_id,name) VALUES ($1,$2,$3)', [actor.deviceId, actor.userId, 'Synthetic host']);
  await db.query("INSERT INTO auth_sessions (id,user_id,device_id,expires_at) VALUES ($1,$2,$3,now()+interval '30 days')", [actor.authSessionId, actor.userId, actor.deviceId]);
  await db.query("INSERT INTO access_tokens (token_hash,auth_session_id,expires_at) VALUES ($1,$2,now()+interval '15 minutes')", [createHash('sha256').update(token).digest('hex'), actor.authSessionId]);
  await db.query("INSERT INTO refresh_tokens (token_hash,auth_session_id,expires_at) VALUES ($1,$2,now()+interval '30 days')", [createHash('sha256').update(refreshToken).digest('hex'), actor.authSessionId]);
  return {actor, token, refreshToken};
}
