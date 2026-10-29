import { z } from 'zod';
import type { Result, ServiceOp } from '../../src/bridge/contract';
import { type Account, toError } from './account';
import type { LiveHub } from './live';

const uuid = z.uuid();
const kind = z.enum(['discussion', 'instruction']);
const text = z.string().min(1).max(16_000);

// Every renderer-supplied argument is validated here before any request is built.
const schemas = {
  health: z.tuple([]),
  authState: z.tuple([]),
  signIn: z.tuple([]),
  cancelSignIn: z.tuple([]),
  signOut: z.tuple([]),
  listSessions: z.tuple([]),
  getSession: z.tuple([uuid]),
  readEvents: z.tuple([uuid, z.number().int().min(0)]),
  createSession: z.tuple([z.object({ requestId: uuid, title: z.string().min(1).max(120).optional(), message: z.object({ kind, text }).strict() }).strict()]),
  postMessage: z.tuple([uuid, z.object({ requestId: uuid, kind, text }).strict()]),
  setMode: z.tuple([uuid, z.object({ mode: z.enum(['plan', 'build']), expectedGeneration: z.number().int().positive() }).strict()]),
  createInvitation: z.tuple([uuid, z.number().int().min(60).max(86_400)]),
  joinInvitation: z.tuple([z.string().min(16).max(200).regex(/^[A-Za-z0-9_-]+$/)]),
  listJoinRequests: z.tuple([uuid]),
  admit: z.tuple([uuid, uuid, z.enum(['collaborator', 'viewer'])]),
  revokeParticipant: z.tuple([uuid, uuid]),
  deleteSession: z.tuple([uuid]),
  subscribe: z.tuple([uuid, z.number().int().min(0)]),
  unsubscribe: z.tuple([uuid]),
} satisfies Record<ServiceOp, z.ZodType>;

export function isServiceOp(op: unknown): op is ServiceOp {
  return typeof op === 'string' && Object.hasOwn(schemas, op);
}

async function wrap<T>(fn: () => Promise<T>): Promise<Result<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (e) {
    return { ok: false, error: toError(e) };
  }
}

export async function route(account: Account, live: LiveHub, op: ServiceOp, rawArgs: unknown): Promise<unknown> {
  const parsed = schemas[op].safeParse(rawArgs);
  if (!parsed.success) return { ok: false, error: { code: 'invalid_request', message: 'The app sent an invalid request.' } } satisfies Result<never>;
  const args = parsed.data as unknown[];
  const s = (i: number) => args[i] as string;
  const req = account.request.bind(account);

  switch (op) {
    case 'health': return account.health();
    case 'authState': return account.state();
    case 'signIn': return account.signIn();
    case 'cancelSignIn': return account.cancelSignIn();
    case 'signOut':
      live.closeAll();
      return account.signOut();
    case 'listSessions': return wrap(async () => {
      // Follow cursors so the sidebar sees every membership, bounded to 10 pages.
      const sessions: unknown[] = [];
      let after: string | null = null;
      for (let page = 0; page < 10; page++) {
        const q: string = after ? `?limit=100&after=${after}` : '?limit=100';
        const res = (await req('GET', `/v1/sessions${q}`)) as { sessions: unknown[]; cursor: string | null };
        sessions.push(...res.sessions);
        // The cursor is always set; a short page is the real end.
        if (res.sessions.length < 100 || !res.cursor) break;
        after = res.cursor;
      }
      return { sessions };
    });
    case 'getSession': return wrap(() => req('GET', `/v1/sessions/${s(0)}`));
    case 'readEvents': return wrap(() => req('GET', `/v1/sessions/${s(0)}/events?after=${args[1] as number}&limit=100`));
    case 'createSession': return wrap(() => req('POST', '/v1/sessions', args[0]));
    case 'postMessage': return wrap(() => req('POST', `/v1/sessions/${s(0)}/messages`, args[1]));
    case 'setMode': return wrap(() => req('PATCH', `/v1/sessions/${s(0)}/mode`, args[1]));
    case 'createInvitation': return wrap(() => req('POST', `/v1/sessions/${s(0)}/invitations`, { expiresInSeconds: args[1] }));
    case 'joinInvitation': return wrap(() => req('POST', '/v1/invitations/join', { token: s(0) }));
    case 'listJoinRequests': return wrap(() => req('GET', `/v1/sessions/${s(0)}/join-requests`));
    case 'admit': return wrap(() => req('POST', `/v1/sessions/${s(0)}/join-requests/${s(1)}/admit`, { role: s(2) }));
    case 'revokeParticipant': return wrap(() => req('DELETE', `/v1/sessions/${s(0)}/participants/${s(1)}`));
    case 'deleteSession': return wrap(async () => {
      // The renderer has already shown its own explicit confirmation; the one-use challenge
      // binds this deletion to the session's current generation and our device.
      const challenge = (await req('POST', `/v1/sessions/${s(0)}/deletion-challenge`)) as { confirmationToken: string };
      await req('DELETE', `/v1/sessions/${s(0)}`, { confirmationToken: challenge.confirmationToken });
      live.unsubscribe(s(0));
      return null;
    });
    case 'subscribe':
      live.subscribe(s(0), args[1] as number);
      return null;
    case 'unsubscribe':
      live.unsubscribe(s(0));
      return null;
  }
}
