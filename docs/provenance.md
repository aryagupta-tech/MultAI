# Source and dependency provenance

Verified 29 October 2026. Product requirements are preserved in [MultAI.md](MultAI.md), supplied by the owner. This iteration integrates the newly written frontend branch with the fresh backend; no historical application source, profiles, assets, migrations, secrets or endpoints were restored. The owner-selected MIT license from this new repository's main branch is preserved in [LICENSE](../LICENSE). Workspaces remain private npm packages to prevent accidental publication.

Current upstream documentation was checked before selecting the implementation:

- [Fastify support policy](https://fastify.dev/docs/latest/Reference/LTS/) and the installed matching API documentation.
- [node-postgres transactions](https://node-postgres.com/features/transactions): each transaction uses one checked-out client.
- [PostgreSQL explicit locking](https://www.postgresql.org/docs/current/explicit-locking.html): transactional locks protect ordered events, retries and migrations.
- [Google OpenID Connect](https://developers.google.com/identity/openid-connect/openid-connect): verified identity claims and fixed browser flow.
- [Fastify WebSocket plugin](https://github.com/fastify/fastify-websocket): lifecycle and WebSocket integration.
- [Official ChatGPT client registration](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) and [account-specific inference](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference): dynamic public-client registration, verified scope/identity and the public Responses API.
- [OpenAI function calling](https://developers.openai.com/api/docs/guides/function-calling), [Claude streaming](https://platform.claude.com/docs/en/build-with-claude/streaming), and [Moonshot provider configuration](https://github.com/MoonshotAI/kimi-code/blob/main/docs/en/configuration/providers.md): explicit protocol adapters, not unmanaged native agents.

Direct package versions and published licenses were inspected through npm metadata and installed package manifests. Transitive versions, integrity hashes and registry source locations are recorded in `package-lock.json`. Dependencies were installed with lifecycle scripts disabled. These licenses apply to the respective third-party packages, not to the new MultAI source.

| Package | Version | License | Purpose |
| --- | --- | --- | --- |
| fastify | 5.12.7 | MIT | HTTP service |
| pg | 8.23.1 | MIT | PostgreSQL client |
| jose | 6.2.13 | MIT | OIDC signature and claim verification |
| zod | 4.6.7 | MIT | Bounded request validation |
| @fastify/websocket | 11.3.4 | MIT | Read-only live replay transport |
| @fastify/rate-limit | 11.2.1 | MIT | Process-local HTTP rate limits |
| typescript | 7.0.2 | Apache-2.0 | Development compiler |
| tsx | 4.23.15 | MIT | Development/test TypeScript runner |
| @types/node | 24.19.2 | MIT | Node 24 types |
| @types/pg | 8.23.1 | MIT | PostgreSQL types |
| @types/ws | 8.18.2 | MIT | WebSocket types |
| ws | 8.22.0 | MIT | Native loopback transport tests |
| react / react-dom | 19.3.1 | MIT | Desktop renderer |
| lucide-react | 1.60.0 | ISC | New interface icons |
| zustand | 5.0.16 | MIT | Renderer state |
| electron | 44.9.3 | MIT and bundled Chromium notices | Installed native shell, Node 24.22.0 runtime |

The desktop's offline notice generator reads full installed licenses for the bundled production dependency closure. Packaging includes the root MIT license, full third-party notices, Electron/Chromium vendor notices, package metadata and a notice hash in the artifact manifest. The official pinned Electron installer is run explicitly for native verification; no historical installer is used. Local macOS packages are ad-hoc signed development artifacts and are not notarized.

The local journal uses Node 24's bundled `node:sqlite`; see [Node license and bundled third-party notices](https://github.com/nodejs/node/blob/v24.x/LICENSE). The test/development database is the [official PostgreSQL image](https://hub.docker.com/_/postgres), `postgres:18-alpine`, pinned at `sha256:10a5c69a83035ab5239f5620d708520e8b28f5aa1f2b20143e6024532edadfb5`. PostgreSQL uses the [PostgreSQL License](https://www.postgresql.org/about/licence/); image OS components retain their own notices. No redistribution or production packaging claim is made for this development image.
