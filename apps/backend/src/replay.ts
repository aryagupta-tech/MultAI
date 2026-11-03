// Shareable read-only replays. The original host creates a link with an expiry; anyone holding it can
// watch the session's timeline in a browser, without signing in. The token travels in the request
// body (the page reads it from the URL fragment, which browsers never send), and only its hash is
// stored. Events are reduced to what a reader needs: no screenshots, commands or user ids.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { CollaborationService, requireOriginalHost } from './collaboration.js';
import { assertActor, transaction } from './db.js';
import { ApiError } from './errors.js';
import { REPLAY_CSS, REPLAY_HTML, REPLAY_JS } from './replay-page.js';
import type { Actor } from './types.js';

const uuid = z.uuid();
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const DAY = 86_400;
const PAGE = 200;
const TEXT = 16_000;

export interface ReplayEvent {sequence: number; at: string; type: string; who: string | null; data: Record<string, unknown>}

const str = (value: unknown, max = TEXT) => typeof value === 'string' ? value.slice(0, max) : undefined;
/** Only these event types, and only these fields of each, reach a replay. */
export function replayEvent(event: {sequence: number; type: string; actor_id: string | null; payload: unknown; created_at: Date}, label: (userId: string | null) => string | null): ReplayEvent | null {
  const p = (event.payload && typeof event.payload === 'object' ? event.payload : {}) as Record<string, unknown>;
  const base = {sequence: event.sequence, at: event.created_at.toISOString(), type: event.type};
  switch (event.type) {
    case 'message.instruction': case 'message.discussion':
      return str(p.text) ? {...base, who: label(event.actor_id), data: {text: str(p.text), ...(typeof p.image === 'string' ? {screenshot: true} : {})}} : null;
    case 'agent.completed': return str(p.text) ? {...base, who: 'Agent', data: {text: str(p.text)}} : null;
    case 'brief.created': return str(p.text) ? {...base, who: 'Agent', data: {text: str(p.text, 6000)}} : null;
    case 'decision.saved': return str(p.text) ? {...base, who: label(event.actor_id), data: {text: str(p.text, 8000)}} : null;
    case 'activity.completed': case 'activity.failed': {
      if (p.tool === 'update_plan') {
        const steps = Array.isArray((p.plan as {steps?: unknown})?.steps) ? ((p.plan as {steps: unknown[]}).steps).slice(0, 12).flatMap(step => {
          if (!step || typeof step !== 'object' || Array.isArray(step)) return [];
          const s = step as {text?: unknown; state?: unknown};
          return typeof s.text === 'string' && typeof s.state === 'string' && ['todo', 'active', 'done'].includes(s.state) ? [{text: s.text.slice(0, 200), state: s.state}] : [];
        }) : [];
        return steps.length ? {...base, type: 'plan', who: 'Agent', data: {steps}} : null;
      }
      // A summary line and a file path at most; never command output or tool results.
      return {...base, who: 'Agent', data: {summary: str(p.summary, 300) ?? (event.type === 'activity.failed' ? 'An action failed' : 'Used a tool'), ...(str(p.path, 300) ? {path: str(p.path, 300)} : {}), ...(event.type === 'activity.failed' ? {failed: true} : {})}};
    }
    case 'run.started': case 'run.completed': case 'run.failed': case 'run.stopped': case 'instruction.claimed':
      return {...base, who: null, data: {}};
    case 'session.mode_changed': return {...base, who: label(event.actor_id), data: {mode: p.mode === 'build' ? 'build' : 'plan'}};
    case 'participant.admitted': return {...base, who: null, data: {}};
    default: return null;
  }
}

