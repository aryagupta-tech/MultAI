// "Look at the app": the agent opens a page of the project in a hidden, sandboxed browser window, takes a
// screenshot and sees it. A page is either an HTML file of the workspace, served read-only from loopback for
// the one look, or a server the host already runs on this computer. SAM 3.1 can outline what the agent asks
// to find, so it gets exact pixel bounds instead of guessing from the picture.
import {randomUUID} from 'node:crypto';
import {createServer,type Server} from 'node:http';
import {readFile,realpath,stat} from 'node:fs/promises';
import path from 'node:path';
import type {Box} from './segment';

export class LookError extends Error {
  constructor(readonly code:string, message:string) {super(message); this.name = 'LookError';}
}

export const VIEWPORT = {width: 1280, height: 800};
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);

/** A loopback http(s) URL, or null when the page is a workspace path. Anything else is refused. */
export function loopbackUrl(page:string):URL|null {
  if (!/^[a-z][a-z0-9+.-]*:/iu.test(page)) return null;
  let url:URL;
  try {url = new URL(page);} catch {throw new LookError('LOOK_INVALID', 'That page address isn’t valid.');}
  if (!['http:', 'https:'].includes(url.protocol) || !LOOPBACK.has(url.hostname) || url.username || url.password) {
    throw new LookError('LOOK_NOT_LOCAL', 'Only pages on this computer can be opened: an HTML file of the project, or http://localhost:PORT.');
  }
  return url;
}

const TYPES:Record<string, string> = {
  '.html': 'text/html; charset=utf-8', '.htm': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json',
};
const MAX_FILE = 5 * 1024 * 1024;
// A page may load its images and fonts (which the agent's file tools refuse), never private or credential files.
const PRIVATE_NAMES = new Set(['.git', '.ssh', '.aws', '.azure', '.config', '.codex', '.claude', '.gnupg', '.npmrc', '.pypirc', '.netrc', '.multai', '.venv', '.local']);
const CREDENTIAL = /(?:^\.env(?:\.|$)|^id_(?:rsa|dsa|ecdsa|ed25519)(?:\.|$)|^(?:credentials|secrets?)(?:$|\.[a-z]+$)|\.(?:pem|key|p12|pfx|der|sqlite|db)$)/iu;
export const privatePath = (relative:string) => relative.split(/[\\/]/u).some(part => PRIVATE_NAMES.has(part.toLowerCase()) || CREDENTIAL.test(part));

