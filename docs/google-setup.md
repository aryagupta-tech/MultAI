# Fresh Google sign-in and native acceptance

This development client uses a web OAuth client on the collaboration backend and a separate one-use completion code for the installed desktop app. Google client secrets stay in the backend's ignored `.env`; collaboration access/refresh/device credentials stay in the native host's OS-encrypted store. No provider inference credential is obtained from Google sign-in.

## Configure a fresh client

1. Open [Google Auth Platform](https://console.cloud.google.com/auth/overview), select the newly authorized MultAI project, and complete Branding with the actual product name and owner-selected support/contact information.
2. Configure Audience for the intended development testers. If the client is in Testing, include each Google account that will participate in acceptance. Keep the scope limited to authentication/profile; this implementation requests `openid profile`.
3. In Clients, create a **Web application** OAuth client. Add this exact authorized redirect URI for the local backend:

   ```text
   http://127.0.0.1:4310/v1/auth/google/callback
   ```

4. Put the new client ID and secret into the ignored repository-root `.env`. Do not paste secrets into a chat, renderer, screenshot, source file or build artifact.

   ```dotenv
   GOOGLE_CLIENT_ID=<new-web-client-id>
   GOOGLE_CLIENT_SECRET=<new-web-client-secret>
   PUBLIC_ORIGIN=http://127.0.0.1:4310
   DESKTOP_CALLBACK_URI=multai-dev://auth/callback
   ```

The Google redirect is the backend HTTP endpoint. **Do not register `multai-dev://auth/callback` as Google's web-client redirect.** The backend validates Google identity, then redirects to that fixed desktop callback with a flow ID and one-use completion code. There are no credentials in the renderer bridge or Google-to-desktop URL.

The setup follows [Google's OpenID Connect guide](https://developers.google.com/identity/openid-connect/openid-connect) and [Google Auth Platform setup](https://developers.google.com/identity/gsi/web/guides/get-google-api-clientid). Use a distinct, authorized HTTPS origin/client for a later production environment; changing client or callback settings invalidates pending sign-in flows.

## Run and verify

Start the local development database and backend using the root README. Restart the backend after changing its `.env`. `/health/ready` should report `identity: configured_unverified`; that means the fields exist, not that consent or native callback delivery has passed.

Build and run the installed/development desktop app from the same source revision. It must register `multai-dev` for that executable and use the matching service origin. Choose Sign in, approve Google consent in the **system browser**, and allow it to reopen MultAI. The native host must match the callback to the pending flow and verify possession of its private PKCE verifier before completion.

Record live acceptance separately from automated tests:

- Fresh sign-in displays the verified collaboration account and creates one personal workspace/device.
- Canceling sign-in, a duplicated callback, an expired flow or an old callback after sign-out cannot restore credentials.
- Cold restart retains the account only through approved OS-encrypted storage.
- Sign-out immediately fences pending requests. Re-signing into the same Google account restores the original device using its retained device proof.
- Selecting a different Google account can enroll a new, separately scoped device only after the backend verifies a valid proof belongs to that other account. A revoked/invalid proof produces an error; it never silently replaces the original host.
- Two independent installed clients see the same admitted discussion; viewers cannot submit, and revocation closes existing live access.

On Linux, `basic_text`, unknown or unavailable keyrings are rejected. macOS uses Keychain and Windows uses their supported OS protection. The application does not fall back to plaintext or memory-only sign-in. See [Electron safeStorage security semantics](https://www.electronjs.org/docs/latest/api/safe-storage). App signing and native platform acceptance remain separate evidence from using this API.

The first real local acceptance succeeded on **29 October 2026**: the owner confirmed sign-in in the packaged macOS app, database metadata confirmed one Google user/consumed flow/active sign-in, and the scoped OS-encrypted credential file was written with private permissions. This verifies real browser consent and OS callback delivery for that installation. Cold restart/decryption, live refresh, account switching/revocation and additional installations remain pending. Readiness continues to report configured_unverified because it probes configuration; see [the evidence record](verification.md).

## Credential and replay behavior

The credential filename binds the complete service origin, including its scheme and port. Per-account device proofs survive sign-out inside the encrypted record. A nonsecret sign-out/refresh-uncertainty marker prevents active credentials from being revived after restart, even when a keyring was locked during sign-out or the process crashed while a refresh might have been consumed. Successful fresh sign-in or confirmed refresh atomically replaces the encrypted active record.

The live stream checks account generation, validates contiguous sequence numbers, and replays from the last batch delivered to the main-process emitter when a gap or disconnect occurs. This is an in-process delivery boundary; renderer persistence/acknowledgement is not claimed. Membership loss and signed-out authority end the subscription rather than retrying indefinitely.

Automated identity tests use explicitly synthetic HTTP responses, keys and OS-storage adapters. They establish race handling and local persistence invariants. The real consent/callback/encrypted-write acceptance above is separate from those fixtures; each additional native storage, lifecycle and platform claim still needs its own recorded evidence.
