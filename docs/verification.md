# HTTPS invitations and mobile update · 2 November 2026

Final source gate: **537 passing tests** (106 backend on disposable PostgreSQL 18, 344 desktop, 59 runtime, 8 mobile, 6 companion-core and 14 companion-ui), with zero failures or skips. Workspace typechecks and `npm run build` passed. The Android emulator separately passed 12 lifecycle/control acceptance steps and 2 native manifest/security instrumentation checks. These automated identities, agent responses and provider transports are synthetic.

The signed Android **0.1.2 / versionCode 3** artifact was built from clean source `da37e483e7b124cb62e5c2fa536ec6fb3f63ab06`. Its SHA-256 is `4fff6db77eaf45fb07c6af611c0197882b7fa62ed2f259bfb5f25312fbdae1d6`. Signature verification, production package/callback/CSP, disabled WebView debugging and cleartext, and a same-key update from 0.1.1 passed. Test evidence is in `apps/mobile/test/screenshots/`; the provenance and checksum accompany the APK in `apps/mobile/release/`. The later desktop and service lifecycle fixes do not change this APK's mobile source.

Regressions cover:

- HTTPS invitations, no-download browser joining, Google return/reload preservation, explicit join confirmation and clearing abandoned invitations with browser/hardware Back.
- Android process death during a pending invitation or Google handoff: Keystore-backed flow state, ordered writes and PKCE flush before the Custom Tab opens. Failed storage blocks the handoff.
- Exact native callback/App Link boundaries, production/development scheme separation, signature/package/version checks and refusing a dirty release.
- Browser Google completion at `/app/auth`, outside Android's verified invitation paths; legacy in-flight `/app/` flows keep their original one-use/PKCE binding and return to the safe path. Migration 011 is additive; migration 010 is unchanged.
- Native account reads crossing a rotating refresh; phone-controller recovery after an offline/keyring startup; serialized initialization; sign-out fencing; confirmations/list responses racing local revocation or a newly confirmed phone.
- APK download MIME/attachment headers, bounded metadata-selected redirects and path denial. Image assembly verifies the release checksum/provenance and rejects oversized bundles and altered or dirty artifacts.

Live acceptance is separate: the installed signed-in macOS app and public AWS service admitted disposable Chromium and WebKit browser reviewers; pending access hid the session, admitted users commented, proposed requirements and marked shared screenshots, and revocation hid content again. Google sign-in in ordinary Chrome completed and returned to explicit invitation confirmation. Mobile viewport checks found no horizontal overflow or page errors. A valid **78,438-byte** synthetic screenshot was rejected before the HTTPS proxy fix and accepted afterward; the API's per-route limits remain in place. QA sessions were deleted after these checks. Android's production APK also opened its real Google Custom Tab, without entering credentials or completing phone consent.

Physical phones and actual iPhone Safari have not been exercised. The desktop must remain online and awake; push notifications are not implemented. Current service and download links are in the [mobile guide](mobile-companion.md).

## Live rollout acceptance

The deployed Linux service and installed macOS release both identify clean source `8af4c0a98523dea7552dc1202831834cea7d6288`; the database has all 11 migrations. `/app/` and `/app/auth` return the companion. The public `/app/android` redirects to APK 0.1.2: **7,920,205 bytes**, Android APK MIME, attachment disposition, and the exact `4fff6d…dae1d6` checksum above. The published metadata and Android certificate agree with the signed artifact.

After deployment, ordinary Google Chrome sign-out/sign-in completed through real Google and returned to `/app/auth` with explicit **Ask to join**, no fragment left in the address and no error. Browser sign-out did not sign out the desktop. The final installed Mac build restored its saved account and both AI connections; phone initialization succeeded. Normal macOS launch was verified and the duplicate release-build registration was removed, keeping `/Applications/MultAI.app` as the production handler.

