# Browser companion domain migration

Deployed runtime source: `0e2b8e4cf9d310fbef09ea95512414aeb4495bc2` (`multai-backend:0e2b8e4cf9d3`). Built from an immutable Git archive with clean-source provenance. Browser entry: https://app.multai.si/; API and Google provider callback remain on https://api.multai.si. No database migration, Google client change or additional cloud resource.

## Local regression verification

- `npm run test:integration`: 558 passed, zero failures/skips, including 114 backend cases against disposable PostgreSQL 18, 353 desktop cases, 15 shared companion UI cases and 76 other core/native/runtime cases.
- `npm run typecheck` and `npm run build`: passed across workspaces.
- `npm run test:origins --workspace @multai/web`: 7/7 actual built-app/Chromium scenarios against separate HTTP hosts and a real backend/disposable PostgreSQL schema; Google OIDC is synthetic. Covers API-worker redirects, fragment handling, app-bound PKCE/exchange/reload, host-only cookies, explicit join and event polling, original-host-confirmed owner pairing, guest admission/review, download and offline behavior. Cross-host cookie requests and forwarded-host forgery fail. Legacy in-flight API flows remain one-use and origin-bound.
- The download-cache regression was checked negatively: removing only the worker's APK/download exclusion makes the cached offline shell become APK content and the test fail.
- Both Caddy configurations reviewed; deployed configuration validated with the actual Caddy binary before activation.

## Live verification

- Existing server-side database dump restored successfully into an isolated temporary database before rollout. No active agent sessions at activation; prior private environment, image reference and proxy/compose configuration retained on the server for rollback. Backend and proxy healthy after rollout.
- Ten HTTP checks passed: app-root local redirect, direct app HTML/CSP, legacy API browser redirect, direct legacy API auth/assets/worker, cross-host and forwarded-origin refusal, canonical recovery for an old API sign-in start, reachable app cookie-auth route, explicit Android CORS, app PWA manifest and exact signed APK bytes.
- Real Google sign-in in the user's existing Chrome completed its one-time exchange to `https://app.multai.si/app/auth`, with the registered provider callback unchanged at `https://api.multai.si/v1/auth/google/callback`. Signed-in UI persisted after reload; completion fragment and pending flow state were cleared. Page script cannot read the authentication cookie.
- Chromium (Pixel 7 emulation) and WebKit (iPhone 15 emulation) served the app directly, followed an API invitation onto the app host, consumed the invitation fragment and had no page errors or horizontal overflow. Chromium downloaded the actual APK and then opened the cached HTML app offline successfully.
- Android 16 emulator updated with the existing signed 0.1.3 APK/versionCode 4. Genuine domain verification remains `api.multai.si: verified`, without overriding approval state. Normal OS links to API `/app` and `/app/` open MultAI; app-domain links and API `/app/auth` resolve only to Chrome. No Android sign-in or inference performed for this check.
- APK SHA-256 remains `b9a89e140a1d13fba1d87225dd9188d84ac3cec9680bb397a1e31f515599a03b`; signing certificate unchanged. No desktop or APK rebuild required for the domain migration.

Physical iOS/Android hardware was not exercised here. Browser users sign in and pair again on the new origin; old origin cookies and non-extractable keys are deliberately not copied. An already-open old API tab needs a reload when navigation changes only its fragment.
