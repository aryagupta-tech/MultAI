import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { PoolClient } from 'pg';
import { z } from 'zod';
import { assertActor, transaction, type Database } from './db.js';
import { ApiError } from './errors.js';
import type { Actor } from './types.js';

type Role = 'owner' | 'collaborator' | 'viewer';
export interface SessionRow {
  id: string;
  workspace_id: string;
  owner_id: string;
  host_device_id: string;
  title: string | null;
  mode: 'plan' | 'build';
  status: 'inactive' | 'paused' | 'running';
  runtime_generation: number;
  event_sequence: number;
  deleted_at: Date | null;
  created_at: Date;
  updated_at: Date;
}
export interface AuthorizedSession { session: SessionRow; role: Role }
export interface SharedEvent {
  id: string;
  sessionId: string;
  sequence: number;
  type: string;
  actorId: string | null;
  payload: unknown;
  createdAt: string;
}
interface EventRow {
  id: string; session_id: string; sequence: number; type: string;
  actor_id: string | null; payload: unknown; created_at: Date;
}

const uuid = z.uuid();
const cleanText = (maximum: number) => z.string().trim().min(1).max(maximum)
  .refine((value) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(value), 'Unsupported control character.');
const messageSchema = z.object({ kind: z.enum(['discussion', 'instruction']), text: cleanText(16000) }).strict();
const createSchema = z.object({ requestId: uuid, title: cleanText(120).optional(), message: messageSchema }).strict();
const postMessageSchema = z.object({ requestId: uuid, kind: z.enum(['discussion', 'instruction']), text: cleanText(16000) }).strict();
const secretSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const sessionParams = (request: FastifyRequest) => z.object({ sessionId: uuid }).parse(request.params).sessionId;
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const eventView = (row: EventRow): SharedEvent => ({
  id: row.id, sessionId: row.session_id, sequence: row.sequence, type: row.type,
  actorId: row.actor_id, payload: row.payload, createdAt: row.created_at.toISOString(),
});

function sessionView({ session, role }: AuthorizedSession, actor: Actor) {
  const hostOwner = session.owner_id === actor.userId && session.host_device_id === actor.deviceId;
  return {
    id: session.id, workspaceId: session.workspace_id, ownerId: session.owner_id,
    title: session.title, mode: session.mode, status: session.status,
    runtimeGeneration: session.runtime_generation, lastSequence: session.event_sequence, role,
    createdAt: session.created_at.toISOString(), updatedAt: session.updated_at.toISOString(),
    capabilities: { submit: role !== 'viewer', manage: hostOwner, execute: hostOwner },
  };
}

export function requireOriginalHost(authorized: AuthorizedSession, actor: Actor) {
  if (authorized.session.owner_id !== actor.userId || authorized.session.host_device_id !== actor.deviceId) {
    throw new ApiError(403, 'original_host_required', 'Only the original owner on the original host can do this.');
  }
}
function requireInactive(session: SessionRow) {
  if (session.status !== 'inactive') throw new ApiError(409, 'session_active', 'Stop the session before changing this setting.');
}

/** All shared writes serialize on the session row, including membership changes. */
export class CollaborationService {
  constructor(protected readonly db: Database) {}

  protected async authorize(client: PoolClient, actor: Actor, sessionId: string): Promise<AuthorizedSession> {
    const found = await client.query<SessionRow>('SELECT * FROM sessions WHERE id = $1 FOR UPDATE', [sessionId]);
    const session = found.rows[0];
    if (!session) throw new ApiError(404, 'session_not_found', 'Session not found.');
    if (session.deleted_at) {
      const reader = await client.query('SELECT 1 FROM session_tombstone_readers WHERE session_id = $1 AND user_id = $2', [sessionId, actor.userId]);
      if (reader.rowCount) throw new ApiError(410, 'session_deleted', 'This session was permanently deleted. Remove its cached content.');
      throw new ApiError(404, 'session_not_found', 'Session not found.');
    }
    const member = await client.query<{role: Role; revoked_at: Date | null}>(
      'SELECT role, revoked_at FROM session_participants WHERE session_id = $1 AND user_id = $2', [sessionId, actor.userId],
    );
    if (!member.rows[0] || member.rows[0].revoked_at) {
      throw new ApiError(403, 'membership_required', 'An active admitted membership is required.');
    }
    return { session, role: member.rows[0].role };
  }

