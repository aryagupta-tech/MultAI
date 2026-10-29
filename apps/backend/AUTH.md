# Desktop collaboration identity

This development service has one fixed public desktop client identity,
`multai-desktop-development`, and a fixed callback `multai-dev://auth/callback`.
Clients cannot provide arbitrary callback URLs. This is a new development identity;
the desktop protocol registration and fresh Google client credentials still require
native and live-provider acceptance. Inference/provider billing identity is separate
and is not connected by this sign-in flow.

Configure both `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` from a **new Google
web OAuth client**. Register exactly
`PUBLIC_ORIGIN/v1/auth/google/callback` as its Google redirect URI. The backend
exchanges Google's authorization code; the desktop receives a separate one-time
completion code. Missing configuration returns `503 identity_unavailable`.
`configured_unverified` in readiness means configuration exists, not that real
Google sign-in has passed.

## Sign-in protocol

1. The native desktop creates a cryptographically random PKCE verifier of 43–128
   characters and retains it privately for this pending flow. Compute
   `base64url(SHA256(verifier))` without padding.
2. `POST /v1/auth/google/start` with `{ "codeChallenge": "..." }` returns
   `flowId`, `authorizationUrl`, and `expiresAt`. Open that URL in the system
   browser. Retain the flow ID alongside the verifier; a new flow must not replace
   another account's pending identity silently.
3. Google redirects to the configured backend callback. The backend consumes the
   hashed state once, exchanges the code with a separate Google PKCE verifier,
   and verifies the signed ID token's issuer, audience, expiry, issued-at time,
   subject, and nonce. It redirects only to the fixed native callback with
   `flowId` and `completionCode`, without bearer or Google tokens.
4. The desktop checks the returned flow ID against its initiating pending flow,
   then calls `POST /v1/auth/google/exchange` with `flowId`, `completionCode`,
   `codeVerifier`, and a bounded `deviceName`. Flow expiry is five minutes. Each
   callback and completion can be consumed once. The persisted flow also binds
   the fixed desktop client, callback, Google client ID, and Google redirect URI;
   configuration changes invalidate pending completion.
5. New enrollment returns `accessToken`, `refreshToken`, `tokenType: "Bearer"`,
   `expiresIn: 900`, `deviceId`, and **`deviceSecret` once**. Keep credentials in
   account/service/device-scoped OS-encrypted storage in the desktop host. Never
   pass them to the renderer or expose them in participant responses or logs.

Public-client PKCE proves possession of the initiating verifier. It is not proof
of the installed application's binary identity. System protocol registration,
stale callback fencing, OS credential storage, and account switching must be
verified in the future native desktop implementation.

## Device and credential lifecycle

Protected requests use `Authorization: Bearer <accessToken>`; credentials never
belong in a URL. `GET /v1/me` returns the collaboration user, personal workspace,
and current device ID. `GET /v1/devices` returns at most 100 latest device records
with an explicit `truncated` flag.

`POST /v1/auth/refresh` accepts `{ "refreshToken": "..." }` and rotates both
credentials. The desktop must serialize refresh, atomically replace its saved
refresh credential, and avoid retrying a consumed refresh token after uncertain
completion. Reusing an old refresh token revokes the entire sign-in family,
including any access token returned to a concurrent winning refresh. There is no
grace replay window. Access tokens last 15 minutes, bounded by a sign-in family's
fixed 30-day expiry. Refresh does not extend that expiry.

`POST /v1/auth/logout` revokes the current sign-in family. A later fresh Google
sign-in may reuse the original enrolled device by adding **both** `deviceId` and
`deviceSecret` to its completion exchange. This requires the same verified Google
subject, the correct device secret, and a device that has never been revoked.
The reused device ID preserves the original-host session association; a new
sign-in family is created. Keep the device proof privately across sign-out if the
user chooses to preserve that installation's ability to reconnect. Removing that
proof means a later enrollment receives a new device ID and cannot claim an old
host's authority merely by signing into the same account.

`DELETE /v1/devices/:deviceId` permanently revokes an owned device. Its access,
refresh, and reauthentication proof stop working; other accounts and devices are
preserved. Device secret values are never returned by device listing or refresh.
Sign-out revokes a sign-in family; device revocation revokes that device identity.

The database stores SHA-256 hashes of high-entropy access, refresh, device,
OAuth-state, and completion secrets. Short-lived nonce and Google PKCE values are
stored only for the pending flow; the provider verifier is cleared after the
callback attempt. Completed flow identity and completion hash are cleared after
exchange. Expired flow records older than a day are pruned on subsequent starts.
Database/backups still need a deliberate retention and access policy; this
foundation does not claim all collaboration data is encrypted at rest.

Tests use explicitly synthetic identity doubles and locally signed synthetic
OIDC tokens. They verify database concurrency, replay, expiry, signature/claim
rejection, device ownership, and credential revocation; they do not establish
successful live Google sign-in or installed-desktop acceptance.

References: [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect),
[OAuth security best practice](https://www.rfc-editor.org/rfc/rfc9700.html).