Live Chromium mobile emulation paired with the installed desktop through the public AWS service. Host and phone computed matching check digits; the host confirmed the keys. A signed phone **Start** request caused a real **Muse Wonder 1.0** request using the existing Meta connection/credits, returning `MOBILE_OK` without tools or project-file changes. The phone retained its owner keys after reload, and native revocation removed access. This is real service/provider acceptance using an emulated phone browser, separate from the synthetic control tests. Temporary QA sessions were deleted and phone grants revoked afterward.

On the Android 16 emulator, the OS genuinely verified `api.multai.si` against the published signing certificate. A normal ACTION_VIEW/BROWSABLE invitation cold-started the installed APK and rendered **Join a session** with the Google button, without automatically submitting a join request. `/app/auth`, `/app/auth/`, `/app/android`, `/application` and `/app/other` remain browser routes. Native Google sign-in still hands off to Chrome; phone credentials/consent were not entered. APK install/update and browser routing were tested on the emulator, not physical hardware.

Production backups stayed on the server and passed disposable, network-isolated restoration before deployment. The final schema was backed up and restore-tested again after rollout. No cloud resources or DNS changes were added.

---

# Desktop audit · 2 November 2026

The later [desktop bug-fix audit](bugfix-audit.md) records 493 passing tests across the current workspaces, native clipboard/cold-invitation checks, browser interaction coverage, and a real Muse Wonder checkout failure/repair/recovery session through MultAI. It distinguishes the installed build used for live inference from the newly rebuilt source, and records deployment limits.

---

# Mobile companion · 2 November 2026

The browser companion, the Android app and phone owner control ([guide](mobile-companion.md)). The full suite passed **425 tests: 100 backend, 254 desktop, 59 runtime, 6 companion-core, 6 companion-ui; zero failures or skips** (`npm run test:integration`, disposable PostgreSQL 18). Root typecheck passed for all eight workspaces. Identities, model output and the agent are synthetic; no Google, model provider or production service was contacted, and no production data was touched.

## What was tested, and how

| Layer | How | Result |
|---|---|---|
| Service (real PostgreSQL) | 11 new integration tests | Pairing is desktop-initiated, one-use and expires; a substituted key or wider scope cannot be confirmed; declined/revoked/expired phones, revoked host devices and deleted sessions lose access at once. Collaborators, guests, the owner's other devices and plain sign-ins cannot pair, poll or acknowledge. Duplicate taps return one request; a reused id with new content, a tampered field, a changed command fingerprint, a stale generation, an expired or future request, a cross-session request and another phone's envelope are refused. Concurrent controllers both reach the host; acknowledgements are idempotent and attributed. Stop cancels waiting requests. Conflict decisions bind the exact queue. Host reports are validated, aged and coarse for participants. Cookies are HttpOnly/SameSite=Strict and refused without the page's header or with a cross-site Origin/Sec-Fetch-Site; CORS only for header routes; `/app/` serves only its build with a strict CSP; browser and Android sign-ins reuse the Google redirect with fragment hand-off. |
| Desktop host | 9 vitest cases, real P-256 keys and the real approval broker | Exact-fingerprint approval, first decision wins against a simultaneous desktop decision, Stop invalidates late approvals, forged/foreign/out-of-scope/expired/stale/pre-reconnect requests refused, start/resolve bound to the reviewed queue, local revocation works offline, previews encrypted to the phone, check digits computed locally, IPC arguments validated. |
| Shared packages | node:test + vitest | WebCrypto (phone) and Node (service) agree byte for byte on envelopes, signatures, thumbprints and check digits; private keys are non-extractable; previews open only for that phone and action; status never says online without a fresh report; timeline output is escaped and attributed; request states never read as done before the desktop says so. |
| Browsers | `apps/web/test/e2e.ts`: real service process, real `RemoteControlHost`, Playwright | **30/30 steps**: Chromium with Pixel 7 emulation (Android Chrome) and WebKit with iPhone 15 emulation (iPhone Safari): pairing with matching digits, start + approve, reload, Stop, offline, desktop asleep, rotation, revocation, collaborator view with XSS payload, keyboard/composer, screenshot region marking with edge clamping, guest admission and revocation, no script errors; 24 requests/min while an owner screen is open. |
| Android app | `apps/mobile/test/android-e2e.ts` on an **emulator** (Android 16, WebView 133, userdebug image) | **11/11 steps** with the installed test APK: CSP, pairing, credential only as Keystore ciphertext, non-extractable keys, start + approve, Stop, rotation, process death, in-place update keeping the pairing, downgrade refused, revocation erasing the credential, uninstall. |
| Release APK | Manual `adb` on the same emulator | 0.1.0 → 0.1.1 installs and updates with the release key, downgrade refused (`INSTALL_FAILED_VERSION_DOWNGRADE`), backup flag absent, uninstall removes it. The packaged config disables WebView debugging and the CSP allows only `https://api.multai.si`. Two builds of 0.1.0 from the same commit were byte-identical. |
| Service image | Local `docker build` | Builds with the companion at `/service/companion`; no React, Vite or Playwright in the service's `node_modules`. |

