# Mobile companion

Follow a MultAI session from a phone, and, as its owner, control your own desktop's agent from it. The agent, your code, the model keys and the approval journal stay on the desktop; the phone only asks.

| | Where | Status |
|---|---|---|
| Browser companion | `https://api.multai.si/app/` (Android Chrome, iPhone Safari; add to home screen) | **Prepared, not deployed.** It ships inside the service image and goes live with the next approved deploy of this commit. No DNS change: it shares the existing `api.multai.si` origin. |
| Android app | `apps/mobile/release/multai-companion-<version>.apk` (id `si.multai.companion`) | Signed release APK in the repository; see [the Android README](../apps/mobile/README.md) for the path, SHA-256, certificate, install, update and uninstall. It talks to `https://api.multai.si`, so its sign-in and owner control also need that deploy. |
| iPhone | The browser companion in Safari | No native iOS app, TestFlight or Apple membership. |

## Three separate ways in

1. **Sign in with Google**: your own account, on a new device. You see the sessions you were admitted to with your role there (collaborator, viewer, or owner on another device): live activity, catch-up briefs, people, attributed messages, requirements and evidence, shared screenshots. Collaborators can send discussion and instructions (the host decides when they run), propose requirements, accept behavior or request changes, and mark a problem region on a shared screenshot. This sign-in **never** starts, stops, approves or steers anything on a desktop, even for the owner.
2. **Pair as owner**: desktop-initiated. This phone becomes a *paired owner controller* for chosen sessions on one desktop. Separate credential, separate key, separate permissions.
3. **Review link**: a browser reviewer (guest) invitation from the host, exactly the existing browser review, in the companion's screens. Memory-only credential; leaving or reloading needs a new admission.

## Pairing (owner control)

1. On the desktop: **Settings → Paired phones**. Pick the sessions the phone may control (up to 20) and how long (1, 7 or 30 days), then **Pair a phone**. The desktop shows a QR code and a 12-character code (`K7Q2-M9XD-4TPR`). It works **once** and for **five minutes**.
2. On the phone: scan the QR with the camera (it opens `https://api.multai.si/app/#pair=…`; the code is in the fragment, which is never sent to a server and is removed from the address bar), or open the companion and choose **Pair as owner** and type the code.
3. The phone makes its own keys (a P-256 signing key and a P-256 key for encrypted previews; private halves are non-extractable) and claims the code. It shows **six check digits**.
4. The desktop shows the phone's name, platform, the sessions, the duration, the exact permissions, and **its own** six digits, computed on the desktop from the phone's keys. Confirm only when both screens show the same digits. Confirming stores the phone's public keys on the desktop, OS-encrypted per account and device.

The six digits defeat a substituted key: if anything between the phone and the desktop swapped the key, the digits differ.

