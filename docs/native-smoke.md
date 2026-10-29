# Native compiled-desktop smoke

Build the runtime/backend/desktop, start the real collaboration service with its migrated local PostgreSQL database, then run from the repository root:

```sh
MULTAI_SERVICE_ORIGIN=http://127.0.0.1:4310 node apps/desktop/scripts/native-smoke.cjs
```

The Node launcher uses the pinned installed Electron binary and loads the **actual compiled desktop main, preload and renderer**. A fresh private temporary app-data/session directory is selected before loading the main process. The smoke keeps its own windows hidden, uses real IPC from its renderer, and stops within a 20-second watchdog. Its generated profile is removed after process exit. It never reads an installed MultAI profile or changes the OS protocol handler. It does not control other apps.

The structured JSON result records actual Electron/Node/Chromium versions, compiled source identity/time/dirty state, loaded artifact hashes, renderer mount, context isolation/sandbox/disabled renderer Node, preload/IPC behavior, signed-out inference denial, secondary untrusted-window IPC rejection and a real backend health/database-readiness response. Source commit must match the current checkout; rebuild after changing revisions. No Google or provider credentials are seeded, and no inference request or browser consent flow is started.

The application attempts its development protocol registration, but the harness records that call and returns failure **without performing OS registration**. Consequently this test provides no evidence for actual OS deep-link routing. The test-only harness and documents are excluded by the package script's `dist/` allowlist.

By default, `osCrypto` reports the native keyring's actual availability/backend without encrypting or saving a credential. To additionally test a random in-memory OS-encryption round trip:

```sh
MULTAI_NATIVE_SMOKE_KEYRING=1 MULTAI_SERVICE_ORIGIN=http://127.0.0.1:4310 node apps/desktop/scripts/native-smoke.cjs
```

That optional test can cause the OS keyring to request access or create application encryption metadata; no secret is printed or saved by the smoke. A missing/locked or Linux `basic_text` backend is reported as unavailable, not silently accepted as credential protection. The result concerns this development Electron process; stable packaged-app signing/keychain identity and upgrade behavior need separate acceptance.

A successful result establishes local compiled desktop startup and the stated boundaries only. Google/ChatGPT consent, real provider inference, exact native action approval, OS deep links, production hosting, trusted signing/notarization and other platform targets require independent acceptance evidence. Run this from a native graphical session; the harness does not disable Chromium's sandbox or replace native windows with a browser fixture.

## Separate real Google sign-in acceptance · 29 October 2026

The owner confirmed successful sign-in in the packaged macOS app after real browser consent. Local database metadata showed one Google user, one consumed Google flow and one active Google sign-in. The app's service-scoped encrypted credential file existed with mode 0600 and size 435 bytes; no credential contents were inspected or printed.

This separately verifies real browser → backend → OS multai-dev:// callback delivery and the native OS-encrypted credential write. It does not change what the automated smoke proves: that harness still stubs protocol registration and seeds no credentials. Cold restart/decryption and live refresh are pending, as are live inference, second-client and public release acceptance. Backend identity readiness remains configured_unverified because it checks configuration, not this recorded live flow. See [verification](verification.md).

Native APIs used: [Electron app paths](https://www.electronjs.org/docs/latest/api/app#appsetpathname-path), [webContents execution for software tests](https://www.electronjs.org/docs/latest/api/web-contents#contentsexecutejavascriptcode-usergesture), and [OS-backed safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage).
