import {createHash, randomBytes, timingSafeEqual} from 'node:crypto';
import {createServer} from 'node:http';
import {createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey} from 'jose';
import {z} from 'zod';
import {ConnectionError, requestJson, type JsonTransport} from './network';

const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const AUTHORIZE = `${ISSUER}/api/accounts/authorize`;
const TOKEN = `${ISSUER}/api/accounts/oauth/token`;
const JWKS = createRemoteJWKSet(new URL(`${ISSUER}/.well-known/jwks.json`), {timeoutDuration: 5_000, cooldownDuration: 30_000});
const secret = () => randomBytes(32).toString('base64url');
const issuedClient = z.string().regex(/^oaiapp_[A-Za-z0-9_-]{1,240}$/u);
const bearer = z.string().min(1).max(24_000).regex(/^[^\s\u0000-\u001f\u007f]+$/u);
const tokenSchema = z.object({
  access_token: bearer,
  refresh_token: bearer.optional(),
  id_token: bearer.optional(),
  token_type: z.literal('Bearer'),
  expires_in: z.number().int().positive().max(86_400),
  scope: z.string().max(4096).optional(),
  earliest_refresh_at: z.number().optional(),
});

export interface ChatGptRegistration {
  clientId: string;
  hostId: string;
  subject: string | null;
  email?: string;
  accessToken?: string;
  refreshToken?: string;
  idToken?: string;
  scopes: string[];
  expiresAt: number;
  earliestRefreshAt?: number;
  reauthorizationRequired?: boolean;
}