## Not established

No physical Android phone and no real iPhone were available: Android results are from an emulator, iPhone results from WebKit emulation in Playwright. Real Google consent on a phone, Android App Links verification and the hosted URL need the production deploy, which was **prepared but not performed**. On the userdebug emulator image, Android's WebView exposes DevTools for every app; the release APK sets debugging off and is not debuggable, but that could not be observed on a user build.

---

# Team review verification · 2 November 2026

The combined `main` implementation now includes team-approved requirements, source-bound process evidence, separate read-only model review, scoped browser guests, screenshot annotations and host conflict decisions. The final full suite passed **384 tests: 89 backend, 237 desktop, 58 runtime; zero failures or skips**, compared with the prior 320-test baseline. Root typecheck, build and `git diff --check` passed. Tests used a disposable PostgreSQL 18 container, real temporary source files/processes and SQLite journals; no production data was modified.

## New edge cases checked

- Requirement approval, versions and locked command bytes; wrong actors/devices, viewers, revoked identity, cross-session IDs and immutable retries are denied. Concurrent revisions cannot overwrite one another. Changing a decision or requirement invalidates old evidence even when source bytes remain identical.
- Evidence rejects fabricated status fields and substituted commands. Nonzero/unknown exits, termination, cancellation, rejected approvals, source mutations and missing results cannot produce passing proofs. Manual acceptance stays separate from automated verdicts. Latest-proof ordering follows session sequence even when transaction clocks disagree.
- Native revision fingerprints include safe tracked/untracked source bytes, deletions and executable bits, and reject symlinks, special/oversized/changing files. Real shell tests exercise locked commands, failed outcomes, refusal, cancellation and source-changing checks. Output fits the backend limit with a visible truncation marker.
- The reviewer has a fresh context and read-only tools. Malicious write/command calls are denied. Requirement changes between preparation and the actual run cannot execute an old check. Unavailable connections/models do not leave an orphan verifier instruction. A model-review outage preserves completed process evidence while disclosing the missing review.
- Browser guests see no private session content before admission. Guest credentials cannot call native execution routes. Invitation expiry/revocation, participant revocation, session deletion, concurrent retries, wrong origins, XSS payloads, screenshot sharing/bounds and capacity behavior are tested. Late responses cannot restore content after leaving.
- Conflict resolutions bind the exact queue, preserve attribution and remove superseded alternatives. Changed/removed/steered directions reject stale choices. Cross-author steering halts for review, and restarting does not bypass it. Model comparisons validate source IDs and remain advisory. Browser feedback reaches builder/catch-up context without acquiring instruction authority.
- Renderer tests cover viewer restrictions, stale evidence while running, prior human acceptance, escaped names/content and native service routing.

## Actual browser and native checks

An isolated Electron/Chromium browser exercised the served review page against a local service and disposable PostgreSQL, with explicitly synthetic identities and fixture data. Admission, comments, requirement proposals, human acceptance, pointer-drag screenshot annotation, 390-pixel layout, network failure/recovery, leaving, reload, reopening the same invitation tab, re-admission and host revocation passed. Database rows confirmed the actual mutations.

