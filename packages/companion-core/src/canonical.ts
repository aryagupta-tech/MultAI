// Byte-exact helpers shared by the phone (browser/WebView WebCrypto) and the desktop host (Node WebCrypto).

/** Sorted-key JSON; the service and the host compute the same bytes. */
export function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}

const encoder = new TextEncoder();
export const utf8 = (text: string): Uint8Array<ArrayBuffer> => encoder.encode(text);

export function toBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '');
}
export function fromBase64Url(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*$/u.test(text)) throw new TypeError('Invalid base64url.');
  const binary = atob(text.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - text.length % 4) % 4));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}
export const hex = (bytes: ArrayBuffer | Uint8Array) => [...new Uint8Array(bytes)].map(byte => byte.toString(16).padStart(2, '0')).join('');

export async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', utf8(text)));
}
export async function sha256Hex(text: string): Promise<string> {return hex(await sha256(text));}

/** 32 random bytes as base64url: the 43-character secrets the service accepts. */
export function randomSecret(): string {return toBase64Url(crypto.getRandomValues(new Uint8Array(32)));}
