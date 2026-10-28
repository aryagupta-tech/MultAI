# MultAI backend · development foundation

A fresh TypeScript implementation of the collaboration service and host-local safety library described in [MultAI.md](docs/MultAI.md). This is an early backend milestone. The desktop application, inference engines, native workspace tools and production deployment are still to be implemented and verified.

The collaboration service stores shared conversation and membership in PostgreSQL. Source files, project paths, shell processes and inference credentials stay outside this service. Sending an instruction records a pending instruction; it does not start inference or execute an action.

## Run locally

Use Node **24** and npm. Docker is a development/test dependency; installed MultAI users will not need it.

```sh
npm ci --ignore-scripts
cp .env.example .env
docker compose up -d database
npm run dev:backend
```

The service binds to `127.0.0.1:4310` and applies checksum-verified migrations under a PostgreSQL transaction/advisory lock. `GET /health/live` reports the development identity. `GET /health/ready` reports database readiness separately from Google configuration and disabled inference. Stop the service with Ctrl+C; `docker compose stop database` retains the development database.

Google sign-in requires a **new web OAuth client** with the exact callback `http://127.0.0.1:4310/v1/auth/google/callback` for this local setup. Add its ID/secret to the ignored `.env`. No authentication bypass or development login endpoint is provided. The desktop callback identity for this development build is `multai-dev://auth/callback`; native protocol registration and OS-encrypted token/device-secret storage remain desktop work. A configured client is not evidence of a successful live Google sign-in.

```sh
npm run typecheck
npm run build
npm run test:integration
```

The integration command starts an isolated official PostgreSQL 18 container on a random loopback port, runs the backend and real SQLite tests, and removes that container. It does not touch the Compose database or existing volumes. Alternatively, set `TEST_DATABASE_URL` to a **dedicated test database** and run `npm test`; tests create and drop their own randomly named schemas. WebSocket tests use actual loopback connections. Tests use conspicuously synthetic users/OIDC keys; they do not establish live Google, provider or desktop acceptance.

`npm run build` emits backend JavaScript and `apps/backend/dist/build-manifest.json` with the source commit, dirty state, build time and artifact hashes. Run the compiled service with `npm start --workspace @multai/backend`. Keep the backend `migrations/` directory beside `dist/`. The separate runtime library builds into `packages/runtime/dist/` and must be deliberately integrated into a trusted native host.

## Implemented boundaries

- Google OIDC verification and PKCE, one-use desktop completion, hashed opaque access/refresh credentials, rotating refresh tokens with reuse detection, device revocation and same-device proof.
- Personal workspace creation, attributed discussion and pending instructions, owner/collaborator/viewer permissions and original-device management controls.
- Durable first-send/message retry identities and transactional, strictly ordered shared events. Paginated HTTP replay and a read-only WebSocket stream recheck bearer credentials and admitted membership on every page.
- Invitations create pending admission requests; owners must explicitly admit participants. Revocation denies HTTP/replay and closes live connections on their next authority check (normally within 200 ms plus database latency).
- Plan by default; only the original owner/device changes an inactive session's mode. Inference remains disabled in both modes.
- One-use, generation/device-bound deletion confirmation. Shared content is purged; minimal deletion tombstones tell former participants to discard cached history. Host files are untouched.
- A separate SQLite journal provides exact approval fingerprints, original-host authority checks, Plan enforcement, one-use dispatch reservations, saved results, an ordered durable outbox and crash-to-uncertain recovery. It executes no effects itself.

The service uses bounded input/pages, local development binding, rate limits and sanitized errors. Credentials, request bodies and OAuth query parameters are excluded from application logs. Deploy only one service instance in this milestone; connection limits and rate limiting are process-local. A production release still needs TLS/proxy validation, retention/backup/restore operations, real identity acceptance and deployment hardening.

Read [authentication contracts](apps/backend/AUTH.md), [collaboration contracts](apps/backend/COLLABORATION.md), [runtime safety and integration requirements](packages/runtime/README.md), and [implementation status](docs/backend-status.md). No public source license has been chosen; packages are private and marked `UNLICENSED`. Third-party dependencies retain their own licenses, recorded in [dependency provenance](docs/provenance.md).