  protected async append(client: PoolClient, session: SessionRow, actor: Actor, type: string, payload: unknown): Promise<SharedEvent> {
    // Reserve 256 control events: a full session has at most 99 other active
    // participants and 100 active invitations. Capacity must never trap a grant.
    const capacity = type === 'participant.revoked' || type === 'invitation.revoked' ? 100000 : 99744;
    if (session.event_sequence >= capacity) throw new ApiError(409, 'session_capacity', 'This session has reached its event capacity.');
    const sequence = session.event_sequence + 1;
    const result = await client.query<EventRow>(
      'INSERT INTO shared_events(id,session_id,sequence,type,actor_id,payload) VALUES($1,$2,$3,$4,$5,$6) RETURNING *',
      [randomUUID(), session.id, sequence, type, actor.userId, JSON.stringify(payload)],
    );
    await client.query('UPDATE sessions SET event_sequence=$2, updated_at=now() WHERE id=$1', [session.id, sequence]);
    session.event_sequence = sequence;
    // now() is transaction-local, making returned snapshots deterministic on retry.
    session.updated_at = result.rows[0]!.created_at;
    return eventView(result.rows[0]!);
  }

  private async retryLock(client: PoolClient, actor: Actor, requestId: string) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`request:${actor.userId}:${requestId}`]);
  }
  private async prior(client: PoolClient, actor: Actor, requestId: string, fingerprint: string) {
    const result = await client.query<{fingerprint: string; session_id: string; response: unknown}>(
      'SELECT fingerprint,session_id,response FROM request_results WHERE user_id=$1 AND request_id=$2', [actor.userId, requestId],
    );
    const record = result.rows[0];
    if (!record) return undefined;
    if (record.fingerprint !== fingerprint) throw new ApiError(409, 'idempotency_conflict', 'This retry identity was already used for different content.');
    await this.authorize(client, actor, record.session_id);
    return record.response;
  }
  private async remember(client: PoolClient, actor: Actor, requestId: string, fingerprint: string, sessionId: string, response: unknown) {
    await client.query('INSERT INTO request_results(user_id,request_id,fingerprint,session_id,response) VALUES($1,$2,$3,$4,$5)',
      [actor.userId, requestId, fingerprint, sessionId, JSON.stringify(response)]);
  }

  async createSession(actor: Actor, input: unknown) {
    const body = createSchema.parse(input);
    const fingerprint = digest(JSON.stringify({ operation: 'session.create', deviceId: actor.deviceId, ...body }));
    return transaction(this.db, async (client) => {
      await assertActor(client, actor);
      await this.retryLock(client, actor, body.requestId);
      const previous = await this.prior(client, actor, body.requestId, fingerprint);
      if (previous !== undefined) return previous;
      const workspace = await client.query<{id: string}>('SELECT id FROM workspaces WHERE owner_id=$1', [actor.userId]);
      if (!workspace.rows[0]) throw new ApiError(409, 'workspace_required', 'A personal workspace is required.');
      const result = await client.query<SessionRow>(
        'INSERT INTO sessions(id,workspace_id,owner_id,host_device_id,title) VALUES($1,$2,$3,$4,$5) RETURNING *',
        [randomUUID(), workspace.rows[0].id, actor.userId, actor.deviceId, body.title ?? body.message.text.slice(0, 80)],
      );
      const session = result.rows[0]!;
      await client.query("INSERT INTO session_participants(session_id,user_id,role) VALUES($1,$2,'owner')", [session.id, actor.userId]);
      await this.append(client, session, actor, 'session.created', { mode: 'plan', inferenceEnabled: false });
      const event = await this.addMessage(client, session, actor, body.message);
      const response = { session: sessionView({ session, role: 'owner' }, actor), event };
      await this.remember(client, actor, body.requestId, fingerprint, session.id, response);
      return response;
    });
  }

  async listSessions(actor: Actor, input: unknown) {
    const query = z.object({ after: z.uuid().optional(), limit: z.coerce.number().int().min(1).max(100).default(50) }).strict().parse(input);
    return transaction(this.db, async (client) => {
      await assertActor(client, actor);
      const result = await client.query<SessionRow & {role: Role}>(
        `SELECT s.*,p.role FROM sessions s JOIN session_participants p ON p.session_id=s.id
         WHERE p.user_id=$1 AND p.revoked_at IS NULL AND s.deleted_at IS NULL
           AND ($2::uuid IS NULL OR s.id > $2) ORDER BY s.id LIMIT $3`, [actor.userId, query.after ?? null, query.limit],
      );
      return { sessions: result.rows.map((session) => sessionView({ session, role: session.role }, actor)),
        cursor: result.rows.at(-1)?.id ?? query.after ?? null };
    });
  }

  async getSession(actor: Actor, sessionId: string) {
    uuid.parse(sessionId);
    return transaction(this.db, async (client) => {
      await assertActor(client, actor);
      const authorized = await this.authorize(client, actor, sessionId);
      const participants = await client.query<{user_id: string; role: Role; admitted_at: Date}>(
        'SELECT user_id,role,admitted_at FROM session_participants WHERE session_id=$1 AND revoked_at IS NULL ORDER BY admitted_at,user_id', [sessionId],
      );
      return { session: sessionView(authorized, actor), participants: participants.rows.map((p) => ({userId: p.user_id,role: p.role,admittedAt: p.admitted_at.toISOString()})) };
    });
  }

  private async addMessage(client: PoolClient, session: SessionRow, actor: Actor, message: z.infer<typeof messageSchema>) {
    if (message.kind === 'instruction') {
      const count = await client.query<{count: number}>("SELECT count(*)::integer AS count FROM instruction_queue WHERE session_id=$1 AND status='pending'", [session.id]);
      if (count.rows[0]!.count >= 512) throw new ApiError(409, 'queue_capacity', 'The pending instruction queue is full.');
    }
    const messageId = randomUUID();
    const event = await this.append(client, session, actor, `message.${message.kind}`, {
      messageId, text: message.text, ...(message.kind === 'instruction' ? { queueStatus: 'pending' } : {}),
    });
    if (message.kind === 'instruction') {
      await client.query('INSERT INTO instruction_queue(id,session_id,event_id,author_id) VALUES($1,$2,$3,$4)', [messageId, session.id, event.id, actor.userId]);
    }
    return event;
  }

  async postMessage(actor: Actor, sessionId: string, input: unknown) {
    uuid.parse(sessionId);
    const body = postMessageSchema.parse(input);
    const fingerprint = digest(JSON.stringify({ operation: 'message.create', sessionId, ...body }));
    return transaction(this.db, async (client) => {
      await assertActor(client, actor);
      await this.retryLock(client, actor, body.requestId);
      const authorized = await this.authorize(client, actor, sessionId);
      if (authorized.role === 'viewer') throw new ApiError(403, 'read_only', 'Viewers cannot submit messages or instructions.');
      const previous = await this.prior(client, actor, body.requestId, fingerprint);
      if (previous !== undefined) return previous;
      const event = await this.addMessage(client, authorized.session, actor, body);
      const response = { event };
      await this.remember(client, actor, body.requestId, fingerprint, sessionId, response);
      return response;
    });
  }

  async readEvents(actor: Actor, sessionId: string, after: number, limit = 100): Promise<{events: SharedEvent[]; cursor: number}> {
    uuid.parse(sessionId);
    z.number().int().min(0).max(100000).parse(after);
    z.number().int().min(1).max(100).parse(limit);
    return transaction(this.db, async (client) => {
      await assertActor(client, actor);
      const { session } = await this.authorize(client, actor, sessionId);
      if (after > session.event_sequence) throw new ApiError(409, 'cursor_ahead', 'The replay cursor is ahead of this session.');
      const result = await client.query<EventRow>('SELECT * FROM shared_events WHERE session_id=$1 AND sequence>$2 ORDER BY sequence LIMIT $3', [sessionId, after, limit]);
      return { events: result.rows.map(eventView), cursor: result.rows.at(-1)?.sequence ?? after };
    });
  }

  async setMode(actor: Actor, sessionId: string, input: unknown) {
    const { mode, expectedGeneration } = z.object({ mode: z.enum(['plan', 'build']), expectedGeneration: z.number().int().positive() }).strict().parse(input);
    return transaction(this.db, async (client) => {
      await assertActor(client, actor);
      const authorized = await this.authorize(client, actor, uuid.parse(sessionId));
      requireOriginalHost(authorized, actor);
      requireInactive(authorized.session);
      if (authorized.session.runtime_generation !== expectedGeneration) throw new ApiError(409, 'stale_generation', 'Refresh the session before changing its mode.');
      if (authorized.session.mode !== mode) {
        const nextGeneration = expectedGeneration + 1;
        await client.query('UPDATE sessions SET mode=$2,runtime_generation=$3 WHERE id=$1', [sessionId, mode, nextGeneration]);
        authorized.session.mode = mode;
        authorized.session.runtime_generation = nextGeneration;
        await client.query('DELETE FROM deletion_challenges WHERE session_id=$1', [sessionId]);
        await this.append(client, authorized.session, actor, 'session.mode_changed', { mode, runtimeGeneration: nextGeneration });
      }
      return { session: sessionView(authorized, actor) };
    });
  }

  async createInvitation(actor: Actor, sessionId: string, input: unknown) {
    const { expiresInSeconds } = z.object({ expiresInSeconds: z.number().int().min(60).max(86400).default(3600) }).strict().parse(input);
    return transaction(this.db, async (client) => {
      await assertActor(client, actor);
      const authorized = await this.authorize(client, actor, uuid.parse(sessionId));
      requireOriginalHost(authorized, actor);
      const count = await client.query<{count: number}>('SELECT count(*)::integer AS count FROM invitations WHERE session_id=$1 AND revoked_at IS NULL AND expires_at>now()', [sessionId]);
      if (count.rows[0]!.count >= 100) throw new ApiError(409, 'invitation_capacity', 'Revoke an invitation before creating another.');
      const token = randomBytes(32).toString('base64url');
      const id = randomUUID();
      const result = await client.query<{expires_at: Date}>(
        "INSERT INTO invitations(id,session_id,token_hash,expires_at) VALUES($1,$2,$3,now()+$4*interval '1 second') RETURNING expires_at",
        [id, sessionId, digest(token), expiresInSeconds],
      );
      await this.append(client, authorized.session, actor, 'invitation.created', { invitationId: id, expiresAt: result.rows[0]!.expires_at.toISOString() });
      return { invitation: { id, sessionId, token, expiresAt: result.rows[0]!.expires_at.toISOString() } };
    });
  }

  async revokeInvitation(actor: Actor, sessionId: string, invitationId: string) {
    return transaction(this.db, async (client) => {
      await assertActor(client, actor);
      const authorized = await this.authorize(client, actor, uuid.parse(sessionId));
      requireOriginalHost(authorized, actor);
      const result = await client.query('UPDATE invitations SET revoked_at=now() WHERE id=$1 AND session_id=$2 AND revoked_at IS NULL', [uuid.parse(invitationId), sessionId]);
      if (result.rowCount) await this.append(client, authorized.session, actor, 'invitation.revoked', { invitationId });
      return { revoked: true };
    });
  }

  async requestJoin(actor: Actor, input: unknown) {
    const { token } = z.object({ token: secretSchema }).strict().parse(input);
    return transaction(this.db, async (client) => {
      await assertActor(client, actor);
      // Discover the session, then lock it before checking invite state. Every
      // revocation/admission/deletion uses this same lock order.
      const initial = await client.query<{session_id: string}>('SELECT session_id FROM invitations WHERE token_hash=$1', [digest(token)]);
      if (!initial.rows[0]) throw new ApiError(404, 'invitation_unavailable', 'This invitation is unavailable.');
      const sessionId = initial.rows[0].session_id;
      const found = await client.query<SessionRow>('SELECT * FROM sessions WHERE id=$1 FOR UPDATE', [sessionId]);
      if (!found.rows[0] || found.rows[0].deleted_at) throw new ApiError(404, 'invitation_unavailable', 'This invitation is unavailable.');
      const invitation = await client.query<{id: string}>('SELECT id FROM invitations WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()', [digest(token)]);
      if (!invitation.rows[0]) throw new ApiError(404, 'invitation_unavailable', 'This invitation is unavailable.');
      const member = await client.query('SELECT 1 FROM session_participants WHERE session_id=$1 AND user_id=$2 AND revoked_at IS NULL', [sessionId, actor.userId]);
      if (member.rowCount) return { sessionId, status: 'admitted' as const };
      const previous = await client.query<{id: string; status: string}>('SELECT id,status FROM join_requests WHERE invitation_id=$1 AND user_id=$2', [invitation.rows[0].id, actor.userId]);
      if (previous.rows[0]?.status === 'admitted' || previous.rows[0]?.status === 'revoked') throw new ApiError(403, 'membership_revoked', 'Ask the owner for a new invitation.');
      if (previous.rows[0]) return { requestId: previous.rows[0].id, sessionId, status: 'pending' as const };
      const count = await client.query<{count: number}>('SELECT count(*)::integer AS count FROM join_requests WHERE session_id=$1', [sessionId]);
      if (count.rows[0]!.count >= 1000) throw new ApiError(409, 'join_capacity', 'This session has reached its admission request capacity.');
      const id = randomUUID();
      await client.query('INSERT INTO join_requests(id,session_id,invitation_id,user_id) VALUES($1,$2,$3,$4)', [id, sessionId, invitation.rows[0].id, actor.userId]);
      await this.append(client, found.rows[0], actor, 'participant.join_requested', { requestId: id, userId: actor.userId });
      return { requestId: id, sessionId, status: 'pending' as const };
    });
  }

  async listJoinRequests(actor: Actor, sessionId: string) {
    return transaction(this.db, async (client) => {
      await assertActor(client, actor);
      const authorized = await this.authorize(client, actor, uuid.parse(sessionId));
      requireOriginalHost(authorized, actor);
      const requests = await client.query<{id: string; user_id: string; created_at: Date}>(
        `SELECT j.id,j.user_id,j.created_at FROM join_requests j JOIN invitations i ON i.id=j.invitation_id
         WHERE j.session_id=$1 AND j.status='pending' AND i.revoked_at IS NULL AND i.expires_at>now() ORDER BY j.created_at,j.id LIMIT 1000`, [sessionId],
      );
      return { requests: requests.rows.map((r) => ({ id: r.id, userId: r.user_id, createdAt: r.created_at.toISOString() })) };
    });
  }

  async admit(actor: Actor, sessionId: string, requestId: string, input: unknown) {
    const { role } = z.object({ role: z.enum(['collaborator', 'viewer']) }).strict().parse(input);
    return transaction(this.db, async (client) => {
      await assertActor(client, actor);
      const authorized = await this.authorize(client, actor, uuid.parse(sessionId));
      requireOriginalHost(authorized, actor);
      const found = await client.query<{user_id: string; status: string; admitted_role: string | null}>(
        `SELECT j.user_id,j.status,j.admitted_role FROM join_requests j JOIN invitations i ON i.id=j.invitation_id
         WHERE j.id=$1 AND j.session_id=$2 AND i.revoked_at IS NULL AND i.expires_at>now()`, [uuid.parse(requestId), sessionId],
      );
      const pending = found.rows[0];
      if (!pending) throw new ApiError(404, 'join_request_unavailable', 'This admission request is unavailable.');
      if (pending.status === 'revoked') throw new ApiError(409, 'admission_revoked', 'Create a new invitation to admit this participant again.');
      if (pending.user_id === authorized.session.owner_id) throw new ApiError(409, 'owner_role_fixed', 'The original owner role cannot be replaced.');
      if (pending.status === 'admitted') {
        if (pending.admitted_role !== role) throw new ApiError(409, 'admission_conflict', 'This request was already admitted with another role.');
        const membership = await client.query('SELECT 1 FROM session_participants WHERE session_id=$1 AND user_id=$2 AND revoked_at IS NULL', [sessionId, pending.user_id]);
        if (!membership.rowCount) throw new ApiError(409, 'admission_revoked', 'Create a new invitation to admit this participant again.');
        return { admitted: true, userId: pending.user_id, role };
      }
      const count = await client.query<{count: number}>('SELECT count(*)::integer AS count FROM session_participants WHERE session_id=$1 AND revoked_at IS NULL', [sessionId]);
      if (count.rows[0]!.count >= 100) throw new ApiError(409, 'participant_capacity', 'This session has reached its participant capacity.');
      await client.query(
        `INSERT INTO session_participants(session_id,user_id,role) VALUES($1,$2,$3)
         ON CONFLICT(session_id,user_id) DO UPDATE SET role=$3,revoked_at=NULL,admitted_at=now()`, [sessionId, pending.user_id, role],
      );
      await client.query("UPDATE join_requests SET status='admitted',admitted_role=$2 WHERE id=$1", [requestId, role]);
      await this.append(client, authorized.session, actor, 'participant.admitted', { userId: pending.user_id, role });
      return { admitted: true, userId: pending.user_id, role };
    });
  }

  async revokeParticipant(actor: Actor, sessionId: string, userId: string) {
    return transaction(this.db, async (client) => {
      await assertActor(client, actor);
      const authorized = await this.authorize(client, actor, uuid.parse(sessionId));
      requireOriginalHost(authorized, actor);
      if (uuid.parse(userId) === authorized.session.owner_id) throw new ApiError(409, 'owner_role_fixed', 'The original owner cannot be revoked.');
      const result = await client.query('UPDATE session_participants SET revoked_at=now() WHERE session_id=$1 AND user_id=$2 AND revoked_at IS NULL', [sessionId, userId]);
      if (result.rowCount) {
        // A delayed admission request created before revocation cannot regrant
        // access. A fresh owner-approved invitation/admission is required.
        await client.query("UPDATE join_requests SET status='revoked' WHERE session_id=$1 AND user_id=$2", [sessionId, userId]);
        await this.append(client, authorized.session, actor, 'participant.revoked', { userId });
      }
      return { revoked: true };
    });
  }

  async deletionChallenge(actor: Actor, sessionId: string) {
    return transaction(this.db, async (client) => {
      await assertActor(client, actor);
      const authorized = await this.authorize(client, actor, uuid.parse(sessionId));
      requireOriginalHost(authorized, actor);
      requireInactive(authorized.session);
      const token = randomBytes(32).toString('base64url');
      await client.query(
        `INSERT INTO deletion_challenges(session_id,user_id,device_id,generation,token_hash,expires_at) VALUES($1,$2,$3,$4,$5,now()+interval '1 minute')
         ON CONFLICT(session_id) DO UPDATE SET user_id=$2,device_id=$3,generation=$4,token_hash=$5,expires_at=now()+interval '1 minute'`,
        [sessionId, actor.userId, actor.deviceId, authorized.session.runtime_generation, digest(token)],
      );
      return { sessionId, confirmationToken: token, expiresInSeconds: 60 };
    });
  }

  async deleteSession(actor: Actor, sessionId: string, input: unknown) {
    const { confirmationToken } = z.object({ confirmationToken: secretSchema }).strict().parse(input);
    return transaction(this.db, async (client) => {
      await assertActor(client, actor);
      const authorized = await this.authorize(client, actor, uuid.parse(sessionId));
      requireOriginalHost(authorized, actor);
      requireInactive(authorized.session);
      const challenge = await client.query(
        `DELETE FROM deletion_challenges WHERE session_id=$1 AND user_id=$2 AND device_id=$3 AND generation=$4
         AND token_hash=$5 AND expires_at>now() RETURNING session_id`,
        [sessionId, actor.userId, actor.deviceId, authorized.session.runtime_generation, digest(confirmationToken)],
      );
      if (!challenge.rowCount) throw new ApiError(409, 'confirmation_required', 'Review and confirm this exact session deletion again.');
      await client.query('INSERT INTO session_tombstone_readers(session_id,user_id) SELECT session_id,user_id FROM session_participants WHERE session_id=$1', [sessionId]);
      await client.query('DELETE FROM session_participants WHERE session_id=$1', [sessionId]);
      await client.query('DELETE FROM invitations WHERE session_id=$1', [sessionId]);
      await client.query('DELETE FROM shared_events WHERE session_id=$1', [sessionId]);
      await client.query('DELETE FROM execution_runs WHERE session_id=$1', [sessionId]);
      await client.query('DELETE FROM decisions WHERE session_id=$1', [sessionId]);
      await client.query('UPDATE request_results SET response=NULL WHERE session_id=$1', [sessionId]);
      await client.query("UPDATE sessions SET deleted_at=now(),title=NULL,mode='plan',status='inactive',runtime_generation=runtime_generation+1,updated_at=now() WHERE id=$1", [sessionId]);
      return { deleted: true, sessionId };
    });
  }
}

