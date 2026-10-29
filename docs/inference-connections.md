# Desktop inference connections

The Google collaboration identity and AI inference identity remain separate. Sign into the collaboration service, open AI connections, then explicitly choose an API connection or **Continue with ChatGPT**. Saving a connection, loading its models and selecting a model do not start inference.

The desktop supports these protocol adapters:

| Connection | Credential | API base |
| --- | --- | --- |
| OpenAI API | API key | `https://api.openai.com/v1` |
| Claude API | Anthropic API key | `https://api.anthropic.com/v1` |
| Kimi API | Moonshot API key | `https://api.moonshot.ai/v1` |
| Compatible API | Provider API key | An explicitly entered public HTTPS base URL implementing Chat Completions and model listing |
| ChatGPT | Official public-client OAuth grant | `https://api.openai.com/v1` |

An arbitrary provider's API is not automatically compatible. The compatible option expects the documented OpenAI-style Chat Completions protocol; unsupported APIs need a reviewed adapter. HTTPS endpoints with embedded credentials, custom ports, localhost or private addresses are refused. Redirects are not followed. Provider requests use TLS with a public address check at actual connection lookup; no key is sent to a redirect destination. Model choices come from the selected provider/account's catalog. Missing model capabilities or usage are not invented.

## Credential boundary

`ConnectionManager.resolve` is a trusted native-host method; it must never be exposed through preload IPC. Public operations return only whitelisted summaries and model IDs/names. API keys, OAuth access/refresh/ID tokens and registration details remain in the native host. Provider records are encrypted using Electron `safeStorage`, with separate service-origin, collaboration-account and device scopes. Linux's `basic_text` storage backend and unavailable/locked keyrings fail securely; there is no plaintext fallback.

Encrypted records use private initial file permissions and atomic writes. Their parent directory must remain the native app's trusted private application-data directory. They are not imported from global Codex, Claude or browser profiles. Signing out must call `ConnectionManager.invalidate()` and cancel any execution that already holds a private credential copy. Removing or changing a connection must stop its active execution; an already-resolved key is not a fresh inference grant.

## Official ChatGPT connection

This implementation follows the [official open-source registration flow](https://developers.openai.com/siwc/token-sharing-open-source/sign-in). First registration uses `client_id=dynamic_agent_client`, a stable opaque host ID and `agent_name_hint=MultAI`. The system browser returns to a temporary listener at `http://127.0.0.1:<port>/auth/callback`. Every attempt has a fresh state, nonce and PKCE verifier; callbacks are consumed once and bound to the exact redirect URI. Returning sign-in reuses the issued `oaiapp_...` client ID and verified account mapping. The registration is retained before code exchange so a failed exchange can resume the existing registration.

ID tokens are signature verified against OpenAI's published JWKS, with issuer, issued-client audience, expiry, subject and sign-in nonce checks. Returning credentials cannot replace another verified subject. A verified identity without the granted `chatgpt.tokens.use.direct` scope cannot perform inference. The local panel reports missing plan permission and offers explicit reauthorization.

ChatGPT access tokens are used only with the public OpenAI API, never ChatGPT `backend-api` routes. The [account-specific catalog](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference) uses `models[]`, preserving the provider's order and displaying only entries with `visibility: list`. The inference adapter must always use `store: false` and `stream: true`, wait for a terminal completion event, and obey [preview limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations), including omitted unsupported fields and the supported tool grouping format.

Refreshes are serialized per native manager. A confirmed replacement is stored before reuse; an uncertain rotating refresh outcome clears renewable credentials and requires a fresh sign-in. Removing a ChatGPT connection attempts the discovery document's revocation endpoint before local removal. If remote revocation cannot be confirmed, the API reports that fact and directs the person to disconnect MultAI in ChatGPT Settings.

The direct dynamic flow is documented for open-source clients and eligible accounts/plans. This fresh repository's chosen MIT license is preserved in `LICENSE`. Implementing the flow does not establish an individual account's plan eligibility, partner approval or an OpenAI publication claim. The user must authorize the account/plan grant in the system browser; no global account tokens are silently reused.

Automated tests use explicitly synthetic keys, tokens and identities. They exercise an actual local callback listener, claim/signature rejection, cancellation/denial, changed-client refusal, scope enforcement, public-endpoint checks, credential isolation and encrypted-file handling. They do not establish live Google, ChatGPT, OpenAI, Anthropic or Kimi acceptance without a real authorized credential and completed request.
