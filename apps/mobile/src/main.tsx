// The Android shell. Secrets (refresh token, device proof, owner credential) go to the Android Keystore
// through the SecureStore plugin; signing keys are non-extractable WebCrypto keys. Sign-in opens a Custom
// Tab (Google does not allow embedded web views) and comes back on multai-companion://auth/callback.
import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {App as CapApp} from '@capacitor/app';
import {Browser} from '@capacitor/browser';
import {registerPlugin} from '@capacitor/core';
import {indexedDbKeyStore, safePlainStore, type SecureStore} from '@multai/companion-core';
import {CompanionApp, parseLinks, type CompanionPlatform, type Links} from '@multai/companion-ui';
import '@multai/companion-ui/styles.css';

declare const __COMPANION_VERSION__: string;
declare const __SERVICE_ORIGIN__: string;

interface NativeSecureStore {
  get(options: {key: string}): Promise<{value: string | null}>;
  set(options: {key: string; value: string}): Promise<void>;
  remove(options: {key: string}): Promise<void>;
}
const native = registerPlugin<NativeSecureStore>('SecureStore');
const secure: SecureStore = {
  get: async key => (await native.get({key})).value,
  set: async (key, value) => {await native.set({key, value});},
  remove: async key => {await native.remove({key});},
};

function deviceName(): string {
  const model = /Android [\d.]+; ([^;)]+?)(?: Build|\))/u.exec(navigator.userAgent)?.[1]?.trim();
  return model && model !== 'K' ? `${model} (Android app)` : 'Android phone (app)';
}

/** App links (https://…/app/#pair=…) and the sign-in callback; nothing else is accepted. */
function linksFrom(url: string | undefined): Links {
  if (!url) return {};
  try {
    const parsed = new URL(url);
    const service = new URL(__SERVICE_ORIGIN__);
    if ((parsed.protocol === 'multai-companion:' || parsed.protocol === 'multai-companion-dev:') && parsed.hostname === 'auth' && parsed.pathname === '/callback') return parseLinks(parsed.hash);
    if (parsed.origin === service.origin && parsed.pathname.startsWith('/app')) return parseLinks(parsed.hash);
  } catch {/* ignore */}
  return {};
}

const launch = await CapApp.getLaunchUrl().catch(() => undefined);

const platform: CompanionPlatform = {
  kind: 'android',
  origin: __SERVICE_ORIGIN__,
  version: __COMPANION_VERSION__,
  account: {
    secure,
    // The PKCE verifier survives Android ending the app while the Custom Tab is open; it is removed on use.
    flows: safePlainStore(() => localStorage),
    deviceName,
    openSignIn: async url => {await Browser.open({url, presentationStyle: 'fullscreen'});},
  },
  controller: {secure, plain: safePlainStore(() => localStorage), keys: indexedDbKeyStore(), platform: 'android', deviceName},
  initialLinks: () => linksFrom(launch?.url),
  clearLinks: () => undefined,
  onLink: listener => {
    const handle = CapApp.addListener('appUrlOpen', event => {
      const links = linksFrom(event.url);
      if (links.signin) void Browser.close().catch(() => undefined);
      if (Object.keys(links).length) listener(links);
    });
    return () => {void handle.then(h => h.remove());};
  },
  onResume: listener => {
    const handle = CapApp.addListener('resume', listener);
    return () => {void handle.then(h => h.remove());};
  },
};

createRoot(document.getElementById('root')!).render(<StrictMode><CompanionApp platform={platform} /></StrictMode>);
