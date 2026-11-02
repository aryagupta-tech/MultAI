// HTTP to the MultAI service from a phone browser or the Android app. No secret ever goes into a URL.
import type {z} from 'zod';
import {errorBody} from './wire.js';

export type Auth =
  | {type: 'none'}
  | {type: 'bearer'; token: string}
  /** `token: null` uses the browser's HttpOnly cookie on this origin. */
  | {type: 'controller'; token: string | null}
  | {type: 'review'; token: string};

export type FailureKind = 'http' | 'network' | 'timeout' | 'invalid';
export class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly kind: FailureKind = 'http') {super(message);}
  /** The request may have reached the service: retry only with the same idempotency identity. */
  get uncertain(): boolean {return this.kind === 'network' || this.kind === 'timeout';}
  get offline(): boolean {return this.kind === 'network';}
}

export interface ClientOptions {
  /** Service origin, e.g. https://api.multai.si. */
  origin: string;
  /** `web` is the browser companion on the service's own origin; `app` is the packaged Android app. */
  mode: 'web' | 'app';
  fetch?: typeof fetch;
  timeoutMs?: number;
}

export class ApiClient {
  readonly origin: string;
  readonly mode: 'web' | 'app';
  private readonly fetcher: typeof fetch;
  private readonly timeoutMs: number;
  constructor(options: ClientOptions) {
    const url = new URL(options.origin);
    if (url.origin !== options.origin) throw new TypeError('The service origin must not include a path.');
    if (url.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw new TypeError('The service must use HTTPS.');
    this.origin = url.origin;
    this.mode = options.mode;
    this.fetcher = options.fetch ?? ((input, init) => fetch(input, init));
    this.timeoutMs = options.timeoutMs ?? 15_000;
  }

  async request<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, options: {auth?: Auth; body?: unknown; schema?: z.ZodType<T>; timeoutMs?: number; signal?: AbortSignal} = {}): Promise<T> {
    if (!path.startsWith('/v1/')) throw new TypeError('Only service API paths are allowed.');
    const auth = options.auth ?? {type: 'none'};
    const headers: Record<string, string> = {accept: 'application/json'};
    if (options.body !== undefined) headers['content-type'] = 'application/json';
    if (this.mode === 'web') headers['x-multai-client'] = 'web';
    if (auth.type === 'bearer') headers.authorization = `Bearer ${auth.token}`;
    if (auth.type === 'review') headers.authorization = `Review ${auth.token}`;
    if (auth.type === 'controller' && auth.token) headers.authorization = `Controller ${auth.token}`;
    // Cookies are used only by the browser companion on the service's own origin.
    const cookies = this.mode === 'web' && ((auth.type === 'controller' && !auth.token) || path.startsWith('/v1/web/') || path.startsWith('/v1/controller/'));
    // Built by hand rather than with AbortSignal.timeout/any, which older Android WebViews lack.
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {timedOut = true; controller.abort();}, options.timeoutMs ?? this.timeoutMs);
    const forward = () => controller.abort();
    options.signal?.addEventListener('abort', forward, {once: true});
    let response: Response;
    try {
      response = await this.fetcher(`${this.origin}${path}`, {method, headers, body: options.body === undefined ? null : JSON.stringify(options.body), credentials: cookies ? 'same-origin' : 'omit', cache: 'no-store', redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal});
    } catch {
      if (options.signal?.aborted) throw new ApiError(0, 'aborted', 'Canceled.', 'network');
      if (timedOut) throw new ApiError(0, 'timeout', 'The service took too long to answer.', 'timeout');
      throw new ApiError(0, 'network', 'No connection to MultAI. Check your network.', 'network');
    } finally {clearTimeout(timer); options.signal?.removeEventListener('abort', forward);}
    if (response.status === 204) return undefined as T;
    let data: unknown;
    try {data = await response.json();}
    catch {throw new ApiError(response.status, 'unexpected_response', 'The service sent an unexpected answer.', 'invalid');}
    if (!response.ok) {
      const parsed = errorBody.safeParse(data);
      throw new ApiError(response.status, parsed.success ? parsed.data.error.code : 'request_failed', parsed.success ? parsed.data.error.message : 'The request failed.');
    }
    if (!options.schema) return data as T;
    const parsed = options.schema.safeParse(data);
    if (!parsed.success) throw new ApiError(response.status, 'unexpected_response', 'The service sent an answer this app does not understand. Update the app.', 'invalid');
    return parsed.data;
  }
}

/** Waits that grow and never synchronize across many phones. */
export function backoff(attempt: number, base = 1_000, cap = 30_000): number {
  const exponential = Math.min(cap, base * 2 ** Math.min(attempt, 10));
  return Math.round(exponential / 2 + Math.random() * exponential / 2);
}
