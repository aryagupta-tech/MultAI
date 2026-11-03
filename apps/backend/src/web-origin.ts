import type {FastifyRequest} from 'fastify';
import type {Config} from './config.js';
import {ApiError} from './errors.js';

export const companionWebOrigin = (config: Config): string => config.companionWebOrigin ?? config.publicOrigin;
export const browserOrigins = (config: Config): string[] => [...new Set([companionWebOrigin(config), config.publicOrigin])];

/** Raw Host is preserved by the fixed reverse proxy. Forwarded-origin/host headers never select trust. */
export function requestTargetsOrigin(request: FastifyRequest, origin: string): boolean {
  const host = request.headers.host;
  return typeof host === 'string' && host.toLowerCase() === new URL(origin).host.toLowerCase();
}

/** Browser cookies stay host-only. Both new and legacy pages must call their own origin. */
export function requireBrowserOrigin(request: FastifyRequest, allowed: readonly string[], clientHeader = true): string {
  const target = allowed.find(origin => requestTargetsOrigin(request, origin));
  const origin = request.headers.origin, site = request.headers['sec-fetch-site'];
  if (!target || (clientHeader && request.headers['x-multai-client'] !== 'web') ||
      (origin !== undefined && origin !== target) || (site !== undefined && site !== 'same-origin') ||
      (origin === undefined && request.method !== 'GET' && request.method !== 'HEAD')) {
    throw new ApiError(403, 'origin_denied', 'Open MultAI from its own address.');
  }
  return target;
}
