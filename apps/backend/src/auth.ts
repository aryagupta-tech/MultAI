import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import type { Config } from './config.js';
import { assertActor, transaction, type Database } from './db.js';
import { ApiError } from './errors.js';
import { GoogleOidcClient, pkceChallenge, type OidcClient, type OidcIdentity } from './oidc.js';
import type { Actor } from './types.js';

const secret = () => randomBytes(32).toString('base64url');
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const opaqueSecret = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const verifierSchema = z.string().regex(/^[A-Za-z0-9._~-]{43,128}$/);
const desktopClientId = 'multai-desktop-development';

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function invalidCredentials(): ApiError {
  return new ApiError(401, 'invalid_credentials', 'Sign-in has expired or was revoked. Sign in again.');
}

interface TokenBundle {
  accessToken: string;
  refreshToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  deviceId: string;
  /** Returned only on new enrollment; retain in account-scoped OS encryption. */
  deviceSecret?: string;
}

interface Flow {
  id: string;
  nonce: string;
  desktop_challenge: string;
  desktop_client_id: string;
  desktop_callback_uri: string;
  provider_redirect_uri: string;
  provider_client_id: string | null;
  provider_verifier: string | null;
  completion_hash: string | null;
  identity: OidcIdentity | null;
  expires_at: Date;
  consumed_at: Date | null;
}

export class AuthService {
  private resolvedOidc: OidcClient | undefined;
  constructor(private readonly db: Database, private readonly config: Config, private readonly oidc?: OidcClient) {}

  private provider(): OidcClient {
    return this.resolvedOidc ??= this.oidc ?? new GoogleOidcClient(this.config);
  }

  private redirectUri(): string {
    if (!this.config.googleRedirectUri) {
      throw new ApiError(503, 'identity_unavailable', 'Google sign-in is not configured for this service.');
    }
    return this.config.googleRedirectUri;
  }

