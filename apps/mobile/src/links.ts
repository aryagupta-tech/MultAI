// Only this build's callback scheme and service are allowed to navigate the native app.
import {parseLinks, type Links} from '@multai/companion-ui';

export function nativeLinks(url: string | undefined, serviceOrigin: string, authScheme: string): Links {
  if (!url) return {};
  try {
    const parsed = new URL(url);
    if (parsed.username || parsed.password || parsed.search) return {};
    if (parsed.protocol === `${authScheme}:` && parsed.hostname === 'auth' && parsed.pathname === '/callback' && !parsed.port) {
      // The callback accepts only sign-in; a crafted auth URL cannot also open an invitation.
      const {signin} = parseLinks(parsed.hash);
      return signin ? {signin} : {};
    }
    if (parsed.origin === new URL(serviceOrigin).origin && ['/app', '/app/'].includes(parsed.pathname)) {
      // Sign-in is accepted only on the native callback scheme, never from a web App Link.
      const {pair, review, join} = parseLinks(parsed.hash);
      if (pair) return {pair};
      if (review) return {review};
      if (join) return {join};
    }
  } catch {/* Ignore malformed or unrelated links. */}
  return {};
}
