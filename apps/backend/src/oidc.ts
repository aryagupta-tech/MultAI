import { createHash, timingSafeEqual } from 'node:crypto';
import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from 'jose';
import type { Config } from './config.js';
import { ApiError } from './errors.js';

export interface OidcIdentity {
  subject: string;
  displayName: string;
}

export interface OidcClient {
  authorizationUrl(input: { state: string; nonce: string; codeVerifier: string; redirectUri: string }): string;
  exchange(input: { code: string; codeVerifier: string; redirectUri: string; nonce: string }): Promise<OidcIdentity>;
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

function equal(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function boundedResponseText(response: Response): Promise<string> {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty provider response');
  const parts: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > 64 * 1024) throw new Error('Oversized provider response');
      parts.push(chunk.value);
    }
    return Buffer.concat(parts).toString('utf8');
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
}

/** Also exported to test the real claim/signature checks using synthetic keys. */
export async function verifyGoogleIdentity(
  token: string,
  audience: string,
  nonce: string,
  key: JWTVerifyGetKey,
): Promise<OidcIdentity> {
  try {
    const { payload } = await jwtVerify(token, key, {
      algorithms: ['RS256'],
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience,
      requiredClaims: ['sub', 'exp', 'iat', 'nonce'],
      maxTokenAge: '2h',
      clockTolerance: 5,
    });
    if (typeof payload.nonce !== 'string' || !equal(payload.nonce, nonce) ||
        typeof payload.sub !== 'string' || payload.sub.length < 1 || payload.sub.length > 255) {
      throw new Error('Invalid identity claims');
    }
    const displayName = typeof payload.name === 'string' ? payload.name.trim().slice(0, 120) : '';
    return { subject: payload.sub, displayName: displayName || 'MultAI user' };
  } catch {
    throw new ApiError(401, 'invalid_identity', 'Google identity verification failed. Start sign-in again.');
  }
}

export class GoogleOidcClient implements OidcClient {
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly jwks = createRemoteJWKSet(new URL('https://www.googleapis.com/oauth2/v3/certs'), {
    timeoutDuration: 5_000,
    cooldownDuration: 30_000,
  });

  constructor(config: Config) {
    if (!config.googleClientId || !config.googleClientSecret || !config.googleRedirectUri) {
      throw new ApiError(503, 'identity_unavailable', 'Google sign-in is not configured for this service.');
    }
    this.clientId = config.googleClientId;
    this.clientSecret = config.googleClientSecret;
  }

  authorizationUrl(input: { state: string; nonce: string; codeVerifier: string; redirectUri: string }): string {
    const url = new URL('https://accounts.google.com/o/oauth2/v2/auth');
    url.search = new URLSearchParams({
      client_id: this.clientId,
      redirect_uri: input.redirectUri,
      response_type: 'code',
      scope: 'openid profile',
      state: input.state,
      nonce: input.nonce,
      code_challenge: pkceChallenge(input.codeVerifier),
      code_challenge_method: 'S256',
    }).toString();
    return url.toString();
  }

  async exchange(input: { code: string; codeVerifier: string; redirectUri: string; nonce: string }): Promise<OidcIdentity> {
    let response: Response;
    try {
      response = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: this.clientId,
          client_secret: this.clientSecret,
          redirect_uri: input.redirectUri,
          grant_type: 'authorization_code',
          code: input.code,
          code_verifier: input.codeVerifier,
        }),
        signal: AbortSignal.timeout(5_000),
        redirect: 'error',
      });
      if (!response.ok) throw new Error('Provider rejected code');
      const text = await boundedResponseText(response);
      const body: unknown = JSON.parse(text);
      if (!body || typeof body !== 'object' || !('id_token' in body) || typeof body.id_token !== 'string') {
        throw new Error('Missing ID token');
      }
      return await verifyGoogleIdentity(body.id_token, this.clientId, input.nonce, this.jwks);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(401, 'identity_exchange_failed', 'Google sign-in could not be completed. Start sign-in again.');
    }
  }
}