  async start(codeChallenge: string): Promise<{ flowId: string; authorizationUrl: string; expiresAt: string }> {
    const provider = this.provider();
    const state = secret();
    const nonce = secret();
    const verifier = secret();
    const id = randomUUID();
    const expiresAt = new Date(Date.now() + 5 * 60_000);
    const authorizationUrl = provider.authorizationUrl({ state, nonce, codeVerifier: verifier, redirectUri: this.redirectUri() });
    await this.db.query("DELETE FROM oauth_flows WHERE expires_at < now()-interval '1 day'");
    await this.db.query(
      `INSERT INTO oauth_flows(id,state_hash,nonce,desktop_challenge,provider_verifier,expires_at,
         desktop_client_id,desktop_callback_uri,provider_redirect_uri,provider_client_id)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, hash(state), nonce, codeChallenge, verifier, expiresAt, desktopClientId,
        this.config.desktopCallbackUri, this.redirectUri(), this.config.googleClientId ?? null],
    );
    return { flowId: id, authorizationUrl, expiresAt: expiresAt.toISOString() };
  }

  async callback(state: string, code: string): Promise<string> {
    // Consume the browser state BEFORE network I/O; a failed callback cannot be
    // replayed. The desktop proof is separately required at one-time exchange.
    const claimed = await this.db.query<Flow>(
      `UPDATE oauth_flows SET state_consumed_at=now()
       WHERE state_hash=$1 AND state_consumed_at IS NULL AND expires_at>now()
         AND desktop_client_id=$2 AND desktop_callback_uri=$3 AND provider_redirect_uri=$4
         AND provider_client_id IS NOT DISTINCT FROM $5
       RETURNING *`, [hash(state), desktopClientId, this.config.desktopCallbackUri,
        this.redirectUri(), this.config.googleClientId ?? null],
    );
    const flow = claimed.rows[0];
    if (!flow?.provider_verifier) throw new ApiError(401, 'invalid_flow', 'Sign-in flow expired or was already used.');
    let identity: OidcIdentity;
    try {
      identity = await this.provider().exchange({
        code, nonce: flow.nonce, codeVerifier: flow.provider_verifier, redirectUri: flow.provider_redirect_uri,
      });
    } finally {
      await this.db.query('UPDATE oauth_flows SET provider_verifier=NULL WHERE id=$1', [flow.id]);
    }
    const completionCode = secret();
    const result = await this.db.query(
      `UPDATE oauth_flows SET completion_hash=$1,identity=$2
       WHERE id=$3 AND consumed_at IS NULL AND expires_at>now()`,
      [hash(completionCode), identity, flow.id],
    );
    if (result.rowCount !== 1) throw new ApiError(401, 'invalid_flow', 'Sign-in flow expired. Start again.');
    const callback = new URL(flow.desktop_callback_uri);
    callback.searchParams.set('flowId', flow.id);
    callback.searchParams.set('completionCode', completionCode);
    return callback.toString();
  }

  private async issueTokens(client: PoolClient, authSessionId: string, deviceId: string): Promise<TokenBundle> {
    const accessToken = secret();
    const refreshToken = secret();
    await client.query(
      `INSERT INTO access_tokens(token_hash,auth_session_id,expires_at) VALUES($1,$2,now()+interval '15 minutes')`,
      [hash(accessToken), authSessionId],
    );
    await client.query(
      `INSERT INTO refresh_tokens(token_hash,auth_session_id,expires_at)
       SELECT $1,id,expires_at FROM auth_sessions WHERE id=$2`,
      [hash(refreshToken), authSessionId],
    );
    return { accessToken, refreshToken, tokenType: 'Bearer', expiresIn: 900, deviceId };
  }

  async exchange(input: { flowId: string; completionCode: string; codeVerifier: string; deviceName: string; deviceId?: string | undefined; deviceSecret?: string | undefined }): Promise<TokenBundle> {
    if (Boolean(input.deviceId) !== Boolean(input.deviceSecret)) {
      throw new ApiError(400, 'invalid_device_proof', 'Device identity and proof must be supplied together.');
    }
    return transaction(this.db, async (client) => {
      const result = await client.query<Flow>('SELECT * FROM oauth_flows WHERE id=$1 FOR UPDATE', [input.flowId]);
      const flow = result.rows[0];
      if (!flow || flow.consumed_at || flow.expires_at.getTime() <= Date.now() || !flow.completion_hash || !flow.identity ||
          flow.desktop_client_id !== desktopClientId || flow.desktop_callback_uri !== this.config.desktopCallbackUri ||
          flow.provider_redirect_uri !== this.config.googleRedirectUri || flow.provider_client_id !== (this.config.googleClientId ?? null) ||
          !equal(flow.completion_hash, hash(input.completionCode)) || !equal(flow.desktop_challenge, pkceChallenge(input.codeVerifier))) {
        throw new ApiError(401, 'invalid_flow', 'Sign-in proof is invalid, expired, or already used.');
      }
      const user = await client.query<{ id: string }>(
        `INSERT INTO users(id,google_sub,display_name) VALUES($1,$2,$3)
         ON CONFLICT(google_sub) DO UPDATE SET display_name=EXCLUDED.display_name RETURNING id`,
        [randomUUID(), flow.identity.subject, flow.identity.displayName],
      );
      const userId = user.rows[0]!.id;
      await client.query(
        `INSERT INTO workspaces(id,owner_id,name) VALUES($1,$2,'Personal workspace') ON CONFLICT(owner_id) DO NOTHING`,
        [randomUUID(), userId],
      );
      let deviceId: string;
      let deviceSecret: string | undefined;
      if (input.deviceId && input.deviceSecret) {
        const existing = await client.query<{ id: string; user_id: string; reauth_secret_hash: string | null; revoked_at: Date | null }>(
          'SELECT id,user_id,reauth_secret_hash,revoked_at FROM devices WHERE id=$1 FOR UPDATE',
          [input.deviceId],
        );
        const device = existing.rows[0];
        if (!device || device.revoked_at || !device.reauth_secret_hash || !equal(device.reauth_secret_hash, hash(input.deviceSecret))) {
          throw new ApiError(401, 'invalid_device_proof', 'This device proof is invalid or revoked.');
        }
        if (device.user_id !== userId) throw new ApiError(401, 'device_account_mismatch', 'The verified account needs its own device enrollment.');
        deviceId = device.id;
      } else {
        deviceId = randomUUID();
        deviceSecret = secret();
        await client.query('INSERT INTO devices(id,user_id,name,reauth_secret_hash) VALUES($1,$2,$3,$4)',
          [deviceId, userId, input.deviceName, hash(deviceSecret)]);
      }
      const authSessionId = randomUUID();
      await client.query(
        `INSERT INTO auth_sessions(id,user_id,device_id,expires_at) VALUES($1,$2,$3,now()+interval '30 days')`,
        [authSessionId, userId, deviceId],
      );
      await client.query('UPDATE oauth_flows SET consumed_at=now(),identity=NULL,completion_hash=NULL WHERE id=$1', [flow.id]);
      const tokens = await this.issueTokens(client, authSessionId, deviceId);
      return { ...tokens, ...(deviceSecret ? { deviceSecret } : {}) };
    });
  }

  async refresh(refreshToken: string): Promise<TokenBundle> {
    const outcome = await transaction(this.db, async (client) => {
      const result = await client.query<{
        auth_session_id: string; device_id: string; consumed_at: Date | null;
        expires_at: Date; session_expires_at: Date; revoked_at: Date | null; device_revoked_at: Date | null;
      }>(
        `SELECT r.auth_session_id,r.consumed_at,r.expires_at,a.device_id,a.expires_at AS session_expires_at,
                a.revoked_at,d.revoked_at AS device_revoked_at
         FROM refresh_tokens r JOIN auth_sessions a ON a.id=r.auth_session_id JOIN devices d ON d.id=a.device_id
         WHERE r.token_hash=$1 FOR UPDATE OF a,r FOR SHARE OF d`, [hash(refreshToken)],
      );
      const row = result.rows[0];
      if (!row) return { error: true } as const;
      if (row.consumed_at) {
        // Return and commit before throwing: refresh reuse must revoke all
        // access credentials in this family durably, including a racing winner.
        await client.query('UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1', [row.auth_session_id]);
        return { error: true } as const;
      }
      if (row.revoked_at || row.device_revoked_at || row.expires_at.getTime() <= Date.now() || row.session_expires_at.getTime() <= Date.now()) {
        return { error: true } as const;
      }
      await client.query('UPDATE refresh_tokens SET consumed_at=now() WHERE token_hash=$1', [hash(refreshToken)]);
      return { tokens: await this.issueTokens(client, row.auth_session_id, row.device_id) } as const;
    });
    if ('error' in outcome) throw invalidCredentials();
    return outcome.tokens;
  }

  async authenticateRequest(request: FastifyRequest): Promise<Actor> {
    const authorization = request.headers.authorization;
    if (!authorization || !/^Bearer [A-Za-z0-9_-]{43}$/.test(authorization)) throw invalidCredentials();
    const result = await this.db.query<{ user_id: string; device_id: string; id: string }>(
      `SELECT a.id,a.user_id,a.device_id FROM access_tokens t
       JOIN auth_sessions a ON a.id=t.auth_session_id JOIN devices d ON d.id=a.device_id
       WHERE t.token_hash=$1 AND t.expires_at>now() AND a.expires_at>now()
       AND a.revoked_at IS NULL AND d.revoked_at IS NULL`, [hash(authorization.slice(7))],
    );
    const row = result.rows[0];
    if (!row) throw invalidCredentials();
    return { userId: row.user_id, deviceId: row.device_id, authSessionId: row.id };
  }

  async logout(actor: Actor): Promise<void> {
    await this.db.query('UPDATE auth_sessions SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND user_id=$2', [actor.authSessionId, actor.userId]);
  }

  async me(actor: Actor): Promise<unknown> {
    return transaction(this.db, async (client) => {
      await assertActor(client, actor);
      const result = await client.query(
        `SELECT u.id,u.display_name AS "displayName",w.id AS "workspaceId"
         FROM users u JOIN workspaces w ON w.owner_id=u.id WHERE u.id=$1`, [actor.userId],
      );
      return { ...result.rows[0], deviceId: actor.deviceId };
    });
  }

  async devices(actor: Actor): Promise<unknown> {
    return transaction(this.db, async (client) => {
      await assertActor(client, actor);
      const result = await client.query(
        `SELECT id,name,created_at AS "createdAt",revoked_at AS "revokedAt" FROM devices WHERE user_id=$1 ORDER BY created_at DESC,id LIMIT 101`,
        [actor.userId],
      );
      return { devices: result.rows.slice(0, 100), truncated: result.rows.length > 100 };
    });
  }

  async revokeDevice(actor: Actor, deviceId: string): Promise<void> {
    await transaction(this.db, async (client) => {
      // Same-account cross-device revocations must not each hold a shared lock
      // on their initiating device while waiting to revoke the opposite one.
      await client.query("SELECT pg_advisory_xact_lock(hashtext('device-revoke:' || $1))", [actor.userId]);
      await assertActor(client, actor);
      const result = await client.query(
        'UPDATE devices SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND user_id=$2', [deviceId, actor.userId],
      );
      if (!result.rowCount) throw new ApiError(404, 'device_not_found', 'Device was not found.');
    });
  }
}

export async function registerAuthRoutes(app: FastifyInstance, auth: AuthService): Promise<void> {
  app.post('/v1/auth/google/start', async (request) => {
    const body = z.object({ codeChallenge: opaqueSecret }).strict().parse(request.body);
    return auth.start(body.codeChallenge);
  });
  app.get('/v1/auth/google/callback', async (request, reply) => {
    const query = z.object({ state: opaqueSecret, code: z.string().min(1).max(4_096), scope: z.string().optional(), authuser: z.string().optional(), prompt: z.string().optional() }).parse(request.query);
    return reply.redirect(await auth.callback(query.state, query.code));
  });
  app.post('/v1/auth/google/exchange', async (request) => {
    const body = z.object({
      flowId: z.uuid(), completionCode: opaqueSecret, codeVerifier: verifierSchema,
      deviceName: z.string().trim().min(1).max(120), deviceId: z.uuid().optional(), deviceSecret: opaqueSecret.optional(),
    }).strict().refine(value => Boolean(value.deviceId) === Boolean(value.deviceSecret)).parse(request.body);
    return auth.exchange(body);
  });
  app.post('/v1/auth/refresh', async (request) => {
    const body = z.object({ refreshToken: opaqueSecret }).strict().parse(request.body);
    return auth.refresh(body.refreshToken);
  });
  app.post('/v1/auth/logout', async (request, reply) => {
    await auth.logout(await auth.authenticateRequest(request));
    return reply.code(204).send();
  });
  app.get('/v1/me', async (request) => auth.me(await auth.authenticateRequest(request)));
  app.get('/v1/devices', async (request) => auth.devices(await auth.authenticateRequest(request)));
  app.delete('/v1/devices/:deviceId', async (request, reply) => {
    const { deviceId } = z.object({ deviceId: z.uuid() }).parse(request.params);
    await auth.revokeDevice(await auth.authenticateRequest(request), deviceId);
    return reply.code(204).send();
  });
}