**Devices.** Settings → Paired phones lists each phone with expiry, last seen and a **History** (audit trail: created, claimed, confirmed, every request and the desktop's answer, removal). **Remove** takes effect on this desktop at once (its local trust goes first, even offline) and on the service immediately; waiting requests are canceled. A phone can also unpair itself. Revoking the desktop's own device or deleting a session ends the pairings for it. Grants expire on their own.

## Remote control

Open **Owner control** on the phone and pick a session. The screen shows plainly whether the desktop is online, asleep or offline (no report for 30 s), and whether the agent is idle, running, blocked on an approval, completed, failed or stopped.

- **Start**: select one pending direction and choose **Start selected**. The desktop starts exactly that instruction with its own selected model.
- **Stop**: stops the run on the desktop. Waiting approvals and phone requests are canceled; late approvals do nothing.
- **Steer**: while the agent runs, select a queued direction and **Steer into the running agent**. The existing conflict rules apply: a different author's steering stops for the host's review.
- **Approve / Reject**: the card shows the exact waiting action, the command, or for a file change its path, new-or-changed, content hash and a preview that only this phone can decrypt. Buttons stay disabled until the desktop and the service agree it is the same action.
- **Resolve conflicting directions**: when several people want different things, pick one, edit it or write your own decision, then **Decide and start**. Your decision replaces the whole reviewed queue; the others never run later. A changed queue rejects the decision.

Every request says **Waiting for the desktop** until the desktop acknowledges it: **The desktop did it**, **The desktop refused: …**, **Expired** or **Canceled**. Nothing is shown as done because the phone sent it. The session timeline also records each phone action, attributed to the owner via the named phone.

## How a request is checked

Each request is a signed envelope:

```text
{v, pairingId, requestId, sessionId, kind, runGeneration, target, issuedAt, expiresAt}
kind/target: start {instructionId, queueFingerprint} · resolve {…, resolution} · stop {}
             steer {instructionId} · approve|reject {actionId, actionFingerprint}
signature:   ECDSA P-256 / SHA-256 over "multai-control-v1\n" + sorted-key JSON
```

1. **Service** (`apps/backend/src/owner-control.ts`): pairing active and unexpired, host device not revoked, session in scope and owned by that owner on that host, signature valid with the stored key, at most two minutes of life and not expired, `runGeneration` equal to the session's, and the target current (the action pending with that fingerprint in a running run; the instruction pending and the queue fingerprint unchanged; no conflict for a plain start). Duplicate ids return the same request; a reused id with different content is refused.
2. **Desktop** (`apps/desktop/electron/service/remote-control.ts`): verifies the signature again with the key **it** confirmed, rechecks scope, expiry and generation with its own sign-in, refuses anything issued before it last started, woke up or reconnected, and then checks the real thing: the approval waiting in its broker with the same session and fingerprint, the queue from its own conflict context, its selected model. Only then does it act, with its own authority, and acknowledge.

The phone never receives the desktop's sign-in, model keys, files, a terminal or a file browser, and the service cannot create a request the desktop would accept.

## Lifecycle

- Reconnects, background/resume, reloads and Android process death restore from storage: the browser's HttpOnly cookies and IndexedDB keys, the app's Keystore storage. Pending requests are kept by id and checked again; a lost acknowledgement is recovered by asking for the request's status. Repeated taps reuse the same signed request.
- Requests expire after two minutes and the desktop refuses anything signed before it last started or woke, so an old tap never runs after a reconnect.
- When the desktop and the phone decide the same approval at once, the first decision wins and the other is refused as already decided.
- Offline phones say so; messages stay in the box and are retried with the same request id.
- An open owner screen makes about 24 requests a minute (it fetches events only when the session moved), comfortably inside the service's 120 per minute per IP even when the desktop shares the same home IP.

## Credentials

| | Browser companion | Android app |
|---|---|---|
| Sign-in refresh token | HttpOnly, SameSite=Strict cookie on `/v1/web/auth`; access token in memory only | Android Keystore (AES-256-GCM key that never leaves the Keystore), backups disabled |
| Owner credential | HttpOnly, SameSite=Strict cookie on `/v1/controller` | Android Keystore |
| Signing and preview keys | Non-extractable WebCrypto keys in IndexedDB | Same, in the app's WebView |
| Guest review credential | Memory only | Memory only |

Cookie calls need the page's custom `X-MultAI-Client` header; when the browser sends `Origin` or `Sec-Fetch-Site` it must be this origin (browsers omit `Origin` on same-origin GETs). Cookie routes never allow cross-origin calls. The Android app calls the API cross-origin from `https://localhost` with explicit headers only, never cookies. Tokens appear only in URL fragments, never in query strings or logs. The companion page has a strict CSP (`script-src 'self'`, no inline script or style, `connect-src 'self'`); the app's CSP allows only its one service.

## Service changes

- **Migration `010_owner_control.sql`** (new; earlier migrations untouched): `controller_pairings`, `control_requests`, `host_control_state`, `controller_audit`, and a wider `oauth_flows` client check that adds the companion's web and Android sign-in clients.
- **Sign-in**: `POST /v1/web/auth/{start,exchange,refresh,logout}` for the browser; `client: "android"` on `/v1/auth/google/start`. Both reuse the existing Google redirect URI (no Google console change) and receive the one-time completion in a fragment: `/app/#signin=…` or `multai-companion://auth/callback#signin=…`.
- **Pairing (host)**: `POST/GET /v1/controller-pairings`, `GET …/:id`, `POST …/:id/confirm`, `POST …/:id/decline`, `DELETE …/:id`, `GET …/:id/audit`.
- **Host loop**: `GET /v1/host/control-requests?wait=10` (long poll), `POST /v1/host/control-requests/:id/ack`, `PUT /v1/sessions/:id/control-state`.
- **Phone**: `POST /v1/controller/claim`, `GET /v1/controller/status`, `GET /v1/controller/sessions/:id[/events|/acceptance]`, `POST/GET /v1/controller/requests[/:id]`, `POST /v1/controller/unpair`, `POST /v1/controller/forget`.
- **Participants**: `GET /v1/sessions/:id/host-presence`, `GET /v1/sessions/:id/shared-screenshots`, `POST /v1/sessions/:id/screenshot-comments`.
- Stop and session deletion cancel or remove phone requests. CORS is allowed only from `COMPANION_APP_ORIGINS` (default `https://localhost`) on header-authenticated routes. `/app/` serves the companion build (`COMPANION_DIR`); `/.well-known/assetlinks.json` publishes `ANDROID_CERT_SHA256` for App Links.

## Deploying (needs the owner's approval)

The current production service does not have these routes yet. Deploying this commit with the usual procedure ([AWS deployment](aws-deployment.md)) builds the companion into the image, applies migration 010 (additive) and makes `https://api.multai.si/app/` live. Back up the database first, as for any deploy. Afterwards: `curl -I https://api.multai.si/app/` (200, CSP), `curl https://api.multai.si/.well-known/assetlinks.json`, then pair a phone. Nothing in this change creates cloud resources or changes DNS.

## Demo for judges (about 4 minutes)

1. Desktop: open a session in a real project, Build mode, with one pending instruction. Show **Settings → Paired phones → Pair a phone**.
2. Phone: scan the QR. Compare the six digits on both screens, then **Confirm phone** on the desktop.
3. Phone: **Owner control → session → select the instruction → Start selected**. The request reads *Waiting for the desktop*, then *The desktop did it*; the desktop starts the run.
4. The agent asks to run a command: the phone shows the exact command; **Approve**. Show the desktop's card disappear and the timeline line "Host via Pixel … asked to approve an action: the desktop did it".
5. Add a teammate's conflicting direction from another account: the phone shows **Conflicting directions**; write a decision and **Decide and start**.
6. **Stop** from the phone; the waiting approval is canceled. Close the laptop lid: the phone says *Desktop is asleep*.
7. **Remove** the phone on the desktop: the phone says it was removed.
8. Optional: a collaborator on another phone (Google sign-in) comments and marks a region on a shared screenshot; a guest joins from a review link.

Use a real project and say plainly which parts are edited waiting time. The automated tests use synthetic identities and a synthetic agent.

## Tests

See [verification](verification.md#mobile-companion--2-november-2026) for the full record. In short: service integration tests on real PostgreSQL (pairing, admission, expiry, revocation, cross-session, duplicates, changed commands, stale generations, concurrent controllers, Stop, CSRF, CORS, static serving, companion sign-in), desktop host validation tests with real keys and the real approval broker, shared-package tests (WebCrypto ↔ Node byte-for-byte signing, encrypted previews, status wording, XSS escaping), browser end-to-end runs in Chromium (Android Chrome emulation) and WebKit (iPhone Safari emulation), and an Android emulator run of the installed APK.

## Known limitations

- **Not deployed**: the browser URL and the APK's sign-in/owner control need the next approved production deploy.
- **No physical-device or real iPhone Safari test**: Android was tested on an emulator (Android 16, WebView 133); iPhone Safari on Playwright's WebKit with iPhone 15 emulation. Real Google consent on a phone was not exercised (no credentials were used).
- **Android App Links** need the deployed `assetlinks.json`; until then a scanned QR opens the browser companion, and the app accepts the typed code.
- The phone shows the approval preview the desktop sends (file changes up to 6,000 characters, encrypted to the phone); larger files are summarized by path and hash.
- Owner control polls (2.5 s while a session is open). Notifications/push are not implemented; the phone must be open to see new approvals.
- Starting a run uses the model currently selected on the desktop; the phone cannot choose a model, change access levels, or use Keep/Apply/Push, the terminal or anything else host-only.
- The service's rate limit is per IP; very busy shared networks can still hit it.
- Release APK updates require the same private signing key (`~/.multai/android`, outside Git). Back it up.
