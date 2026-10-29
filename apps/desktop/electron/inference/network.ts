import {request} from 'node:https';
import {lookup} from 'node:dns';
import {isIP} from 'node:net';
import {Readable} from 'node:stream';

export class ConnectionError extends Error {
  constructor(readonly code: string, message: string) {super(message); this.name = 'ConnectionError';}
}

export function isPublicAddress(input: string): boolean {
  const address = input.replace(/^\[|\]$/g, '').toLowerCase();
  if (isIP(address) === 4) {
    const parts = address.split('.').map(Number);
    const [a = 0,b = 0,c = 0] = parts;
    return !(a === 0 || a === 10 || a === 127 || a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 192 && b === 0 && (c === 0 || c === 2)) ||
      (a === 198 && (b === 18 || b === 19 || b === 51)) ||
      (a === 203 && b === 0 && c === 113));
  }
  // Accept native global unicast, rejecting mapped, local, multicast and transition ranges.
  return isIP(address) === 6 && /^[23][0-9a-f]{3}:/u.test(address) &&
    !/^2001:(?:db8|0):/u.test(address) && !address.startsWith('2002:');
}

export function validateBaseUrl(input: string): string {
  let url: URL;
  try {url = new URL(input);} catch {throw new ConnectionError('invalid_provider_url', 'Enter a valid HTTPS API base URL.');}
  const hostname = url.hostname.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash ||
      (url.port && url.port !== '443') || url.pathname.length > 256 ||
      hostname === 'localhost' || hostname.endsWith('.localhost') || hostname.endsWith('.local') ||
      (isIP(hostname) > 0 && !isPublicAddress(hostname))) {
    throw new ConnectionError('invalid_provider_url', 'Use a public HTTPS API base URL without credentials, query parameters or a custom port.');
  }
  return `${url.origin}${url.pathname.replace(/\/+$/u, '')}`;
}

export type JsonTransport = (url: string, options?: {method?: 'GET' | 'POST'; headers?: Record<string,string>; body?: string; signal?: AbortSignal}) => Promise<unknown>;

/** TLS requests pin a public IPv4 lookup at connection time; redirects are never followed. */
export const requestJson: JsonTransport = async (input, options = {}) => {
  const url = new URL(input);
  validateBaseUrl(`${url.origin}${url.pathname}`);
  const signal = AbortSignal.any([AbortSignal.timeout(15_000), ...(options.signal ? [options.signal] : [])]);
  return new Promise((resolve,reject) => {
    const req = request(url, {
      method: options.method ?? 'GET',
      headers: {...options.headers, accept: 'application/json'},
      signal,
      family: 4,
      lookup: (hostname, _lookupOptions, callback) => {
        lookup(hostname, {family: 4}, (error, address, family) => {
          if (error || !isPublicAddress(address)) callback(new Error('Provider address is unavailable.'), '', 4);
          else callback(null, address, family);
        });
      },
    }, response => {
      if ((response.statusCode ?? 500) < 200 || (response.statusCode ?? 500) >= 300) {
        response.resume();
        reject(new ConnectionError('provider_rejected', `The provider could not accept the request (HTTP ${response.statusCode ?? 500}). Check this connection.`));
        return;
      }
      const parts: Buffer[] = [];
      let bytes = 0;
      response.on('data', (part: Buffer) => {
        bytes += part.length;
        if (bytes > 1_048_576) {req.destroy(); reject(new ConnectionError('provider_response_limit', 'The provider response exceeded the allowed size.')); return;}
        parts.push(part);
      });
      response.on('end', () => {
        try {const text = Buffer.concat(parts).toString('utf8'); resolve(text.length ? JSON.parse(text) as unknown : null);}
        catch {reject(new ConnectionError('invalid_provider_response', 'The provider returned an invalid response.'));}
      });
      response.on('error', () => reject(new ConnectionError('provider_unavailable', 'The provider connection was interrupted.')));
    });
    req.on('error', () => reject(new ConnectionError(signal.aborted ? 'request_canceled' : 'provider_unavailable', signal.aborted ? 'The connection request was canceled or timed out.' : 'The provider is unavailable.')));
    if (options.body) req.write(options.body);
    req.end();
  });
};

/** Streaming provider transport: TLS/public DNS is checked at the actual socket lookup.
 * The caller owns overall/idle/output bounds; this adapter bounds headers and request bytes,
 * preserves Node stream backpressure, and destroys the response when its reader cancels.
 */
export const publicProviderFetch: typeof fetch = async (input, init = {}) => {
  const source = input instanceof Request ? input : undefined;
  const url = new URL(source?.url ?? String(input));
  validateBaseUrl(`${url.origin}${url.pathname}`);
  const method = (init.method ?? source?.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'POST') throw new ConnectionError('invalid_provider_request', 'This provider transport supports only GET and POST.');
  if (init.body !== undefined && init.body !== null && typeof init.body !== 'string') throw new ConnectionError('invalid_provider_request', 'Provider requests require a bounded JSON string body.');
  if (source?.body && init.body === undefined) throw new ConnectionError('invalid_provider_request', 'Streaming request bodies are unavailable for provider requests.');
  const body = typeof init.body === 'string' ? init.body : undefined;
  if (body && Buffer.byteLength(body) > 1_048_576) throw new ConnectionError('provider_request_limit', 'The provider request exceeded the context byte limit.');
  const signal = init.signal ?? source?.signal ?? AbortSignal.timeout(120_000);
  const headers = Object.fromEntries(new Headers(init.headers ?? source?.headers).entries());
  return new Promise<Response>((resolve,reject) => {
    const req = request(url, {
      method,headers,signal,family:4,
      lookup: (hostname,_lookupOptions,callback) => {
        lookup(hostname,{family:4},(error,address,family) => {
          if(error||!isPublicAddress(address))callback(new Error('Provider address is unavailable.'),'',4);
          else callback(null,address,family);
        });
      },
    },response => {
      clearTimeout(headerDeadline);
      const returned = new Headers();
      for(const [name,value] of Object.entries(response.headers)){
        if(Array.isArray(value))for(const item of value)returned.append(name,item);
        else if(value!==undefined)returned.set(name,value);
      }
      const status=response.statusCode??500;
      const stream=[204,205,304].includes(status)?null:Readable.toWeb(response) as ReadableStream<Uint8Array>;
      if(stream===null)response.resume();
      resolve(new Response(stream,{status,headers:returned}));
    });
    const headerDeadline=setTimeout(()=>req.destroy(new Error('Provider headers timed out.')),15_000);
    headerDeadline.unref();
    req.on('error',()=>{
      clearTimeout(headerDeadline);
      reject(signal.aborted ? signal.reason ?? new DOMException('Provider request canceled.','AbortError') : new ConnectionError('provider_unavailable','The provider connection is unavailable.'));
    });
    if(body)req.write(body);
    req.end();
  });
};
