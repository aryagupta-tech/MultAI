// The browser companion calls /v1/ on its own origin, proxied to the service. Secrets live only in HttpOnly cookies (sign-in
// refresh and owner pairing) and non-extractable WebCrypto keys in IndexedDB; page script can use the
// keys but never read them. Links carry tokens only in the fragment, which is cleared after reading.
import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {indexedDbKeyStore, safePlainStore} from '@multai/companion-core';
import {CompanionApp, parseLinks, type CompanionPlatform} from '@multai/companion-ui';
import '@multai/companion-ui/styles.css';

declare const __COMPANION_VERSION__: string;

// Chromium's keyboard can resize the layout; WebKit does not understand this viewport option.
// Add it only with the corresponding API so unsupported browsers keep a valid viewport declaration.
if ('virtualKeyboard' in navigator) {
  const viewport=document.querySelector<HTMLMetaElement>('meta[name="viewport"]');
  if(viewport)viewport.content+=', interactive-widget=resizes-content';
}

function deviceName(): string {
  const ua = navigator.userAgent;
  const browser = /CriOS|Chrome\//u.test(ua) && !/Edg\//u.test(ua) ? 'Chrome' : /Edg\//u.test(ua) ? 'Edge' : /Firefox|FxiOS/u.test(ua) ? 'Firefox' : /Safari\//u.test(ua) ? 'Safari' : 'Browser';
  const device = /iPhone/u.test(ua) ? 'iPhone' : /iPad|Macintosh.*Mobile/u.test(ua) ? 'iPad' : /Android/u.test(ua) ? 'Android' : /Mac OS X/u.test(ua) ? 'Mac' : /Windows/u.test(ua) ? 'Windows' : 'phone';
  return `${browser} on ${device}`;
}
const ios = /iPhone|iPad/u.test(navigator.userAgent);
// Read link tokens once and take them out of the address bar before anything renders.
const opened = parseLinks(location.hash);
if (location.hash) history.replaceState(null, '', location.pathname);

const platform: CompanionPlatform = {
  kind: 'web',
  origin: location.origin,
  version: __COMPANION_VERSION__,
  account: {
    secure: null,
    flows: safePlainStore(() => sessionStorage),
    deviceName,
    openSignIn: async url => {location.assign(url);},
  },
  controller: {
    secure: null,
    plain: safePlainStore(() => localStorage),
    keys: indexedDbKeyStore(),
    platform: ios ? 'ios' : 'web',
    deviceName,
  },
  initialLinks: () => opened,
  clearLinks: () => {if (location.hash) history.replaceState(history.state, '', location.pathname);},
  onLink: listener => {
    const changed = () => {const links = parseLinks(location.hash); if (Object.keys(links).length) {history.replaceState(history.state, '', location.pathname); listener(links);}};
    window.addEventListener('hashchange', changed);
    return () => window.removeEventListener('hashchange', changed);
  },
  onResume: listener => {
    const visible = () => {if (document.visibilityState === 'visible') listener();};
    const shown = (event: PageTransitionEvent) => {if (event.persisted) listener();};
    document.addEventListener('visibilitychange', visible);
    window.addEventListener('pageshow', shown);
    return () => {document.removeEventListener('visibilitychange', visible); window.removeEventListener('pageshow', shown);};
  },
};

createRoot(document.getElementById('root')!).render(<StrictMode><CompanionApp platform={platform} /></StrictMode>);

if ('serviceWorker' in navigator && window.isSecureContext) {
  window.addEventListener('load', () => {void navigator.serviceWorker.register('/app/sw.js', {scope: '/app/'}).catch(() => undefined);});
}
