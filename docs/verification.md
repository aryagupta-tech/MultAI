# Backend verification · 29 October 2026

Executed from the isolated `backend` checkout using Node v24.22.0 on macOS. All evidence here belongs to this new implementation; no historical test counts or binaries were used.

- `npm run typecheck`: passed for `@multai/backend` and `@multai/runtime`.
- `npm run build`: passed; backend and runtime JavaScript produced with a development build manifest.
- `npm run test:integration`: **41 passed, 0 failed, 0 skipped**. The runner created and removed its own PostgreSQL container. PostgreSQL version: **18.6**, official image digest recorded in `compose.yaml`.
- Backend: 25 tests cover concurrent first-send/message/refresh requests, signed synthetic OIDC token rejection, same-device reauthentication, revoked/expired authority, role and admission rules, deletion and retry fencing, transactional migration integrity/rollback, actual native loopback WebSocket replay/sign-out/revocation, bounded validation and readiness.
- Runtime: 16 tests use real temporary SQLite files for exact descriptor/host/Plan/generation checks, one-use reservations, uncertain recovery, private initial permissions and symlink rejection, exclusive executor ownership, completed retries, ordered outbox delivery under equal/backward timestamps and persisted rejection history.

OIDC identities, signing keys and participants in automated tests are explicitly synthetic. Real Google consent, installed desktop clients, OS-encrypted native credential storage, host file tools, central action reservations, provider inference, native cancellation, installer targets, deployment and public release acceptance have **not** been completed. Passing these tests does not establish those capabilities.