export class ReplayService extends CollaborationService {
  async create(actor: Actor, sessionId: string, input: unknown) {
    const {expiresInSeconds} = z.object({expiresInSeconds: z.number().int().min(DAY).max(30 * DAY).default(7 * DAY)}).strict().parse(input ?? {});
    return transaction(this.db, async client => {
      await assertActor(client, actor);
      const authorized = await this.authorize(client, actor, uuid.parse(sessionId));
      requireOriginalHost(authorized, actor);
      const active = await client.query<{count: number}>('SELECT count(*)::integer AS count FROM replay_links WHERE session_id=$1 AND revoked_at IS NULL AND expires_at>now()', [sessionId]);
      if (active.rows[0]!.count >= 20) throw new ApiError(409, 'replay_capacity', 'Revoke a replay link before creating another.');
      const token = randomBytes(32).toString('base64url');
      const id = randomUUID();
      const created = await client.query<{expires_at: Date}>("INSERT INTO replay_links(id,session_id,token_hash,created_by,expires_at) VALUES($1,$2,$3,$4,now()+$5*interval '1 second') RETURNING expires_at",
        [id, sessionId, digest(token), actor.userId, expiresInSeconds]);
      const expiresAt = created.rows[0]!.expires_at.toISOString();
      // Everyone in the session can see that a public replay exists.
      await this.append(client, authorized.session, actor, 'replay.created', {replayId: id, expiresAt});
      return {replay: {id, token, expiresAt}};
    });
  }
  async list(actor: Actor, sessionId: string) {
    return transaction(this.db, async client => {
      await assertActor(client, actor);
      const authorized = await this.authorize(client, actor, uuid.parse(sessionId));
      requireOriginalHost(authorized, actor);
      const rows = await client.query<{id: string; created_at: Date; expires_at: Date}>('SELECT id,created_at,expires_at FROM replay_links WHERE session_id=$1 AND revoked_at IS NULL AND expires_at>now() ORDER BY created_at DESC', [sessionId]);
      return {replays: rows.rows.map(row => ({id: row.id, createdAt: row.created_at.toISOString(), expiresAt: row.expires_at.toISOString()}))};
    });
  }
  async revoke(actor: Actor, sessionId: string, replayId: string) {
    return transaction(this.db, async client => {
      await assertActor(client, actor);
      const authorized = await this.authorize(client, actor, uuid.parse(sessionId));
      requireOriginalHost(authorized, actor);
      const revoked = await client.query('UPDATE replay_links SET revoked_at=now() WHERE id=$1 AND session_id=$2 AND revoked_at IS NULL', [uuid.parse(replayId), sessionId]);
      if (!revoked.rowCount) throw new ApiError(404, 'replay_not_found', 'That replay link doesn’t exist or was already revoked.');
      await this.append(client, authorized.session, actor, 'replay.revoked', {replayId});
      return {revoked: true};
    });
  }
  /** Public: a page of the cleaned-up timeline for a valid token. */
  async view(input: unknown) {
    const {token, after} = z.object({token: z.string().regex(/^[A-Za-z0-9_-]{43}$/u), after: z.number().int().min(0).max(100_000).default(0)}).strict().parse(input);
    return transaction(this.db, async client => {
      const found = await client.query<{session_id: string; expires_at: Date; title: string | null; mode: string; owner_id: string; created_at: Date; status: string}>(
        `SELECT r.session_id,r.expires_at,s.title,s.mode,s.owner_id,s.created_at,s.status FROM replay_links r JOIN sessions s ON s.id=r.session_id
         WHERE r.token_hash=$1 AND r.revoked_at IS NULL AND r.expires_at>now() AND s.deleted_at IS NULL`, [digest(token)]);
      const link = found.rows[0];
      if (!link) throw new ApiError(404, 'replay_unavailable', 'This replay link has expired, was revoked, or doesn’t exist.');
      const people = await client.query<{user_id: string}>("SELECT user_id FROM session_participants WHERE session_id=$1 ORDER BY role='owner' DESC, admitted_at, user_id", [link.session_id]);
      const labels = new Map<string, string>();
      let teammate = 0;
      for (const row of people.rows) labels.set(row.user_id, row.user_id === link.owner_id ? 'Host' : `Teammate ${++teammate}`);
      const label = (userId: string | null) => userId ? labels.get(userId) ?? 'Former teammate' : null;
      const rows = await client.query<{sequence: number; type: string; actor_id: string | null; payload: unknown; created_at: Date; removed: boolean | null}>(
        `SELECT e.sequence,e.type,e.actor_id,e.payload,e.created_at,q.status='removed' AS removed FROM shared_events e LEFT JOIN instruction_queue q ON q.event_id=e.id
         WHERE e.session_id=$1 AND e.sequence>$2 ORDER BY e.sequence LIMIT $3`, [link.session_id, after, PAGE]);
      // A message taken out of the queue before the agent saw it isn't part of the story.
      const events = rows.rows.filter(row => !row.removed).map(row => replayEvent(row, label)).filter((event): event is ReplayEvent => event !== null);
      const last = rows.rows.at(-1)?.sequence ?? after;
      return {
        // The page keeps asking for newer events, so the same link follows the session live.
        replay: {title: link.title ?? 'Untitled session', mode: link.mode, createdAt: link.created_at.toISOString(), expiresAt: link.expires_at.toISOString(), working: link.status === 'running'},
        events, next: last, done: rows.rows.length < PAGE,
      };
    });
  }
}

const PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

export async function registerReplayRoutes(app: FastifyInstance, service: ReplayService, authenticate: (request: FastifyRequest) => Promise<Actor>) {
  const params = (request: FastifyRequest) => z.object({sessionId: uuid, replayId: uuid.optional()}).parse(request.params);
  app.post('/v1/sessions/:sessionId/replays', async (request, reply) => reply.code(201).send(await service.create(await authenticate(request), params(request).sessionId, request.body)));
  app.get('/v1/sessions/:sessionId/replays', async request => service.list(await authenticate(request), params(request).sessionId));
  app.delete('/v1/sessions/:sessionId/replays/:replayId', async request => {const p = params(request); return service.revoke(await authenticate(request), p.sessionId, p.replayId!);});
  // A watching page checks every few seconds; 60 a minute leaves room for loading a long history.
  app.post('/v1/replays/view', {config: {rateLimit: {max: 60, timeWindow: '1 minute'}}}, async request => service.view(request.body));
  const page = (type: string, body: string) => async (_request: FastifyRequest, reply: import('fastify').FastifyReply) =>
    reply.header('Content-Security-Policy', PAGE_CSP).header('Cache-Control', 'public, max-age=300').type(type).send(body);
  app.get('/replay', page('text/html; charset=utf-8', REPLAY_HTML));
  app.get('/replay.js', page('text/javascript; charset=utf-8', REPLAY_JS));
  app.get('/replay.css', page('text/css; charset=utf-8', REPLAY_CSS));
}
