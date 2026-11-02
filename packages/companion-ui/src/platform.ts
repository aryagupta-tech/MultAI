// What the shared screens need from the browser or the Android shell.
import type {AccountPlatform, ControllerPlatform} from '@multai/companion-core';

export interface Links {pair?: string; review?: string; signin?: string; join?: string}

export interface CompanionPlatform {
  kind: 'web' | 'android';
  /** The MultAI service, e.g. https://api.multai.si. */
  origin: string;
  account: AccountPlatform;
  controller: ControllerPlatform;
  /** Links the app was opened with: #pair=, #review=, #signin= (fragments, never sent to a server). */
  initialLinks(): Links;
  /** Later links (Android App Links and the sign-in callback); returns an unsubscribe. */
  onLink(listener: (links: Links) => void): () => void;
  /** The app came back to the foreground (visibility change, Android resume). */
  onResume(listener: () => void): () => void;
  /** Removes secrets from the visible address after they are read. */
  clearLinks(): void;
  version: string;
}

/** Reads #pair=, #review=, #signin= and #join= from a URL fragment. Anything malformed is ignored. */
export function parseLinks(fragment: string): Links {
  const params = new URLSearchParams(fragment.replace(/^#/u, '').replace(/^\//u, ''));
  const links: Links = {};
  const pair = params.get('pair');
  if (pair && /^[0-9A-Za-z-]{12,16}$/u.test(pair)) links.pair = pair;
  const review = params.get('review');
  if (review && /^[A-Za-z0-9_-]{43}$/u.test(review)) links.review = review;
  // The sign-in hand-off keeps its own format: <flowId>.<completionCode>.
  const signin = /(?:^|[#&])signin=([0-9a-f-]{36}\.[A-Za-z0-9_-]{43})(?:&|$)/u.exec(fragment);
  if (signin) links.signin = `signin=${signin[1]}`;
  const join = params.get('join');
  if (join && /^[A-Za-z0-9_-]{43}$/u.test(join)) links.join = join;
  return links;
}

/** A pasted desktop invitation (multai://join?token=…) or browser review link (…/review#… or …/app/#review=…). */
export function parseInvitation(raw: string): {kind: 'join' | 'review'; token: string} | null {
  const text = raw.trim();
  if(/^[A-Za-z0-9_-]{43}$/u.test(text))return {kind:'join',token:text};
  try {
    const url = new URL(text);
    if ((url.protocol === 'multai:' || url.protocol === 'multai-dev:') && url.hostname === 'join') {
      const token = url.searchParams.get('token') ?? '';
      return /^[A-Za-z0-9_-]{43}$/u.test(token) ? {kind: 'join', token} : null;
    }
    if (url.protocol === 'https:' || url.protocol === 'http:') {
      if (url.pathname === '/review' && /^#[A-Za-z0-9_-]{43}$/u.test(url.hash)) return {kind: 'review', token: url.hash.slice(1)};
      const links = parseLinks(url.hash);
      if (links.join&&['/app','/app/'].includes(url.pathname))return {kind:'join',token:links.join};
      if (links.review) return {kind: 'review', token: links.review};
    }
  } catch {/* not a URL */}
  return null;
}
