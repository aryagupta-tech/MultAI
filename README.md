# MultAI · integrated development build

MultAI combines a sandboxed Electron desktop app, a TypeScript collaboration service and an original-host coding runtime. This fresh implementation follows [MultAI.md](docs/MultAI.md) and the public repository's chosen [MIT license](LICENSE). It is a development build, not a completed public release.

The service synchronizes attributed conversation, decisions, membership and ordered activity in PostgreSQL. Inference credentials, private workspaces, file tools and processes stay on the original desktop host. **Send queues an instruction. Run instruction or Resume explicitly starts inference.** Saving a project, connection or model selection does not start work.

## Run locally

Use Node **24**, npm and Docker for development. From a fresh checkout:

~~~sh
npm ci --ignore-scripts
cp -n .env.example .env
docker compose up -d database
npm run dev:backend
~~~

Keep an existing .env; it may already contain the fresh Google configuration. The backend binds to 127.0.0.1:4310 and transactionally verifies/applies migration checksums before listening. The readiness endpoint separates database readiness, **identity: configured_unverified** and **inference: host_local**. These report configuration and architecture, not successful provider acceptance. Stopping the Compose database retains its development volume.

In another terminal, build the runtime and launch the desktop:

~~~sh
npm run build --workspace @multai/runtime
node node_modules/electron/install.js
npm run dev --workspace @multai/desktop
~~~

The explicit Electron installer is needed when the binary is absent after the script-disabled npm install. It downloads the pinned development runtime. These development prerequisites are not the intended requirements for installed end users.

A fresh, **unbilled** Google project and web OAuth client are configured in the ignored local .env for sign-in only, with the owner's test account admitted. The Google callback is http://127.0.0.1:4310/v1/auth/google/callback; the backend then sends a one-use completion to multai-dev://auth/callback. Real Google consent, OS callback delivery to the packaged macOS app and an OS-encrypted credential write succeeded on 29 October 2026. Cold restart, credential decryption and live refresh remain unverified; see [verification](docs/verification.md). New machines need authorized configuration; see [Google setup](docs/google-setup.md). Secrets are never source or desktop assets.

After collaboration sign-in, open **Models & accounts** to connect OpenAI, Claude, Kimi, a supported compatible API, or **Continue with ChatGPT**. Load the selected account/provider's actual model catalog, choose a model, send an instruction, then choose **Run instruction**. Plan exposes read-only tools; Build permits reviewed writes/commands with fresh exact host approval. See [inference connections](docs/inference-connections.md) for protocols and account eligibility.

## Validate and build

~~~sh
npm run typecheck
npm run build
npm run test:integration
~~~

Root build/typecheck commands build the runtime before dependent workspaces. The integration runner starts and removes a disposable PostgreSQL 18 container on a random loopback port, running the backend/runtime/desktop suites without touching the Compose database or existing volumes. Alternatively, set TEST_DATABASE_URL to a **dedicated test database** and run npm test; tests create/drop isolated schemas.

Build output records source revision, dirty state and build time. Start compiled outputs with npm start --workspace @multai/backend and npm start --workspace @multai/desktop; retain backend migrations/ beside dist/. The desktop package script prepares a development app bundle. Ad-hoc signing is not notarization or evidence of fresh-download installer trust.

## Implemented boundaries and limits

- Google OIDC/PKCE, rotating hashed service credentials, device proof, secure desktop persistence and stale-account fencing.
- Idempotent first send/messages, admission and roles, live replay/revocation, decisions and confirmed shared deletion.
- Original-host leases, explicit Run/Resume/Stop, attributed context and owner resolution of pending directions from several authors.
- Host provider adapters, bounded streams, controlled UTF-8 workspace tools, exact native write/command review and a durable SQLite effect journal/outbox. Interrupted effects become uncertain and are never automatically repeated.
- A deterministic private **blank workspace** per account/service/device/session. Registered-project Git worktrees, dirty-checkout baselines and execution in a selected project folder are not implemented.

Complete native write previews are limited to **16,000 characters**. Approved commands retain the host OS user's access; approval is not an OS sandbox. POSIX cancellation is implemented for macOS/Linux; Windows shell execution is unavailable. The SQLite journal has private permissions but is not encrypted credential storage.

Uncertain local effects block further mutations in that session. This conservative gate can also follow a stale-file rejection after reservation. Read-only inspection remains available; a complete owner-facing reconciliation flow is not implemented. Do not edit the journal to bypass it.

One service instance owns a database advisory lock; rate/connection limits are process-local. [Deployment preparation](docs/aws-deployment.md) includes private PostgreSQL, non-root images and verified encrypted restoration. **No AWS resources or public TLS service are deployed.** Google is used only for sign-in, without billing or compute.

Read [authentication](apps/backend/AUTH.md), [collaboration](apps/backend/COLLABORATION.md), [execution](apps/backend/EXECUTION.md), [desktop setup](apps/desktop/README.md), [implementation status](docs/backend-status.md), [verification](docs/verification.md) and [local development preferences](docs/local-environment.md), including the owner's authorized Chrome Apple Events preference. Live provider authorization, Google restart/refresh checks, two installed clients and public release acceptance remain outstanding.
