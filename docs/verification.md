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