export async function registerCollaborationRoutes(app: FastifyInstance, dependencies: {
  service: CollaborationService; authenticate: (request: FastifyRequest) => Promise<Actor>;
}): Promise<void> {
  const { service, authenticate } = dependencies;
  app.post('/v1/sessions', async (request, reply) => reply.code(201).send(await service.createSession(await authenticate(request), request.body)));
  app.get('/v1/sessions', async (request) => service.listSessions(await authenticate(request), request.query));
  app.get('/v1/sessions/:sessionId', async (request) => service.getSession(await authenticate(request), sessionParams(request)));
  app.post('/v1/sessions/:sessionId/messages', async (request, reply) => reply.code(201).send(await service.postMessage(await authenticate(request), sessionParams(request), request.body)));
  app.get('/v1/sessions/:sessionId/events', async (request) => {
    const query = z.object({ after: z.coerce.number().int().min(0).max(100000).default(0), limit: z.coerce.number().int().min(1).max(100).default(100) }).strict().parse(request.query);
    return service.readEvents(await authenticate(request), sessionParams(request), query.after, query.limit);
  });
  app.patch('/v1/sessions/:sessionId/mode', async (request) => service.setMode(await authenticate(request), sessionParams(request), request.body));
  app.post('/v1/sessions/:sessionId/invitations', async (request, reply) => reply.code(201).send(await service.createInvitation(await authenticate(request), sessionParams(request), request.body ?? {})));
  app.delete('/v1/sessions/:sessionId/invitations/:invitationId', async (request) => {
    const params = z.object({sessionId: uuid, invitationId: uuid}).parse(request.params);
    return service.revokeInvitation(await authenticate(request), params.sessionId, params.invitationId);
  });
  app.post('/v1/invitations/join', async (request) => service.requestJoin(await authenticate(request), request.body));
  app.get('/v1/sessions/:sessionId/join-requests', async (request) => service.listJoinRequests(await authenticate(request), sessionParams(request)));
  app.post('/v1/sessions/:sessionId/join-requests/:requestId/admit', async (request) => {
    const params = z.object({sessionId: uuid,requestId: uuid}).parse(request.params);
    return service.admit(await authenticate(request), params.sessionId, params.requestId, request.body);
  });
  app.delete('/v1/sessions/:sessionId/participants/:userId', async (request) => {
    const params = z.object({sessionId: uuid,userId: uuid}).parse(request.params);
    return service.revokeParticipant(await authenticate(request), params.sessionId, params.userId);
  });
  app.post('/v1/sessions/:sessionId/deletion-challenge', async (request) => service.deletionChallenge(await authenticate(request), sessionParams(request)));
  app.delete('/v1/sessions/:sessionId', async (request) => service.deleteSession(await authenticate(request), sessionParams(request), request.body));
}
