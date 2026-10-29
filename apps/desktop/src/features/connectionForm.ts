// Client-side checks for the AI connection form. They mirror the main process rules in
// electron/inference/connections.ts and network.ts so people get instant feedback; the main
// process still validates everything independently.

import type { AddConnectionInput, ConnectionSummary } from '../bridge/inference';

export type ApiProvider = AddConnectionInput['provider'];

export const PROVIDERS: { id: ApiProvider; label: string; host: string; keyHint: string }[] = [
  { id: 'openai', label: 'OpenAI', host: 'api.openai.com', keyHint: 'sk-…' },
  { id: 'anthropic', label: 'Claude', host: 'api.anthropic.com', keyHint: 'sk-ant-…' },
  { id: 'kimi', label: 'Kimi', host: 'api.moonshot.ai', keyHint: 'sk-…' },
  { id: 'compatible', label: 'Compatible', host: 'Your HTTPS endpoint', keyHint: 'Provider API key' },
];

export const NAME_MAX = 80;
export const KEY_MAX = 8192;
export const URL_MAX = 1024;

const CONTROL = /[\u0000-\u001f\u007f]/u;

export function keyError(raw: string): string | null {
  const key = raw.trim();
  if (!key) return null; // Empty is "not ready", not an error.
  if (key.length > KEY_MAX) return `API keys can be at most ${KEY_MAX.toLocaleString()} characters.`;
  if (/\s/u.test(key) || CONTROL.test(key)) return 'API keys can’t contain spaces or line breaks. Check that you pasted only the key.';
  return null;
}

export function nameError(raw: string): string | null {
  const name = raw.trim();
  if (!name) return null;
  if (name.length > NAME_MAX) return `Names can be at most ${NAME_MAX} characters.`;
  if (CONTROL.test(name)) return 'Names can’t contain line breaks or control characters.';
  return null;
}

export function baseUrlError(raw: string): string | null {
  const input = raw.trim();
  if (!input) return null;
  if (input.length > URL_MAX) return 'That address is too long.';
  let url: URL;
  try {
    url = new URL(input);
  } catch {
    return 'Enter a full address, like https://provider.example/v1.';
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (url.protocol !== 'https:') return 'Use an https:// address.';
  if (url.username || url.password) return 'Remove the username or password from the address.';
  if (url.search || url.hash) return 'Remove query parameters (?…) and fragments (#…) from the address.';
  if (url.port && url.port !== '443') return 'Custom ports aren’t supported. Use the provider’s standard HTTPS address.';
  if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local')) return 'Local addresses aren’t allowed. Use the provider’s public address.';
  if (isPrivateIp(host)) return 'Private network addresses aren’t allowed. Use the provider’s public address.';
  return null;
}

function isPrivateIp(host: string): boolean {
  const v4 = host.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (host.includes(':')) return host === '::1' || host === '::' || /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
  return false;
}

export interface FormState {
  provider: ApiProvider;
  name: string;
  apiKey: string;
  baseUrl: string;
}

export function formErrors(f: FormState) {
  return {
    name: nameError(f.name),
    apiKey: keyError(f.apiKey),
    baseUrl: f.provider === 'compatible' ? baseUrlError(f.baseUrl) : null,
  };
}

export function canSubmit(f: FormState): boolean {
  const e = formErrors(f);
  return Boolean(f.apiKey.trim()) && (f.provider !== 'compatible' || Boolean(f.baseUrl.trim())) && !e.name && !e.apiKey && !e.baseUrl;
}

export function toInput(f: FormState): AddConnectionInput {
  return {
    provider: f.provider,
    apiKey: f.apiKey.trim(),
    ...(f.name.trim() ? { name: f.name.trim() } : {}),
    ...(f.provider === 'compatible' ? { baseUrl: f.baseUrl.trim() } : {}),
  };
}

export function statusLabel(status: ConnectionSummary['status']): { text: string; tone: 'ok' | 'warn' } {
  if (status === 'ready') return { text: 'Ready', tone: 'ok' };
  if (status === 'sign-in-required') return { text: 'Sign-in needed', tone: 'warn' };
  return { text: 'Plan permission needed', tone: 'warn' };
}

export function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return baseUrl;
  }
}

export const MAX_CONNECTIONS = 32;