const equal = (a: string, b: string) => {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export async function verifyChatGptIdentity(token: string, clientId: string, nonce: string | undefined, previousSubject: string | null, key: JWTVerifyGetKey = JWKS): Promise<{subject: string; email?: string}> {
  try {
    const {payload} = await jwtVerify(token, key, {
      algorithms: ['RS256', 'ES256'], issuer: ISSUER, audience: clientId,
      requiredClaims: ['sub', 'exp', 'iat'], clockTolerance: 5,
    });
    if (typeof payload.sub !== 'string' || !payload.sub || payload.sub.length > 512 ||
        (nonce !== undefined && (typeof payload.nonce !== 'string' || !equal(payload.nonce, nonce))) ||
        (previousSubject !== null && payload.sub !== previousSubject)) throw new Error('Identity changed');
    const email = typeof payload.email === 'string' && payload.email.length <= 320 ? payload.email : undefined;
    return {subject: payload.sub, ...(email ? {email} : {})};
  } catch {throw new ConnectionError('invalid_chatgpt_identity', 'ChatGPT identity verification failed. Start sign-in again.');}
}

interface Discovery {revocationEndpoint: string}
interface Options {
  openExternal(url: string): Promise<void>;
  transport?: JsonTransport;
  verifyIdentity?: typeof verifyChatGptIdentity;
  now?: () => number;
  timeoutMs?: number;
}

/** Official public-client registration, kept separate from Google collaboration identity. */
export class ChatGptOAuth {
  private readonly transport: JsonTransport;
  private readonly verify: typeof verifyChatGptIdentity;
  private readonly now: () => number;
  constructor(private readonly options: Options) {
    this.transport = options.transport ?? requestJson;
    this.verify = options.verifyIdentity ?? verifyChatGptIdentity;
    this.now = options.now ?? Date.now;
  }

  private async discovery(signal?: AbortSignal): Promise<Discovery> {
    const data = z.object({issuer: z.literal(ISSUER), authorization_endpoint: z.literal(AUTHORIZE), token_endpoint: z.literal(TOKEN), jwks_uri: z.literal(`${ISSUER}/.well-known/jwks.json`), revocation_endpoint: z.url()}).parse(await this.transport(`${ISSUER}/.well-known/openid-configuration`, {...(signal ? {signal} : {})}));
    const endpoint = new URL(data.revocation_endpoint);
    if (endpoint.origin !== ISSUER || endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new ConnectionError('invalid_chatgpt_configuration', 'The identity provider returned an unsupported configuration.');
    return {revocationEndpoint: endpoint.href};
  }

  async signIn(input: {hostId: string; previous?: ChatGptRegistration; requestPlanConsent?:boolean; onRegistered(clientId: string): Promise<void>}, signal: AbortSignal): Promise<ChatGptRegistration> {
    await this.discovery(signal);
    signal.throwIfAborted();
    const state = secret(), nonce = secret(), verifier = randomBytes(64).toString('base64url');
    const previous = input.previous;
    let consumed = false;
    let settle!: (value: {code: string; clientId: string}) => void;
    let fail!: (reason: unknown) => void;
    const callback = new Promise<{code: string; clientId: string}>((resolve,reject) => {settle = resolve; fail = reject;});
    // Attach a rejection handler before a listener can abort; awaiting below still throws.
    void callback.catch(() => undefined);
    const server = createServer((request,response) => {
      response.setHeader('Content-Type', 'text/plain; charset=utf-8');
      response.setHeader('Cache-Control', 'no-store');
      response.setHeader('Referrer-Policy', 'no-referrer');
      response.setHeader('X-Content-Type-Options', 'nosniff');
      response.setHeader('Content-Security-Policy', "default-src 'none'; frame-ancestors 'none'");
      let returned: URL;
      try {returned = new URL(request.url ?? '', 'http://127.0.0.1');} catch {response.writeHead(400).end('Invalid callback.'); return;}
      if (request.method !== 'GET' || returned.pathname !== '/auth/callback' || (request.url?.length ?? 0) > 16_384) {response.writeHead(404).end('Not found.'); return;}
      const returnedState = returned.searchParams.getAll('state');
      if (consumed || returnedState.length !== 1 || !equal(returnedState[0] ?? '', state)) {response.writeHead(400).end('This sign-in callback is invalid.'); return;}
      consumed = true;
      if (returned.searchParams.has('error')) {
        response.writeHead(200).end('ChatGPT connection canceled. You can return to MultAI.');
        fail(new ConnectionError('chatgpt_access_denied', 'ChatGPT authorization was not granted. No connection was activated.'));
        return;
      }
      const codes = returned.searchParams.getAll('code');
      const clients = returned.searchParams.getAll('client_id');
      const clientId = clients[0] ?? previous?.clientId;
      if (codes.length !== 1 || !codes[0] || codes[0].length > 4096 || clients.length > 1 || !issuedClient.safeParse(clientId).success || (previous && clientId !== previous.clientId)) {
        response.writeHead(400).end('The registration did not complete. Return to MultAI and try again.');
        fail(new ConnectionError('invalid_chatgpt_callback', 'The ChatGPT registration callback did not match this sign-in.'));
        return;
      }
      response.writeHead(200).end('ChatGPT authorization received. You can return to MultAI.');
      settle({code: codes[0], clientId: clientId!});
    });
    server.headersTimeout = 5_000;
    server.requestTimeout = 5_000;
    server.maxConnections = 4;
    const cancel = () => fail(new ConnectionError('chatgpt_canceled', 'ChatGPT connection canceled.'));
    signal.addEventListener('abort', cancel, {once: true});
    const timeout = setTimeout(() => fail(new ConnectionError('chatgpt_expired', 'ChatGPT sign-in expired. Start again.')), this.options.timeoutMs ?? 300_000);
    timeout.unref();
    try {
      await new Promise<void>((resolve,reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', resolve);});
      signal.throwIfAborted();
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('No callback address');
      const redirectUri = `http://127.0.0.1:${address.port}/auth/callback`;
      const authorize = new URL(AUTHORIZE);
      authorize.search = new URLSearchParams({
        client_id: previous?.clientId ?? 'dynamic_agent_client',
        ...(previous ? {} : {agent_name_hint: 'MultAI'}),
        ext_agent_host_id: input.hostId,
        response_type: 'code', redirect_uri: redirectUri,
        scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
        resource: RESOURCE, state, nonce,
        code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
        ...(previous?.idToken ? {id_token_hint: previous.idToken} : {}),
        ...(previous?.email ? {login_hint: previous.email} : {}),
        ...(input.requestPlanConsent ? {prompt:'consent'} : {}),
      }).toString();
      await this.options.openExternal(authorize.href);
      const returned = await callback;
      signal.throwIfAborted();
      // Retain the issued registration before exchanging; a lost/invalid code must not
      // make a later attempt register another client for the same host.
      await input.onRegistered(returned.clientId);
      const body = tokenSchema.parse(await this.transport(TOKEN, {
        method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'},
        body: new URLSearchParams({grant_type: 'authorization_code', client_id: returned.clientId, code: returned.code, code_verifier: verifier, redirect_uri: redirectUri, resource: RESOURCE}).toString(), signal,
      }));
      if (!body.id_token) throw new ConnectionError('invalid_chatgpt_identity', 'ChatGPT did not return a verifiable identity.');
      const identity = await this.verify(body.id_token, returned.clientId, nonce, previous?.subject ?? null);
      signal.throwIfAborted();
      return {
        clientId: returned.clientId, hostId: input.hostId, ...identity,
        accessToken: body.access_token, ...(body.refresh_token ? {refreshToken: body.refresh_token} : {}),
        idToken: body.id_token, scopes: (body.scope ?? '').split(/\s+/u).filter(Boolean),
        expiresAt: this.now() + body.expires_in * 1000,
        ...(body.earliest_refresh_at ? {earliestRefreshAt: body.earliest_refresh_at * 1000} : {}),
      };
    } finally {
      clearTimeout(timeout);
      signal.removeEventListener('abort', cancel);
      server.closeAllConnections();
      await new Promise<void>(resolve => {server.close(() => resolve());});
    }
  }

  async refresh(registration: ChatGptRegistration, signal?: AbortSignal): Promise<ChatGptRegistration> {
    if (!registration.refreshToken) throw new ConnectionError('chatgpt_sign_in_required', 'Sign in to this ChatGPT account again.');
    if (registration.earliestRefreshAt && registration.earliestRefreshAt > this.now()) throw new ConnectionError('chatgpt_refresh_not_ready', 'This ChatGPT session cannot refresh yet. Try again shortly.');
    const body = tokenSchema.parse(await this.transport(TOKEN, {
      method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'},
      body: new URLSearchParams({grant_type: 'refresh_token', client_id: registration.clientId, refresh_token: registration.refreshToken, resource: RESOURCE}).toString(),
      ...(signal ? {signal} : {}),
    }));
    if (!body.refresh_token) throw new ConnectionError('chatgpt_refresh_incomplete', 'The ChatGPT refresh outcome is uncertain. Sign in again.');
    const identity = body.id_token ? await this.verify(body.id_token, registration.clientId, undefined, registration.subject) : {subject: registration.subject};
    return {
      ...registration, ...identity, accessToken: body.access_token, refreshToken: body.refresh_token,
      ...(body.id_token ? {idToken: body.id_token} : {}),
      scopes: body.scope === undefined ? registration.scopes : body.scope.split(/\s+/u).filter(Boolean),
      expiresAt: this.now() + body.expires_in * 1000,
      reauthorizationRequired: false,
      ...(body.earliest_refresh_at ? {earliestRefreshAt: body.earliest_refresh_at * 1000} : {}),
    };
  }

  async revoke(registration: ChatGptRegistration): Promise<boolean> {
    if (!registration.refreshToken) return true;
    try {
      const config = await this.discovery();
      // The documented success body is empty; requestJson accepts an empty 2xx body.
      await this.transport(config.revocationEndpoint, {method: 'POST', headers: {'content-type': 'application/x-www-form-urlencoded'}, body: new URLSearchParams({token: registration.refreshToken, token_type_hint: 'refresh_token', client_id: registration.clientId}).toString()});
      return true;
    } catch {return false;}
  }
}
