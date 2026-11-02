// Serves the built browser companion at /app/ from a fixed directory read once at startup. Only files
// found then are served; nothing from the request is ever joined to a filesystem path.
import {createHash} from 'node:crypto';
import {readdir, readFile, stat} from 'node:fs/promises';
import path from 'node:path';
import type {FastifyInstance, FastifyReply, FastifyRequest} from 'fastify';

const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};
/** The page can talk only to this origin and load only its own files. */
export const COMPANION_CSP = "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; connect-src 'self'; font-src 'self'; manifest-src 'self'; worker-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
const LIMIT = 16 * 1024 * 1024;

interface Asset {type: string; body: Buffer; etag: string; immutable: boolean}

async function collect(root: string): Promise<Map<string, Asset>> {
  const assets = new Map<string, Asset>();
  let total = 0;
  const walk = async (folder: string) => {
    for (const entry of await readdir(folder, {withFileTypes: true})) {
      if (entry.name.startsWith('.')) continue;
      const full = path.join(folder, entry.name);
      if (entry.isDirectory()) {await walk(full); continue;}
      if (!entry.isFile()) continue;
      const type = TYPES[path.extname(entry.name).toLowerCase()];
      if (!type) continue;
      const info = await stat(full);
      total += info.size;
      if (total > LIMIT) throw new Error('Companion build exceeds the size limit.');
      const body = await readFile(full);
      const relative = path.relative(root, full).split(path.sep).join('/');
      assets.set(relative, {type, body, etag: `"${createHash('sha256').update(body).digest('base64url').slice(0, 27)}"`, immutable: relative.startsWith('assets/')});
    }
  };
  await walk(root);
  return assets;
}

export async function registerCompanion(app: FastifyInstance, options: {directory?: string | undefined; androidCertificates?: string[] | undefined; androidPackage: string}) {
  const assets = options.directory ? await collect(options.directory).catch(() => new Map<string, Asset>()) : new Map<string, Asset>();
  const index = assets.get('index.html');
  const send = (reply: FastifyReply, asset: Asset, request: FastifyRequest) => {
    reply.header('Content-Security-Policy', COMPANION_CSP);
    reply.header('Cache-Control', asset.immutable ? 'public, max-age=31536000, immutable' : 'no-cache');
    reply.header('ETag', asset.etag);
    reply.header('Cross-Origin-Opener-Policy', 'same-origin');
    reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    if (request.headers['if-none-match'] === asset.etag) return reply.code(304).send();
    return reply.type(asset.type).send(asset.body);
  };
  const unavailable = (reply: FastifyReply) => reply.code(404).type('text/plain; charset=utf-8').send('The MultAI companion is not installed on this service.');
  app.get('/app', async (_request, reply) => reply.redirect('/app/', 308));
  app.get('/app/*', async (request, reply) => {
    const wanted = (request.params as {'*': string})['*'] ?? '';
    const asset = assets.get(wanted);
    if (asset) return send(reply, asset, request);
    // Unknown paths without an extension are app routes; unknown files are missing.
    if (index && !/\.[a-z0-9]+$/iu.test(wanted)) return send(reply, index, request);
    return unavailable(reply);
  });
  app.get('/.well-known/assetlinks.json', async (_request, reply) => {
    if (!options.androidCertificates?.length) return reply.code(404).send({error: {code: 'not_found', message: 'No Android app is published here.'}});
    reply.header('Cache-Control', 'public, max-age=3600');
    return [{relation: ['delegate_permission/common.handle_all_urls'], target: {namespace: 'android_app', package_name: options.androidPackage, sha256_cert_fingerprints: options.androidCertificates}}];
  });
}
