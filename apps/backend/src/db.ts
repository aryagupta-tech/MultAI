import { Pool, type PoolClient } from 'pg';
import { ApiError } from './errors.js';
import type { Actor } from './types.js';

export type Database = Pool;

export function createDatabase(connectionString: string): Database {
  const db = new Pool({
    connectionString,
    max: 12,
    connectionTimeoutMillis: 5_000,
    idleTimeoutMillis: 30_000,
    statement_timeout: 10_000,
    application_name: 'multai-backend-dev',
  });
  // Do not print connection errors; they may include connection credentials.
  db.on('error', () => process.stderr.write('Database connection unavailable\n'));
  return db;
}

export async function transaction<T>(db: Database, operation: (client: PoolClient) => Promise<T>): Promise<T> {
  const client = await db.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '5s'");
    const result = await operation(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

/** Hold authority locks through the operation so revocation serializes with it. */
export async function assertActor(client: PoolClient, actor: Actor): Promise<void> {
  const result = await client.query(
    `SELECT a.id FROM auth_sessions a JOIN devices d ON d.id = a.device_id
     WHERE a.id = $1 AND a.user_id = $2 AND d.id = $3 AND d.user_id = $2
       AND a.revoked_at IS NULL AND d.revoked_at IS NULL AND a.expires_at > now()
     FOR SHARE OF a, d`,
    [actor.authSessionId, actor.userId, actor.deviceId],
  );
  if (result.rowCount !== 1) throw new ApiError(401, 'unauthorized', 'Sign in again to continue.');
}