The newly compiled macOS arm64 app passed native renderer/preload mounting, real IPC, sandbox/context isolation, untrusted-window rejection, signed-out denial for review/verification/conflict endpoints, and an actual macOS Keychain encryption/decryption round trip. The existing hosted backend was contacted only for its health endpoint; protocol registration was stubbed and no real account or provider was used.

## Limits and deployment

This is broad regression coverage, not proof of every possible edge case. Live Meta/other-provider inference, real multi-person use and interactive OAuth were not retested. Provider outputs in integration tests were synthetic. iOS Safari and Android hardware were not exercised; the mobile check used a phone-sized Chromium viewport. Windows/Linux installer checks run separately in CI.

Deploy the current backend with migrations **008–009** and use the matching new desktop build before trying the workflow on the hosted service. No cloud deployment, production migration, native mobile app, APK, TestFlight build or Apple membership purchase was performed in this change. See [team review](team-review.md) for the source fingerprint's environmental limits and polling freshness.

---

# Verification · 2 November 2026

The current combined `main` checkout was reviewed directly; no historical branch or application changes were reapplied. Baseline: **303 passing tests**. After the edge-case regressions and fixes: **320 passing tests — 63 backend, 199 desktop, 58 runtime; zero failures or skips**. `npm run test:integration` used a disposable PostgreSQL 18 container without changing the existing development database. Root typecheck, build and `git diff --check` passed on Node 24.22.0/macOS arm64.

## Edge cases verified in this pass

- Replay list/revoke revalidate authentication within the transaction; a full session still permits revocation of all 20 public watch links.
- Typing expires while other users keep sending presence updates; multiple devices report the latest viewed file instead of connection order.
- Parallel agents preserve conflicting host edits when applying their merge, including binary files and file/directory transitions. Stop waits for sibling tasks to finish unwinding before deleting their worktrees, and authorization is checked again before applying.
- Concurrent project registration preserves both records and reuses the same ID for the same project.
- Pending microphone grants cannot start a canceled recording; repeated clicks request permission once. Audio initialization failure releases the microphone. Canceled or previous-account transcripts cannot modify drafts or clear a newer transcription's busy state; rejected IPC calls restore the controls.
- Large and JSON-escaped shell output completes within the durable journal limit and replays without executing again. Unicode truncation respects the byte limit.
- SSE limits count UTF-8 bytes; a hung transport cancellation does not defeat the stream deadline.

The complete suites also exercised existing OAuth/connection rejection, permission and revocation boundaries, one-use approvals, journal recovery, path confinement, provider stream failures, project worktrees, projections and composer behavior. Backend CI now runs on `main` pushes as well as backend pushes and pull requests.

## Native checks and limits

The compiled Electron 44.9.3 development app was exercised with a disposable profile against the existing `https://api.multai.si` health endpoint. Renderer mounting, preload/IPC, sandbox/context isolation, unavailable renderer Node, signed-out inference denial, untrusted-window rejection, database readiness and an actual macOS Keychain encryption/decryption round trip passed. The local API on port 4310 was not running, so its first health-dependent smoke failed before using the hosted endpoint.

This pass does not establish exhaustive coverage of every possible edge case. No real provider inference or interactive Google/ChatGPT consent was performed, no deployed service was changed, and Windows/Linux installer acceptance remains a separate CI check. The native harness stubs OS protocol registration and does not verify a real browser sign-in callback. The older evidence below is historical, not a statement of today's deployment state.

---

# Historical verification · 29 October 2026

Evidence belongs to this new implementation in the isolated backend checkout. Tooling uses Node **v24.22.0**; the native smoke used Electron **44.9.3** on **macOS arm64**. No historical test counts, older installers or copied application binaries establish acceptance for this build.

## Automated checks

