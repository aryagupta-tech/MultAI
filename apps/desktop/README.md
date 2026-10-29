# @multai/desktop

The MultAI desktop app: a sandboxed Electron shell and a React renderer. The interface is built
fresh from the product requirements; nothing is imported from earlier implementations.

## Run it

```bash
docker compose up -d database && npm run db:migrate   # from the repo root
npm run dev:backend                                   # collaboration service on 127.0.0.1:4310
npm run dev -w @multai/desktop                        # Electron + Vite against that service
npm run dev:demo -w @multai/desktop                   # Electron + Vite with labeled demo data instead
npm run package -w @multai/desktop                    # build release/MultAI-<platform>-<arch>/
```

The app talks to `http://127.0.0.1:4310` by default. Set `MULTAI_SERVICE_ORIGIN` to another
loopback port or an HTTPS origin to change it; anything else is refused.

Google sign-in needs a Google web OAuth client on the backend (`GOOGLE_CLIENT_ID` and
`GOOGLE_CLIENT_SECRET` in the repo's `.env`, redirect URI
`http://127.0.0.1:4310/v1/auth/google/callback`). Without it the app says sign-in isn't
configured. The browser returns to the app through `multai-dev://auth/callback`, which the
packaged app registers.

The Electron binary is fetched by its install script. If `npm install` skipped it, run
`node node_modules/electron/install.js` from the repository root.

## How the service connection works

- `electron/service/account.ts` runs the PKCE sign-in, keeps access, refresh and device secrets
  in the main process, encrypts them with the OS keychain (`safeStorage`), serializes refresh,
  and never retries a refresh whose outcome is unknown.
- `electron/service/live.ts` follows each open session over the read-only WebSocket, resumes
  from the last sequence and deduplicates by sequence.
- `electron/service/router.ts` validates every renderer request before any network call.
- `src/live/controller.ts` keeps the store in sync; `src/live/projection.ts` maps wire data to
  view models. Sends carry a retry id saved with the draft, so retrying never duplicates.
- Pins, archive state, private renames and projects are local to this account on this computer.

## Demo data

Demo fixtures live in `src/model/demo.ts` and load only when the renderer is built or served with
`--mode demo`. Production builds drop the fixtures chunk entirely. Whenever demo data is shown, the
sidebar carries a persistent **Demo data · not a live session** badge. The demo simulates agent
turns locally; no model or service is contacted.

Without demo mode, the app shows the sign-in screen and says plainly that the collaboration
service client is not connected yet. Sends keep the draft rather than pretending to succeed.

## Structure

```
electron/main.ts      Window, session hardening, validated IPC handlers
electron/preload.ts   The only bridge exposed to the renderer (src/bridge/contract.ts)
src/model/            View models, store, pure composer logic (unit tested)
src/ui/               Accessible primitives, logo, inert Markdown renderer
src/features/         Sidebar, header, conversation, composer, inspector, overlays, welcome
src/styles/           Theme tokens (dark default, light), base and app styles
```

## Security notes

- `contextIsolation`, `sandbox`, no Node integration, no `<webview>`, devtools only in dev.
- IPC handlers reject calls that don't come from the app's own top-level frame.
- All permission requests and downloads are denied; navigation away from the app is blocked and
  `https://` window opens go to the system browser.
- The packaged renderer ships a strict CSP (no remote scripts, connections, frames or forms).
- Markdown is rendered as React elements only: no raw HTML, images or live links.
- The folder picker returns a display hint to the renderer, never a credential or file contents.

## Status

Implemented: shell, design system, sidebar, session header, conversation with every event type,
composer, inspector (changes, activity, approvals, decisions, people), command menu, settings,
invite, new project, delete confirmation and onboarding.

Wired to the service: sign-in, sessions, messages, live updates, Plan/Build, invitations, join
requests and admission, removing people, and deletion. Not available yet because the service
doesn't offer them: inference and agent runs, approvals, decisions, diffs, the file browser, and
other people's display names. Those panels say so plainly.
