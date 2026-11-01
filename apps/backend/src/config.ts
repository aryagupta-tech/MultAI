import { z } from 'zod';

export interface Config {
  host: string;
  port: number;
  databaseUrl: string;
  publicOrigin: string;
  desktopCallbackUri: string;
  /** Fixed public desktop client identity bound into every sign-in flow. */
  desktopClientId: string;
  googleClientId?: string;
  googleClientSecret?: string;
  googleRedirectUri?: string;
  environment: 'development' | 'test' | 'production';
  /** Private proxy addresses whose X-Forwarded-For is believed (per-client rate limits). */
  trustedProxies: string[];
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const values = z.object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4310),
    DATABASE_URL: z.url(),
    PUBLIC_ORIGIN: z.url().default('http://127.0.0.1:4310'),
    DESKTOP_CALLBACK_URI: z.url().optional(),
    GOOGLE_CLIENT_ID: z.string().min(1).optional(),
    GOOGLE_CLIENT_SECRET: z.string().min(1).optional(),
    TRUST_PROXY: z.string().optional(),
  }).parse(env);
  const origin = new URL(values.PUBLIC_ORIGIN);
  if (!['http:', 'https:'].includes(origin.protocol) || origin.username || origin.password || origin.search || origin.hash || origin.pathname !== '/') {
    throw new Error('PUBLIC_ORIGIN must be an HTTP(S) origin without a path or credentials.');
  }
  const db = new URL(values.DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(db.protocol)) throw new Error('DATABASE_URL must use PostgreSQL.');
  // Production serves the release app (multai://); development and test serve development builds
  // (multai-dev://). Each environment accepts only its own fixed callback.
  const production = values.NODE_ENV === 'production';
  const expectedCallback = production ? 'multai://auth/callback' : 'multai-dev://auth/callback';
  const callback = new URL(values.DESKTOP_CALLBACK_URI ?? expectedCallback);
  if (callback.href !== expectedCallback) {
    throw new Error(`DESKTOP_CALLBACK_URI must be ${expectedCallback} when NODE_ENV is ${values.NODE_ENV}.`);
  }
  if (values.NODE_ENV === 'production' && (origin.protocol !== 'https:' || origin.hostname === 'localhost' || origin.hostname === '127.0.0.1')) {
    throw new Error('Production requires a public HTTPS origin.');
  }
  if (values.NODE_ENV !== 'production' && !['127.0.0.1', 'localhost', '[::1]'].includes(origin.hostname) && origin.protocol !== 'https:') {
    throw new Error('Cleartext HTTP is allowed only on loopback.');
  }
  if (values.NODE_ENV !== 'production' && !['127.0.0.1', 'localhost', '::1'].includes(values.HOST)) {
    throw new Error('Development and test services must bind to a loopback host.');
  }
  const trustedProxies = (values.TRUST_PROXY ?? '').split(',').map(entry => entry.trim()).filter(Boolean);
  // Only private IPv4 ranges: trusting a public address would let anyone pick their own client IP.
  const privateRange = /^(10\.\d{1,3}|172\.(1[6-9]|2\d|3[01])|192\.168)\.\d{1,3}\.\d{1,3}(\/(1[6-9]|2\d|3[0-2]))?$/;
  if (trustedProxies.some(entry => !privateRange.test(entry))) throw new Error('TRUST_PROXY accepts only private IPv4 addresses or ranges.');
  if (Boolean(values.GOOGLE_CLIENT_ID) !== Boolean(values.GOOGLE_CLIENT_SECRET)) throw new Error('Configure both Google client fields or neither.');
  return {
    host: values.HOST,
    port: values.PORT,
    databaseUrl: values.DATABASE_URL,
    publicOrigin: origin.origin,
    desktopCallbackUri: callback.href,
    desktopClientId: production ? 'multai-desktop' : 'multai-desktop-development',
    environment: values.NODE_ENV,
    trustedProxies,
    ...(values.GOOGLE_CLIENT_ID ? {
      googleClientId: values.GOOGLE_CLIENT_ID,
      googleClientSecret: values.GOOGLE_CLIENT_SECRET!,
      googleRedirectUri: `${origin.origin}/v1/auth/google/callback`,
    } : {}),
  };
}