/** The workspace file a request path names, or null when it's outside, private, or not a plain file. */
export async function servedFile(root:string, requestPath:string):Promise<string|null> {
  let relative:string;
  try {relative = decodeURIComponent(requestPath.split(/[?#]/u)[0] ?? '/').replace(/^\/+/u, '');} catch {return null;}
  if (relative.includes('\0') || relative.split('/').some(part => part === '..')) return null;
  if (relative === '' || relative.endsWith('/')) relative += 'index.html';
  if (privatePath(relative)) return null;
  const real = await realpath(path.join(root, relative)).catch(() => null);
  const base = await realpath(root);
  if (!real || (real !== base && !real.startsWith(base + path.sep))) return null;
  if (privatePath(path.relative(base, real))) return null;
  const info = await stat(real).catch(() => null);
  if (info?.isDirectory()) return servedFile(root, `/${relative}/`);
  return info?.isFile() && info.size <= MAX_FILE ? real : null;
}

/** Serves the workspace read-only (GET and HEAD) on a random loopback port. */
export async function serveWorkspace(root:string):Promise<{origin:string; close():Promise<void>}> {
  const server:Server = createServer((request, response) => {
    void (async () => {
      if (!['GET', 'HEAD'].includes(request.method ?? '')) {response.writeHead(405).end(); return;}
      const file = await servedFile(root, request.url ?? '/');
      if (!file) {response.writeHead(404, {'content-type': 'text/plain'}).end('Not found'); return;}
      const body = await readFile(file);
      response.writeHead(200, {'content-type': TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff'});
      response.end(request.method === 'HEAD' ? undefined : body);
    })().catch(() => {if (!response.headersSent) response.writeHead(500).end(); else response.end();});
  });
  await new Promise<void>((resolve, reject) => {server.once('error', reject); server.listen(0, '127.0.0.1', () => resolve());});
  const {port} = server.address() as {port:number};
  return {origin: `http://127.0.0.1:${port}`, close: () => new Promise(resolve => {server.closeAllConnections(); server.close(() => resolve());})};
}

export interface Shot {
  /** JPEG data URL for the model. */
  image:string;
  /** A small JPEG data URL that fits a shared session event. */
  thumbnail:string;
  title:string; url:string; text:string;
  viewport:{width:number; height:number};
  consoleErrors:string[]; failedRequests:string[];
  found?:{query:string; boxes:Box[]};
}
export interface LookInput {
  root:string; page:string; find?:string;
  /** Finds what was asked for on a PNG data URL of the page; absent without a Meta connection. */
  locate?:(png:string, query:string, signal:AbortSignal)=>Promise<Box[]>;
  signal:AbortSignal;
}
export type LookAtPage = (input:LookInput)=>Promise<Shot>;

/** The largest JPEG under a byte budget, shrinking quality first and then size. */
export function fitJpeg(encode:(width:number, quality:number)=>Buffer, maxChars:number, widths:number[], qualities:number[]):string {
  for (const width of widths) for (const quality of qualities) {
    const url = `data:image/jpeg;base64,${encode(width, quality).toString('base64')}`;
    if (url.length <= maxChars) return url;
  }
  throw new LookError('LOOK_TOO_LARGE', 'The screenshot couldn’t be made small enough to share.');
}

/** Outlines numbered boxes on top of the page, in viewport pixels. */
export const outlineScript = (boxes:Box[]) => `(() => {
  const layer = document.createElement('div');
  layer.setAttribute('data-multai-outline', '');
  layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647';
  for (const [index, box] of ${JSON.stringify(boxes)}.entries()) {
    const mark = document.createElement('div');
    mark.style.cssText = 'position:absolute;box-sizing:border-box;border:3px solid #e34b51;background:rgba(227,75,81,.12);border-radius:4px;left:' + box.x1 + 'px;top:' + box.y1 + 'px;width:' + (box.x2 - box.x1 + 1) + 'px;height:' + (box.y2 - box.y1 + 1) + 'px';
    const label = document.createElement('span');
    label.textContent = String(index + 1);
    label.style.cssText = 'position:absolute;left:-3px;top:-22px;background:#e34b51;color:#fff;font:600 12px/18px system-ui;padding:0 6px;border-radius:4px';
    mark.appendChild(label); layer.appendChild(mark);
  }
  document.documentElement.appendChild(layer);
})()`;

/** Electron's hidden-window capture. Kept out of the pure helpers above so they can be unit tested. */
export function electronLook():LookAtPage {
  return async ({root, page, find, locate, signal}) => {
    const {BrowserWindow, session} = await import('electron');
    const direct = loopbackUrl(page.trim());
    const served = direct ? null : await serveWorkspace(root);
    let win:Electron.BrowserWindow | null = null;
    const abort = () => win?.destroy();
    signal.addEventListener('abort', abort, {once: true});
    try {
      let target:URL;
      if (direct) target = direct;
      else {
        const relative = page.trim().replace(/^\.?\/+/u, '');
        if (!await servedFile(root, `/${relative}`)) throw new LookError('LOOK_NOT_FOUND', `There's no page at ${relative || 'the workspace root'}. Give the path of an HTML file in the workspace, or a http://localhost URL of a server the host runs.`);
        target = new URL(`/${relative.split('/').map(encodeURIComponent).join('/')}`, served!.origin);
      }
      const partition = `look-${randomUUID()}`;
      const pageSession = session.fromPartition(partition, {cache: false});
      const blocked = new Set<string>(), failed:string[] = [], errors:string[] = [];
      // Loopback is the page itself; elsewhere only subresources it loads (fonts, styles, scripts, images).
      pageSession.webRequest.onBeforeRequest((details, callback) => {
        let url:URL;
        try {url = new URL(details.url);} catch {callback({cancel: true}); return;}
        if (['data:', 'blob:'].includes(url.protocol) || (['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol) && LOOPBACK.has(url.hostname))) {callback({}); return;}
        const subresource = url.protocol === 'https:' && details.method === 'GET' && ['stylesheet', 'script', 'image', 'font', 'media'].includes(details.resourceType);
        if (!subresource) blocked.add(url.host || url.protocol);
        callback({cancel: !subresource});
      });
      pageSession.webRequest.onErrorOccurred(details => {if (failed.length < 10 && details.error !== 'net::ERR_BLOCKED_BY_CLIENT') failed.push(`${details.error} ${details.url.slice(0, 200)}`);});
      pageSession.webRequest.onCompleted(details => {if (failed.length < 10 && details.statusCode >= 400) failed.push(`HTTP ${details.statusCode} ${details.url.slice(0, 200)}`);});
      pageSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
      pageSession.setPermissionCheckHandler(() => false);
      pageSession.on('will-download', event => event.preventDefault());
      win = new BrowserWindow({show: false, width: VIEWPORT.width, height: VIEWPORT.height, useContentSize: true, paintWhenInitiallyHidden: true,
        webPreferences: {partition, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false, offscreen: true, backgroundThrottling: false, spellcheck: false, devTools: false}});
      const contents = win.webContents;
      contents.setWindowOpenHandler(() => ({action: 'deny'}));
      contents.on('will-navigate', (event, url) => {if (new URL(url).origin !== target.origin) event.preventDefault();});
      contents.on('console-message', (event:Electron.Event & {level?:string; message?:string; lineNumber?:number; sourceId?:string}) => {
        if (event.level === 'error' && errors.length < 10) errors.push(`${String(event.message ?? '').slice(0, 300)}${event.sourceId ? ` (${event.sourceId.replace(target.origin, '')}:${event.lineNumber ?? 0})` : ''}`);
      });
      const timeout = new Promise<never>((_resolve, reject) => setTimeout(() => reject(new LookError('LOOK_TIMEOUT', `${target.href} didn’t finish loading in 20 seconds.`)), 20_000).unref());
      await Promise.race([contents.loadURL(target.href).catch((error:unknown) => {
        const message = error instanceof Error ? error.message : '';
        throw new LookError('LOOK_UNREACHABLE', direct && /ERR_CONNECTION_REFUSED/u.test(message) ? `Nothing is running at ${target.origin}. Ask the host to start the dev server, or open an HTML file of the workspace instead.` : `The page didn’t load: ${message.replace(/\s+/gu, ' ').slice(0, 200)}`);
      }), timeout]);
      // Let scripts render, web fonts arrive and transitions settle.
      await Promise.race([contents.executeJavaScript('document.fonts ? document.fonts.ready.then(() => true) : true', true), new Promise(resolve => setTimeout(resolve, 1500))]);
      await new Promise(resolve => setTimeout(resolve, 600));
      signal.throwIfAborted();
      const info = await contents.executeJavaScript('({title: document.title, text: (document.body ? document.body.innerText : "").replace(/\\s+\\n/g, "\\n").slice(0, 3000), width: innerWidth, height: innerHeight})', true) as {title:string; text:string; width:number; height:number};
      let shot = await contents.capturePage();
      // Screenshot pixels are the page's own CSS pixels, so SAM's boxes can be drawn back onto the page.
      if (shot.getSize().width !== info.width) shot = shot.resize({width: info.width, height: info.height});
      let found:Shot['found'];
      if (find && locate) {
        const boxes = (await locate(shot.toDataURL(), find, signal)).slice(0, 8);
        found = {query: find, boxes};
        if (boxes.length) {
          await contents.executeJavaScript(outlineScript(boxes), true);
          await new Promise(resolve => setTimeout(resolve, 150));
          shot = await contents.capturePage();
          if (shot.getSize().width !== info.width) shot = shot.resize({width: info.width, height: info.height});
        }
      }
      const encode = (width:number, quality:number) => (width >= info.width ? shot : shot.resize({width, quality: 'good'})).toJPEG(quality);
      const notes = blocked.size ? [`Blocked requests to ${[...blocked].slice(0, 5).join(', ')}: a looked-at page may only call this computer.`] : [];
      return {
        image: fitJpeg(encode, 100_000, [1024, 896, 768], [72, 58, 45]),
        thumbnail: fitJpeg(encode, 13_000, [560, 480, 400, 320], [55, 40]),
        title: info.title.slice(0, 200), url: direct ? target.href : target.pathname, text: info.text,
        viewport: {width: info.width, height: info.height}, consoleErrors: errors, failedRequests: [...failed, ...notes],
        ...(found ? {found} : {}),
      };
    } finally {
      signal.removeEventListener('abort', abort);
      if (win && !win.isDestroyed()) win.destroy();
      await served?.close();
    }
  };
}
