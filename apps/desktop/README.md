# MultAI desktop

The fresh MIT-licensed desktop integrates an Electron shell, React renderer, native collaboration identity and original-host inference runtime. The compiled macOS arm64 shell passed a native smoke. Real Google sign-in, OS callback delivery and an OS-encrypted credential write also passed in the packaged app; restart/refresh, live provider and public release acceptance remain pending.

## Run

From the root, retain the configured ignored .env or create one from .env.example for a fresh checkout. Use Node 24, npm and Docker for development:

~~~sh
npm ci --ignore-scripts
npm run build --workspace @multai/runtime
node node_modules/electron/install.js
docker compose up -d database
npm run dev:backend
~~~

Then in another terminal:

~~~sh
npm run dev --workspace @multai/desktop
~~~

MULTAI_SERVICE_ORIGIN selects another loopback development origin or HTTPS service; other cleartext origins are refused. The default is http://127.0.0.1:4310. The explicit Electron installer supplies the pinned binary if the script-disabled install did not. Root build builds runtime/backend/desktop in dependency order. The desktop start script opens compiled output; its package script prepares a development bundle, not a signed/notarized public release.

## Sign in and run

1. Choose **Continue with Google**. The backend web OAuth client uses http://127.0.0.1:4310/v1/auth/google/callback, verifies Google and sends a separate one-use completion through multai-dev://auth/callback. The new project is unbilled and used only for authentication. This real flow succeeded locally on 29 October 2026. Configured readiness remains a separate configuration probe.
2. In **Models & accounts**, connect OpenAI, Claude, Kimi, a supported compatible API, or **Continue with ChatGPT**. The native host encrypts secrets with the OS credential store. Load the actual model catalog and choose a model; this starts no inference.
3. Send an instruction, then explicitly choose **Run instruction**. Discussion is context. An interrupted task requires **Resume** and a pending instruction; applied instructions/effects are never automatically repeated.
4. Plan is read-only. Build permits requested writes/POSIX commands only after exact native original-host review. **Stop** cancels owned inference/processes and fences old authority.

Execution currently uses a deterministic private **blank workspace** per account/service/device/session. Sidebar project registration does not yet create a Git worktree or run against that folder. Complete write review is capped at 16,000 characters. Windows shell execution is unavailable; macOS/Linux process behavior still needs native release acceptance per target.

## Native boundaries

- account.ts owns Google flow/callback generations, access/refresh/device proof and uncertainty fencing. credentials.ts encrypts atomic records and rejects unavailable/unknown/Linux basic_text keyrings, with no plaintext or memory-only sign-in fallback.
- live.ts validates contiguous events, bounds replay/batches and ends revoked/signed-out subscriptions. Renderer projections show attributed messages, streaming, activity and current/replaced decisions.
- inference/connections.ts separates AI identity from Google collaboration identity. Official ChatGPT OAuth uses fresh public-client registration, stable host ID, PKCE/state/nonce and granted plan permission; no global profiles are imported.
- inference/coordinator.ts obtains original-host leases, runs controlled tools/provider streams, journals effects and shows exact native approvals. Provider keys, lease secrets and canonical workspace paths never enter the renderer bridge.
- Main/preload validate sender/window/frame and arguments. The renderer is sandboxed/context-isolated without Node; packaged CSP denies remote assets/requests/frames. Markdown is inert. An approved host command retains OS-user access and is not a general sandbox.

Sign-out, account/connection changes, sleep and Quit invalidate execution. Private provider records remain account/service/device scoped; uncertain refresh/effect outcomes require recovery. The SQLite journal is private-permission storage, **not encrypted credential storage**.

## Demo and evidence

The dev:demo workspace script loads clearly labeled fixtures without contacting providers. Demo content is not live acceptance. Non-demo builds use the real bridge and expose unavailable configuration rather than simulating success.

Run root typecheck, build and test:integration scripts; standalone npm test requires a dedicated TEST_DATABASE_URL. The current full suite passed **179 tests**. Actual native smoke covered compiled renderer/preload/IPC, sandboxing, signed-out denial, untrusted-window rejection and real configured database health.

Separately, the owner confirmed successful real Google sign-in in the packaged app. Local database metadata confirmed one Google user, one consumed flow and one active sign-in; an OS-encrypted credential file was written with private permissions. This verifies real OS callback delivery and the encrypted write, while cold restart/decryption and live refresh remain **unverified**. Live inference, two installed clients and installer trust also remain pending. The first Google acceptance app came from a dirty checkout; verify each later app's adjacent build-manifest.json for its exact source and hashes. See [verification](../../docs/verification.md), [Google setup](../../docs/google-setup.md), [connections](../../docs/inference-connections.md) and [execution protocol](../backend/EXECUTION.md).
