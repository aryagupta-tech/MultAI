# @multai/desktop

The MultAI desktop app: a sandboxed Electron shell and a React renderer. The interface is built
fresh from the product requirements; nothing is imported from earlier implementations.

## Run it

```bash
npm run dev:demo -w @multai/desktop   # Electron + Vite, with labeled demo data
npm run dev -w @multai/desktop        # Electron + Vite, no demo data (shows sign-in)
npm run dev:web -w @multai/desktop    # Renderer only, in a browser, with demo data
npm run build -w @multai/desktop && npm start -w @multai/desktop
```

The Electron binary is fetched by its install script. If `npm install` skipped it, run
`node node_modules/electron/install.js` from the repository root.

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

Not yet wired: the collaboration service client, real sign-in, provider connections, the local
runtime (file browser, terminals) and native notifications. Those controls are visibly disabled
or say they're unavailable.