The completed full npm test run passed **179 tests: 42 backend, 99 desktop and 38 runtime; 0 failed, 0 skipped**. Root typecheck and builds passed. The root scripts build the runtime before dependent checks.

- Real PostgreSQL locks/transactions cover concurrent sends/refreshes, migration integrity, roles/admission/revocation, replay, decisions, selected-instruction attribution, original-host leases, exact action claims, stale callbacks, Stop/capacity and restart recovery.
- Actual loopback WebSocket and temporary OAuth callback listeners test replay/revocation and synthetic identity flow boundaries.
- Real SQLite files cover exclusive execution ownership, exact descriptors, Plan/account/device/payer checks, one-use reservations, uncertain recovery, ordered outbox delivery and private file/path behavior.
- Actual bounded file/process tests cover controlled workspaces and POSIX cancellation; synthetic provider streams cover framing, interruption, limits, tool routing and safe failures.
- Desktop tests cover account/storage races, provider connection scopes, synthetic signed OIDC rejection, explicit instruction IDs, streaming projections and decision history.
- Final regressions cover sanitized HTTP/SSE usage errors, incomplete or inconsistent provider tool turns, cancellation of buffered stream events, IPC argument injection, connection-removal fencing and preservation of ordinary executable-file permissions.

Run npm run test:integration for a disposable pinned PostgreSQL **18.6** container; it is removed afterward and does not touch the Compose database. Standalone npm test needs a dedicated TEST_DATABASE_URL. Synthetic storage adapters do not verify an actual keyring, and synthetic provider streams/tokens do not establish live API success.

## Native smoke and build provenance

The actual compiled app passed renderer/preload loading, bridge IPC, sandbox/context isolation, signed-out authorization denial, rejection of an untrusted window and real configured database health. The native script is apps/desktop/scripts/native-smoke.cjs.

In this automated smoke, macOS reported keychain-backed safeStorage available. A credential encryption/decryption round trip was **not requested or verified by the harness**. Protocol intent used a stub without OS registration; that smoke does not verify end-to-end multai-dev:// delivery. The separate real sign-in below supplies callback and encrypted-write evidence.

The development app used for the first real Google sign-in was packaged/ad-hoc signed from a **dirty** source checkout. Subsequent package builds record their exact commit, dirty state and hashes in the adjacent build-manifest.json. Verify that manifest before testing or sharing a build. Local ad-hoc signing does not establish notarization or fresh-download trust.

## Infrastructure and live acceptance

[Deployment verification](../deploy/VERIFICATION.md) records actual private Linux container startup/restart, non-root/private database behavior and encrypted PostgreSQL dump/restore. Matching-key restoration passed; wrong-key and tampered-file attempts were rejected. No AWS bucket upload, cloud instance or public listener was involved.

A fresh Google project/web OAuth client is configured in the ignored local .env, with the owner's single development tester admitted. Billing is unlinked; Google compute/model services were not enabled. The current local backend reports **identity: configured_unverified**. This remains a configuration probe, not a live sign-in attestation, even after the independent acceptance below.

## Real Google native sign-in · 29 October 2026

The owner explicitly confirmed **“Signed in successfully”** in the packaged macOS app after real Google browser consent. Local database metadata independently showed **one Google user, one consumed Google flow and one active Google sign-in**. The packaged app's service-scoped encrypted credential file existed with mode **0600** and size **435 bytes**; only filesystem metadata was checked, without reading or printing credential values.

Together these establish one successful browser consent → backend verification → real OS multai-dev:// callback → native completion and OS-encrypted credential write. This was a real interactive flow, separate from synthetic OAuth fixtures and the protocol stub used by the automated native smoke. The file metadata does not establish successful decryption after a cold restart. Cold restart/decryption, live refresh rotation, native account switching/revocation and a second installed client remain unverified.

No live inference credential has been authorized in this acceptance record. ChatGPT/OpenAI/Claude/Kimi live requests, public DNS/TLS, AWS deployment, production OAuth, two-user native coding and public release acceptance remain outstanding.
