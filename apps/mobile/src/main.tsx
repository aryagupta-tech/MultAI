// The Android shell. Secrets (refresh token, device proof, owner credential) go to the Android Keystore
// through the SecureStore plugin; signing keys are non-extractable WebCrypto keys. Sign-in opens a Custom
// Tab (Google does not allow embedded web views) and comes back on multai-companion://auth/callback.
import {StrictMode} from 'react';
import {createRoot} from 'react-dom/client';
import {App as CapApp} from '@capacitor/app';
import {Browser} from '@capacitor/browser';
import {registerPlugin} from '@capacitor/core';
import {indexedDbKeyStore, safePlainStore, type SecureStore} from '@multai/companion-core';
import {CompanionApp, type CompanionPlatform} from '@multai/companion-ui';
import {nativeLinks} from './links';
import {nativeFlowStore} from './flow-store';
import '@multai/companion-ui/styles.css';

declare const __COMPANION_VERSION__: string;
declare const __SERVICE_ORIGIN__: string;
declare const __AUTH_SCHEME__: string;

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

const linksFrom = (url: string | undefined) => nativeLinks(url, __SERVICE_ORIGIN__, __AUTH_SCHEME__);

const launch = await CapApp.getLaunchUrl().catch(() => undefined);
const flowNames = ['account.pendingFlow', `companion.joinIntent.v1:${new URL(__SERVICE_ORIGIN__).origin}`];
const flows = await nativeFlowStore(secure, flowNames);
// Drop plaintext leftovers from older APKs; a fresh sign-in is safer than importing an untrusted flow.
for (const key of flowNames) {try {localStorage.removeItem(key);} catch {/* Storage can be unavailable. */}}

const platform: CompanionPlatform = {
  kind: 'android',
  origin: __SERVICE_ORIGIN__,
  version: __COMPANION_VERSION__,
  account: {
    secure,
    // The PKCE verifier survives Android ending the app while the Custom Tab is open; it is removed on use.
    flows,
    deviceName,
    openSignIn: async url => {await flows.flush(); await Browser.open({url, presentationStyle: 'fullscreen'});},
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
