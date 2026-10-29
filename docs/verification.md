# Verification · 29 October 2026

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
