import { randomUUID } from 'node:crypto';
import Fastify, {LogController} from 'fastify';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { ZodError, z } from 'zod';
import { AuthService, registerAuthRoutes } from './auth.js';
import type { OidcClient } from './oidc.js';
import { CollaborationService, registerCollaborationRoutes } from './collaboration.js';
import type { Config } from './config.js';
import type { Database } from './db.js';
import { ApiError } from './errors.js';
import {ExecutionService,registerExecutionRoutes} from './execution.js';

export interface AppOptions {
  db: Database;
  config: Config;
  oidc?: OidcClient;
  logger?: boolean;
}

export async function buildApp({db, config, oidc, logger = false}: AppOptions) {
  const app = Fastify({
    logger,
    logController: new LogController({disableRequestLogging: true}),
    genReqId: () => randomUUID(),
    requestIdHeader: false,
    trustProxy: false,
    bodyLimit: 65_536,
    requestTimeout: 15_000,
    connectionTimeout: 15_000,
  });
  await app.register(rateLimit, {max: config.environment === 'test' ? 10_000 : 120, timeWindow: '1 minute'});
  await app.register(websocket, {
    options: {maxPayload: 1024, perMessageDeflate: false},
    errorHandler: (_error, socket) => socket.terminate(),
  });
  app.addHook('onRequest', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Referrer-Policy', 'no-referrer');
    reply.header('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
    if (request.ws && request.routeOptions.url !== '/v1/sessions/:sessionId/live') {
      throw new ApiError(404, 'stream_not_found', 'Live stream not found.');
    }
  });
  app.setErrorHandler((error, request, reply) => {
    if (error instanceof ApiError) return reply.code(error.statusCode).send({error: {code: error.code, message: error.message}, requestId: request.id});
    if (error instanceof ZodError) return reply.code(400).send({error: {code: 'invalid_request', message: 'Request fields are invalid.'}, requestId: request.id});
    const framework = error as {statusCode?: number; code?: string};
    if (framework.statusCode && framework.statusCode >= 400 && framework.statusCode < 500) {
      return reply.code(framework.statusCode).send({error: {code: 'invalid_request', message: 'Request could not be accepted.'}, requestId: request.id});
    }
    // Deliberately omit error messages, request URL, headers and payloads.
    request.log.error({requestId: request.id, event: 'request_failed'}, 'Request failed');
    return reply.code(500).send({error: {code: 'internal_error', message: 'The service could not complete this request.'}, requestId: request.id});
  });
  const identityConfigured = Boolean(config.googleClientId && config.googleClientSecret);
  app.get('/health/live', async () => ({service: 'multai-backend', version: '0.0.0-dev.1', developmentBuild: true, inferenceEnabled: true,executionLocation:'original_host'}));
  app.get('/health/ready', async (_request, reply) => {
    try {
      const result = await db.query("SELECT to_regclass('schema_migrations') IS NOT NULL AS migrated");
      if (!result.rows[0]?.migrated) throw new Error('Not migrated');
      return {database: 'ready', identity: identityConfigured ? 'configured_unverified' : 'not_configured', inference: 'host_local'};
    } catch {
      return reply.code(503).send({database: 'unavailable', identity: identityConfigured ? 'configured_unverified' : 'not_configured', inference: 'host_local'});
    }
  });
  const auth = new AuthService(db, config, oidc);
  const service = new CollaborationService(db);
  const execution = new ExecutionService(db);
  await execution.startup();
  app.addHook('onClose',async()=>execution.close());
  await registerAuthRoutes(app, auth);
  await registerCollaborationRoutes(app, {service, authenticate: request => auth.authenticateRequest(request)});
  await registerExecutionRoutes(app,execution,request=>auth.authenticateRequest(request));

  const connectionCounts = new Map<string, number>();
  app.get('/v1/sessions/:sessionId/live', {
    websocket: true,
    preValidation: async request => {
      if (request.headers.origin) throw new ApiError(403, 'native_client_required', 'Use the desktop connection.');
      const actor = await auth.authenticateRequest(request);
      const {sessionId} = z.object({sessionId: z.uuid()}).parse(request.params);
      const {after} = z.object({after: z.coerce.number().int().min(0).max(2_147_483_647).default(0)}).strict().parse(request.query);
      await service.readEvents(actor, sessionId, after, 1);
      if ((connectionCounts.get(actor.authSessionId) ?? 0) >= 8) throw new ApiError(429, 'connection_limit', 'Too many live connections.');
    },
  }, (socket, request) => {
    const {sessionId} = z.object({sessionId: z.uuid()}).parse(request.params);
    let cursor = z.object({after: z.coerce.number().int().default(0)}).parse(request.query).after;
    let timer: NodeJS.Timeout | undefined;
    let authSessionId: string | undefined;
    let stopped = false;
    const stop = () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (authSessionId) {
        const count = (connectionCounts.get(authSessionId) ?? 1) - 1;
        if (count > 0) connectionCounts.set(authSessionId, count);
        else connectionCounts.delete(authSessionId);
        authSessionId = undefined;
      }
    };
    socket.on('close', stop);
    socket.on('error', stop);
    socket.on('message', () => socket.close(1008, 'This stream only sends events.'));
    const tick = async () => {
      if (stopped || socket.readyState !== 1) return;
      try {
        // Recheck bearer expiry, sign-out, device and membership every page.
        const actor = await auth.authenticateRequest(request);
        if (stopped) return;
        if (!authSessionId) {
          const count = connectionCounts.get(actor.authSessionId) ?? 0;
          if (count >= 8) { socket.close(1008, 'Connection limit.'); return; }
          authSessionId = actor.authSessionId;
          connectionCounts.set(authSessionId, count + 1);
        }
        const page = await service.readEvents(actor, sessionId, cursor, 100);
        if (stopped || socket.readyState !== 1) return;
        if (socket.bufferedAmount > 1_048_576) { socket.close(1013, 'Reconnect with your last cursor.'); return; }
        for (const event of page.events) {
          const message = JSON.stringify({type: 'event', event});
          if (socket.bufferedAmount + Buffer.byteLength(message) > 1_048_576) {
            socket.close(1013, 'Reconnect with your last cursor.');
            return;
          }
          socket.send(message);
          cursor = event.sequence;
        }
        timer = setTimeout(() => void tick(), page.events.length === 100 ? 0 : 200);
        timer.unref();
      } catch (error) {
        const code = error instanceof ApiError ? error.code : 'unavailable';
        if (socket.readyState === 1) socket.close(1008, code.slice(0, 100));
      }
    };
    void tick();
  });
  await app.ready();
  return app;
}
