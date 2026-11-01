# MultAI

**One AI coding agent, shared by the whole team, in real time.**

When you get stuck with an AI coding tool, bringing in a teammate today means screenshots and explaining everything again. In MultAI your teammate joins the session itself: they see the whole conversation, get a catch-up brief, can send the agent directions, and watch you approve what it does. The agent and your code stay on the host's computer.

Built for the **Meta Global AI Developer Hackathon** (Build for Your World), on **Muse Spark** and **Muse Wonder** through the Meta Model API.

## How it uses Meta's models

| Model | What it does in MultAI |
|---|---|
| **Muse Spark 1.3** | The shared coding agent. It reads, writes and runs code in the session's private workspace with tool calls, and every effect goes through the host's approval rules. |
| **Muse Wonder 1.0** | Writes the **catch-up brief** when someone joins: a short chat-style summary of the goal, what was tried and fixed, decisions and who is waiting on what. |
| **Muse Spark (vision)** | Teammates paste a **screenshot of the bug**; the agent sees it alongside the instruction. |

The host connects once with a Meta Model API key. Teammates never need a key: every model call runs on the host's machine with the host's connection.

## What happens in a session

1. **Host starts a chat** and gives the agent a task (Plan mode to agree first, Build mode to make changes).
2. **Invites a teammate** with a `multai://` link. The host admits them as collaborator or viewer.
3. **Muse Wonder writes a catch-up brief** for the newcomer automatically.
4. **Anyone can send directions** to the agent or talk to the team; a pasted screenshot goes to the agent too.
5. **The host approves** file changes and commands from cards in the chat, or chooses an access level:
   - **Ask for approval**: everything waits for the host.
   - **Approve for me**: workspace edits and ordinary commands run; deleting, installing, network use, escalation or anything outside the workspace still asks, with the reason.
   - **Full access**: everything runs, after an explicit warning. It switches off when someone new joins.
6. Everyone sees the same live timeline: messages, agent replies, tool activity, approvals and decisions.

## Built during the hackathon

Everything in this repository was built during the hackathon: the first commit is from 29 October 2026, after building started on 26 October, and the full history is public. That includes:

- **Desktop app** (Electron + React) for macOS, Windows and Linux, with Google sign-in, `multai://` invite links, a sandboxed renderer and OS-encrypted credentials.
- **Collaboration service** (Fastify + PostgreSQL), deployed at `https://api.multai.si` on AWS Lightsail with Supabase Postgres: sessions, admission and roles, ordered live events, decisions, host-only run leases and approvals.
- **Host runtime**: provider adapters (Meta Model API, OpenAI, Claude, Kimi, ChatGPT plan, compatible APIs), a controlled workspace, exact approval descriptors and a durable effect journal so an interrupted action is never silently repeated.
- **Meta features**: Muse Spark as the agent, Muse Wonder catch-up briefs, screenshot input, access levels and in-chat approvals.
- **Cross-platform CI**: Windows (NSIS installer) and Linux (AppImage, .deb, .tar.gz) builds installed and tested on every push.

## Safety model

- Code, files, credentials and processes stay on the **host's** computer. The service only relays the shared conversation and decisions.
- The agent works in a **private workspace** per session. Every write and command is an exact descriptor (file hash or command text) that the host approves once; approvals expire, and Stop, sign-out or sleep cancel them.
- Teammates' instructions are attributed; team discussion is context, never an instruction.
- Secrets that look like API keys are redacted from shared text, briefs and command output.
- Approval is not an OS sandbox: approved commands run as the host's user. Full access says so before it turns on.

## Run it locally

Node **24**, npm and Docker:

~~~sh
npm ci --ignore-scripts
cp -n .env.example .env
docker compose up -d database
npm run dev:backend
~~~

In another terminal:

~~~sh
npm run build --workspace @multai/runtime
node node_modules/electron/install.js
npm run dev --workspace @multai/desktop
~~~

Sign in with Google, open **Settings → Models & accounts → Meta Muse Spark**, paste a key from [dev.meta.ai](https://dev.meta.ai), start a chat and choose **Run instruction**. Release builds use `multai://` links and talk to `https://api.multai.si`; development builds use `multai-dev://` and the local service.

## Tests

~~~sh
npm run typecheck
npm run test:integration   # backend + runtime against a disposable PostgreSQL
npm test --workspace @multai/desktop
~~~

The **Desktop on Windows and Linux** workflow builds the installers, installs them, and checks launch, the hosted service, OS link routing, single instance, OS credential encryption and uninstall.

## Limits

- File previews in approvals are limited to 16,000 characters; one screenshot per message.
- The agent works in a blank private workspace per session; running directly in an existing project folder is not implemented yet.
- Installers are not code-signed yet, so macOS Gatekeeper and Windows SmartScreen will warn on first launch.
- arm64 Windows and Linux builds are produced but not exercised in CI.

More detail: [authentication](apps/backend/AUTH.md), [collaboration](apps/backend/COLLABORATION.md), [execution](apps/backend/EXECUTION.md), [desktop](apps/desktop/README.md), [inference connections](docs/inference-connections.md). Licensed [MIT](LICENSE).
