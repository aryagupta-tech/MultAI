# MultAI: desktop product context and a genuinely fresh rebuild plan

Prepared 28 October 2026, India Standard Time.

This is a requirements document for a new implementation of MultAI, preserved at the owner's request before removing the previous project. It covers the desktop application, controlled local agent execution and the collaboration service. The owner explicitly excluded the separate website from context preservation; website, marketing and waitlist context are intentionally absent.

## 1. The owner's current direction

Start a genuinely new implementation from an empty folder and an empty repository. Preserve the product idea and its useful behavioral requirements, not the old implementation. Earlier work in a separate new folder reused substantial previous backend code and legacy service configuration; that does not satisfy the requested fresh start. Compiling copied source again would not change its provenance.

Do not copy or restore any previous project source, frontend components, backend/runtime modules, SQL migrations, tests, generated bundles, release installers, native-tool staging directories, repository configuration, application icons, tray images, generated artwork, account profiles or deployment configuration. Do not make a previous published installer the test deliverable. Reimplement the requirements below independently.

Do not inherit old server origins, compatibility aliases, cloud resource names, OAuth clients, callback registrations, account identifiers, encryption/signing keys, provider tokens or application data namespaces. Use neutral placeholders during development and new credentials and resources when a fresh deployment is authorized. Historical operational identifiers and secret values are deliberately omitted here.

Use the MultAI product name if the owner retains it. Recreate any visual identity as new work from a design brief rather than importing old asset bytes. Verify current third-party licenses before selecting dependencies. No previous version number, license file or publication claim automatically applies to the new repository.

The deliverable is a native desktop app people can install and test, with its own newly built interface and local runtime. A product plan, a browser mock, a CLI transcript or an old downloadable release alone does not complete that objective.

## 2. Evidence and limits of this preservation

The preserved requirements were reconstructed from the previous desktop project's README, product context, release acceptance checklist, cross-platform audit, feature coverage, security/native-adapter assessment and designs for composing, skills, defaults, approvals, questions, goals, schedules, visuals, MCP panels, file review, branching and deletion. Selected code and historical discussion summaries supplied context; no source implementation is reproduced in this document.

Historical records described a published 1.0.1 baseline and newer 1.0.2 development. They also recorded evolving platform support and different levels of test evidence. Those records explain product intent; they do not certify any new implementation, deployment, provider access, installer or test result. Earlier source audits and fixture pass counts must never be reported as checks performed on the rebuild.

The previous complete source is not a required input for the rebuild. This document should remain usable after source, binaries and cloud deployments are removed. It does not preserve production database contents, conversation transcripts, participant identities, waitlist data, credentials, OS keychain records or hosted operational state.

Unresolved choices are explicitly identified below. Recheck current provider contracts, model availability, operating-system requirements and package versions during implementation rather than treating old version pins as recommendations.

## 3. Product purpose

MultAI is an installable shared workspace where several people work with one coding agent. Teammates see the same attributed conversation, agent activity, decisions, pending approvals and code changes. The original host's computer keeps the project files and executes the agent. A collaboration service synchronizes the shared session and enforces authority.

The central product object is a shared agent session: conversation, objective, participants, selected inference connection/model, execution status, isolated working copy and ordered activity history. The initial audience is small engineering teams, founders, collaborators and people helping each other build software.

The motivating experience is joining another person's ongoing AI coding task, understanding its accumulated constraints, contributing directions and helping troubleshoot it without requiring the other person to restart their conversation.

The conversation and shared understanding are the primary interface. Native agent CLIs or SDKs are execution integrations beneath that interface. External editors such as VS Code or Cursor remain useful for substantial code editing.

### Core decisions

- Desktop first. Browser participation and cloud execution are separate future capabilities.
- Host-local source access and execution. A teammate must not acquire arbitrary access to the host's files or shell.
- Joining a shared session does not require the teammate's own inference subscription or API key.
- Collaboration identity and inference identity are separate. A user account identifies a participant; the selected host/team connection determines inference access and payer.
- Task leadership, session ownership and execution location are separate concepts. Handoff changes coordination, not host execution or approval authority.
- An instruction's length or rhetorical strength does not give its author more authority. Roles, explicit decisions and visible conflict resolution govern collaboration.
- Do not modify original checkouts merely to create a chat. Use isolated working copies and protect uncommitted work.
- Package the runtime tools end users require. A participant should not have to install Node, Git, agent CLIs, Docker or PostgreSQL just to use the app. A particular software project can still need its own build dependencies.
- Saving a project, choosing configuration, applying guidance or saving a goal must not silently start inference or execution.

## 4. First-use and daily workflows

### First launch

The installer opens an offline-capable welcome/sign-in interface from packaged assets. Online collaboration sign-in opens the system browser and returns through a registered desktop protocol or another verified callback mechanism. The previous product used Google OIDC; retain that requirement unless the owner chooses a different collaboration identity provider.

Successful sign-in creates a personal workspace. Creating or naming a team is optional. Production users should not be asked for a service URL, localhost port, Docker or database configuration. A deliberately separate developer build may support a custom loopback/test service.

Offer a first-sign-in **Connect your AI** step, with clear choices for a supported host account or API provider and **Set up later**. Remember completion per account on that computer. Show friendly model names and only reasoning choices supported by the selected connection/model. Never imply that a provider subscription grants access to a different provider's agent.

### New chat

**New chat** immediately opens a blank composer. Do not ask for a name, objective or folder before the person can type. The first successful send creates one shared session and one private empty working copy, then starts the selected engine. Failures retain the draft and a durable retry identity so retrying cannot create duplicate sessions or worktrees.

Chats outside projects appear under **Chats**. Drafts remain local and scoped to the correct account/session. Do not send a draft simply because its model or options changed.

### New project and project chats

**New project** asks for a name and a native-picked folder. Saving remembers a local registration without editing the folder or starting an agent. Empty projects survive restart. A project's plus action creates a chat using a separate worktree from an explicitly selected committed baseline.

Project IDs and names may be shared for grouping. Canonical folder paths and folder mappings remain private to the signed-in account, service and computer. A teammate can continue a hosted project conversation; starting a new executing project chat requires a valid folder mapping on the executing computer.

Removing a registration does not remove its original folder, existing worktrees or shared conversations. Deleting a conversation and removing a project registration are different operations.

### Invite and join

The owner creates an invitation. A participant follows an HTTPS invitation and opens the installed app through a verified custom protocol link. The original owner admits the person as collaborator or viewer. Possessing a URL is not sufficient membership authorization. Reject expired, revoked, malformed and deleted-session invitations.

Both clients must observe the same admitted membership, ordered events, attribution, decisions and current diff. Revocation closes existing live access and denies subsequent API requests.

### Work on a task

People choose between **Agent instruction** and **Team discussion**. Discussion is human conversation and does not become an agent instruction automatically. Compatible directions are combined or queued at safe execution boundaries. Conflicting cross-author directions pause for an owner resolution rather than being silently reordered into a winner.

The host reviews exact shell/external actions before execution. All participants see meaningful shared activity and results. Host-only private tools remain clearly labeled. A teammate can ask for or discuss a change without gaining a direct filesystem or shell capability.

## 5. Authority and roles

Implement a small explicit role/capability model, checked independently at service, desktop IPC and runtime boundaries. Disabled buttons are useful explanations, not an authorization boundary.

| Capability | Original owner on original host | Collaborator | Viewer |
| --- | --- | --- | --- |
| Read admitted conversation, decisions, shared activity and allowed previews | Yes | Yes | Yes |
| Submit agent instructions and team discussion | Yes | Yes | No |
| Approve a host command, external action or connection startup | Yes | No | No |
| Configure host inference connection, engine or execution settings while inactive | Yes | No | No |
| Save an explicit decision while inactive | Yes | Yes | No |
| Replace an existing decision | Anyone's, with explicit replacement | Own decisions | No |
| Start a private interactive terminal or local device action | Yes, with required approval | No | No |
| Delete the shared session while inactive | Yes | No | No |
| Participate in permitted leadership handoff | Yes | Subject to the defined handoff policy | No |

Decide manual shared-file editing permissions explicitly before implementation; the prior design permitted selected inactive collaboration actions but must not accidentally grant remote filesystem authority. The original host must mediate every actual local read/write.

Owner means session ownership, not whoever currently leads the task. The original executing device must match a private session/worktree association. Joining on another computer or transferring leadership must not replace that association.

Stop, revoke, sign-out, account/model/connection change, runtime replacement, sleep, disconnect, recovery and Quit must fence late callbacks and invalidate authority as appropriate. Preserve independent account/session/runtime generations so one stale response cannot affect a different account or payer.

## 6. Plan, Build and exact approvals

**Plan** allows safe inspection, discussion and self-contained visual explanation. It blocks filesystem writes, shell commands and external/MCP execution at both the central service and local runtime. An engine's own permissive tool mode must not bypass this policy.

Only the owner explicitly switches an inactive chat to **Build**. A plan card shows a proposal and progress; it does not authorize implementation or dispatch tools on its own.

Every shell command and external action requires an original-host approval bound to an immutable descriptor containing at least:

- Session, original owner, executing device and runtime generation.
- Actual operation/tool, native executable or shell, exact argument array or command text, and transport where relevant.
- Canonical working directory, selected connection and relevant resource identity.
- Expiry, one-use request identity and a deterministic content hash.

Changing arguments, shell, working directory, resource, connection, generation or relevant state invalidates the approval. Reject stale, expired, changed, canceled and already consumed requests before dispatch. Reconnection or a stored approval record must not grant fresh authority.

Approval explains what will run as the host's OS user. An approval gate is not a general operating-system sandbox. Do not promise that an approved command cannot access resources available to that user.

App-owned Git setup/inspection must suppress unreviewed hooks, external filters, signing helpers and file-monitor programs through a separately reviewed safe configuration. A normal user-approved command must accurately describe its actual shell and startup behavior.

## 7. Recommended new architecture

Use a modular TypeScript implementation with an Electron desktop shell, a React renderer and a separate collaboration API. These are recommended technology families from the product requirements, not authorization to transplant the previous module tree. Choose current supported versions after checking primary documentation and target-platform compatibility.

```text
Installed desktop application
  UI: conversation, composer, projects, review and settings
       | narrow validated IPC; no bearer/provider credentials
  Desktop host: encrypted accounts, native dialogs, lifecycle, previews
       | private session/device binding
  Local worker: controlled agent adapters, workspace tools, execution journal
       | outbound HTTPS / WebSocket
Collaboration service
  Identity, membership, ordered events, permissions and action reservations
       | transactions, row-level concurrency and migrations
  PostgreSQL
```

The service never runs arbitrary shell commands or directly opens a host's worktree. The renderer never gets Node integration, host filesystem access, raw bearer tokens or provider secrets. Only narrowly defined, schema-validated IPC crosses into native code. Validate the sender/window/frame as well as the payload.

Start with one service instance for a small, understandable deployment. If live presence/event fan-out is process-local, document the single-instance limit. Horizontal scaling requires explicit shared coordination, not simply running more containers.

Build the collaboration service as a separate minimal artifact without desktop/native dependencies. Installed desktop packages contain UI and local runtime assets, not private deployment material or the server bundle.

## 8. Domain model and persistence

Design a new schema around users, personal/team workspaces, membership, registered devices, provider connections, projects, sessions, participants, ordered events, invitations, instruction queue, approvals, decisions, goals, schedules and bounded rendered documents. Design fresh migrations; do not reuse old SQL files merely because names seem familiar.

Use PostgreSQL transactions and explicit concurrency control around changes that must agree: session creation, event sequence allocation, ownership/generation changes, action reservations, simultaneous instructions, decision replacement, scheduled claims and deletion. Apply migrations transactionally with an integrity/checksum policy and safe startup locking.

Use durable idempotency keys for user requests and host effects. Preserve the association among a first-send retry, session and worktree. Two simultaneous retries must not create two conversations or execute one action twice.

Locally, use the OS application-data directory with account/service/device scopes. Separate encrypted credentials from ordinary preferences, project registrations, worktrees, review data and runtime journals. Do not claim that every conversation/checkpoint file is encrypted because credential records use OS encryption.

A SQLite execution journal should record prepared, executing, completed and uncertain calls, their immutable fingerprints and saved results. Keep a durable outbound event queue until acknowledged. A completed exact retry returns its saved result. A call found executing after crash becomes **uncertain**; never automatically repeat a side effect to make state appear clean.

Maintain monotonically ordered shared event sequences and replay cursors. Socket reconnect replays missed events, deduplicates already received events and refreshes authority. A server restart marks hosts unavailable and expires pending authority; it does not start new agent work.

Bound retained output, previews, rendered documents and caches. Decide retention deliberately, expose unavailable historical content honestly and keep cleanup account/session scoped. A review cache is not a backup.

## 9. Files, baselines and worktrees

For a Git project, resolve a selected ref to a specific commit and create an independent detached worktree. Display the baseline and worktree location. Preserve the original tracked/untracked files and index. Do not silently copy dirty checkout changes into a new chat.

For an ordinary folder, create a private, bounded filtered snapshot and committed baseline before starting a separate working copy. Exclude credential paths, ignored/private files, unsafe links and unsupported content. Show meaningful omissions. Fail clearly for unsupported submodules, oversized snapshots or unsafe folder relationships rather than silently broadening scope.

For blank chats, use an independent empty private workspace. Different chats and model comparisons must have distinct worktrees. Detect overlapping canonical paths so two executors cannot unknowingly mutate the same working copy.

Provide controlled list/read/write/search/diff tools with bounded UTF-8 text handling. Deny traversal, absolute-path escape, symlink/junction escape, credential paths, binary/oversized content and unsafe parent replacement. Check selected and resolved paths. Revalidate before a write instead of relying only on an earlier path-string check.

Manual preview saves are inactive operations with expected-content hashes and atomic single-file replacement. An intervening edit in an external editor must cause a stale-save rejection, not overwrite newer work. Keep user-visible errors precise enough to recover.

Read-only Git status, refs and diffs can support review. Dedicated stage, unstage, commit, push, clone, publish and forge account actions are separate future work. An available shell does not mean the product has implemented safe dedicated Git workflows.

## 10. Inference connections and controlled agent engines

Keep provider transports and agent engines separate. A provider adapter handles a verified inference protocol and credentials. An engine adapter manages a coding loop or native agent lifecycle, controlled tool calls and normalized events.

The target product supports three families, introduced incrementally:

1. A local app-owned coding loop using a supported provider protocol, controlled workspace tools and bounded/cancelable stream framing.
2. A pinned Codex app-server adapter with verified structured protocol and app-controlled tool callbacks.
3. A pinned Claude Agent SDK adapter with verified callback/tool isolation.

Reassess current APIs, distribution licenses, model capabilities, SDK terms and platform binaries. Historical runtime versions do not establish safe compatibility today. Refuse an unknown native version until it passes the permission suite.

Do not parse a terminal transcript as the source of truth for tool execution. Observing a tool event or receiving a native permission prompt does not prove mandatory pre-execution control. All built-in unmanaged shells, filesystem tools, hooks, extensions, connectors, helper commands, worker spawning and automatic environment discovery must be disabled or proven unreachable. Register only reviewed app-controlled capabilities.

Use a private app-managed runtime configuration. Never silently import the user's global Codex/Claude profile, token files, agent instructions, hooks or native catalog. Native secrets must not be copied into command environments.

The host may explicitly connect an inference account through an authorized flow, or choose an API connection. Host account tokens stay on that host in OS-encrypted storage. A host-local inference proxy, if required by the verified provider contract, validates session/model/generation grants before contacting the provider. Centrally stored team API keys use authenticated encryption and are never returned to participants.

Use short-lived, scoped inference grants. Validate selected account, engine, model, connection, session and generation on each request. Sign-out, payer switch or engine replacement cancels old requests. Partial streams need byte/event bounds, split UTF-8 handling, framing, idle/deadline control and cancellation propagation.

Discover models from the connected provider where possible. Friendly names and reasoning levels must reflect actual capabilities. Treat missing usage/context telemetry as unknown; never invent subscription balance, cost, remaining context or model-window estimates. Avoid double-counting cumulative native usage reports.

Additional engines, generic ACP launchers and arbitrary installed commands remain disabled until individually pinned and verified. A protocol registry listing or an SDK's tool-use notifications alone are insufficient evidence.

## 11. Collaboration semantics

### Instructions, queues and conflicts

Keep an attributed ordered queue separate from conversation discussion. Support after-turn delivery and steering at a safe boundary, with editable/removable/reorderable pending instructions according to capability. A revision/claim mechanism prevents stale edits and multiple application.

The same person can refine their own direction without unnecessary team arbitration. Cross-author incompatible directions pause visibly for owner resolution. Never let a new prompt silently erase a saved decision. No conflict resolver should invent an optional reason or attribute it to a person.

Failed sends retain draft and retry identity. Input-method composition must never trigger a send or dismiss a dialog. Define keyboard behavior consistently: normal Enter delivers according to the selected mode, Shift+Enter adds a line, and an explicit alternate shortcut may use the other delivery mode.

### Decisions

People explicitly save a decision with text, author, source and optional reason. Maintain current/replaced status and replacement links rather than rewriting history. Owners can replace any decision; collaborators replace their own. Apply current decisions to every author and carry them through summaries, reconnect and engine changes.

Resolve an instruction conflict by recording the agreed decision before continuing. If an older runtime cannot enforce decision memory, require an update rather than silently running without it.

### Questions and plans

Structured questions are original-host-only, nonsecret, bounded and hash/generation bound. An unanswered question has no automatic default or timeout answer. Cancel old questions on generation changes, disconnect/recovery and runtime replacement. Never replay an old answer into a restarted process. Prevent conflicting pending question and action approval states.

Show proposed plan steps and progress as shared information. A plan update does not grant command authority or start Build mode.

### Context, branching, handoff and comparisons

Offer explicit bounded context summaries preserving objective, current constraints, decisions and relevant progress. Summarization must not grant tools or silently start a task. Invalidate telemetry and derived caches whose native context no longer matches.

Reviewed cross-chat context requires explicit source selection and clear sharing boundaries. Portable handoff is reviewed context, not a hidden credential/profile transfer. Independent model comparisons create independent chats, payers and working copies; one failed comparison must not corrupt the other.

Chat branching from a committed baseline must explain that uncommitted work is not copied and that no agent starts until a new explicit instruction. Exact provider-context rewind and byte-perfect worktree restoration require additional mappings, private backups and failure-tested journals; keep them unavailable until implemented separately.

## 12. Frontend experience and design brief

Build a new interface from these requirements. Do not import the previous renderer, CSS, state slices, components, icons or minified release bundle. A new repository history should show its own scaffold, feature implementation and tests. Keep a provenance log of deliberately selected third-party libraries/assets and newly created brand assets.

Use a simple dark workspace, black by default, with near-black surfaces, restrained muted text, a clear accent and a newly drawn stacked-layer identity if desired. Keep the conversation central. Use progressive disclosure for detailed activity and tools rather than filling the screen with controls.

### Main surfaces

- **Sidebar:** searchable Chats and Projects, new actions, pinning, rename, archive/restore, optional local custom sections, manual ordering and account/settings access.
- **Session header:** understandable session/host/state identity, friendly engine/model/reasoning selection, Plan/Build, invite/people, Stop/Resume and task options gated by authority and inactivity.
- **Conversation:** attributed human discussion/instructions, streamed agent text, grouped tool activity, approval cards, questions, plans, decisions and system/recovery events. Preserve scroll position while streaming and offer Latest activity.
- **Composer:** local per-chat draft, explicit instruction/discussion choice, model/options access, send/stop/steer/queue controls, saved prompts, history recall and optional local Markdown preview/format insertion.
- **Inspection panel:** Changes, Files, Search, Activity, Approvals, Decisions, Goal, Schedules, Skills, Connections, Usage, private Terminal and private Local Browser, exposed progressively.
- **Command navigation:** searchable actions/projects/chats with keyboard navigation and accurate availability.
- **Settings:** models/accounts, general behavior, appearance, keyboard shortcuts, project defaults, selected connections, notifications, diagnostics, updates and sign-out.

### Frontend implementation rules

Use typed view models separate from service wire contracts. Write explicit projections and action adapters rather than assuming a backend snapshot matches UI state. Production desktop builds use the real bridge/service. Any demo fixtures are conspicuously labeled and loaded only in an explicit development/demo mode. The installed app must never quietly show simulated collaboration as live data.

Use theme tokens, accessible focus, meaningful button labels, proper dialog focus/body scrolling, readable errors and usable empty/loading/offline/recovery states. Design compact and large-text/density modes, reduced motion, long lists and small native window sizes. Test native title-bar insets, high DPI, platform fonts and keyboard conventions.

Suggested shortcuts: Cmd/Ctrl+N new chat, Cmd/Ctrl+K command navigation, Cmd/Ctrl+B sidebar, Cmd/Ctrl+Shift+N new project and Cmd/Ctrl+, settings. Confirm collisions before finalizing. Do not let keyboard shortcuts bypass disabled capabilities or IME composition protection.

Local Markdown previews must be inert: no remote images, script execution, filesystem loads or hidden requests. Formatting inserts editable text and never sends automatically. Honor a documented bounded draft limit and leave the draft unchanged if an operation would exceed it.

## 13. Review tools and private host surfaces

### Files, search and diffs

Provide bounded directory/text search, safe readable file previews, line numbers and quoting selected text into discussion. Markdown, CSV/TSV and inert HTML previews may be introduced after text safety. Images, PDFs, audio/video and native export are separate capabilities.

Changes supports split/unified diff, file navigation, wrapping, literal search and reversible whitespace filtering. Private viewed marks and file notes are scoped to the exact patch and account/session. They do not become shared code-review claims. Render large files/diffs lazily with clear truncation.

Activity groups replay-safe tool operations with exact pending/running/completed/failed/uncertain status, exit information and searchable bounded output. Successful-turn snapshots are review material; do not use redacted diff caches as exact restoration backups.

### Interactive terminal

The human interactive terminal is a private original-host surface, separate from agent command output shared with teammates. Require explicit approval for shell startup. Support real PTY tabs, resize, interrupt, search and copying, with process-tree cleanup on close/Quit. Bound in-memory output; closed-shell history is opt-in and OS-encrypted. Do not expose terminal access to a collaborator through leadership handoff.

### Local browser

Provide isolated native views for explicitly chosen loopback development servers. Enforce loopback/origin policy, private partitioning, navigation restrictions and no desktop bridge/account permission inheritance. Offer tabs, accurate desktop/tablet/phone/custom viewport sizing and an explicit capture action. Block downloads, unexpected browser permissions and external navigation by default.

An agent browser tool, element annotation, user-profile reuse, arbitrary internet browsing and browser participants are separate features.

### Optional local devices

Device/emulator controls require separately installed vendor SDKs, explicit discovery/action approval, current ownership, bounded gestures/frame capture and late-cancel fences. No teammate inherits device authority. Start with no devices; add each platform only after actual SDK/process tests. Do not imply physical-device or continuous-streaming support from source fixtures.

## 14. Skills, defaults and external connections

Skills are bounded plain written guidance. Commands are editable prompt templates. Preview before applying/inserting. Selecting or applying guidance while inactive must not start inference, execute a shell or weaken Plan/approval rules. Applied shared text is visible to participants and the selected model; personal library storage remains private until applied.

Build a new account/service/device-scoped personal library and an explicitly discovered project-local library. Limit metadata, file sizes, prompt lengths, entry counts and selected total text. Reject executable fields, hooks, binary/control text, credential material and unsafe links. Use version/hash checks for changes and keep an applied copy stable even if its source later changes.

Repository defaults are an explicit preview/import of selected metadata such as model, engine, reasoning, ref, name and icon. Compare against private current values. Reject unknown executable instructions, hooks, scripts and credential fields; revalidate both file and project hashes before import. No startup scan or automatic inheritance.

Native agent guidance discovery may show bounded names/descriptions from conventional worktree-local locations, but discovery is not activation. Do not read the entire home directory or import guidance bodies/credentials automatically.

External MCP connections are opt-in, explicitly selected and private to the host. Startup/discovery and each tool/resource action require the original-host gate. Build a private selected-server profile, not a clone of the user's global agent configuration. Keep credentials and raw connection metadata out of participant responses, logs and inference context.

A first implementation may support one verified native adapter for MCP. Do not advertise a universal connector catalog or infer that Claude/API-loop engines have the same connection capabilities. Real remote OAuth and approved tool use require separate live acceptance.

## 15. Self-contained visual replies and MCP panels

Allow a controlled visual tool to render an original self-contained diagram, chart or interactive explanation without creating project files. Validate bounded title/UTF-8 HTML sizes and redact recognized credentials. Store immutable session-scoped documents with bounded count/total bytes; conversation events retain summaries, and session deletion removes the documents.

Render in an opaque sandbox with a strict CSP. Allow only the minimal inline scripts/styles/data images needed. Block external requests/assets, frames, forms, workers, navigation, popups, browser permissions and desktop IPC. A visual has no tool authority and cannot pretend to be an MCP application.

An approved MCP panel is a separate source. Bind its immutable document to a selected server, exact resource URI/tool, session and generation. Validate actual resource catalog/MIME/visibility before an approved read. Viewer copies are read-only. Tool actions require one-use bounded messages from that exact frame and a separate original-host approval for exact arguments.

Support only capabilities verified in the new host. Sampling, model-context changes, clipboard writes, downloads, external links, camera/microphone/geolocation and nested remote resources should return explicit unsupported results until deliberately implemented. Never relax the ordinary renderer's security policy to make an embedded panel work.

## 16. Goals and schedules

Goals default to manual continuation. Saving or activating a goal does not start execution. If the owner explicitly enables bounded sequential continuation, a fresh live Resume arms it privately for a documented successful-turn cap. Do not persist an armed state across restart. Questions, approvals, conflicts, errors, control changes, disconnect, recovery and Quit disarm it. Every external action still needs its own approval.

A successful turn is not proof that the business objective is complete. A turn cap is not a monetary budget. Actual completion requires the defined goal evidence or owner decision.

Schedules are host-pulled prompts in the same session, not cloud commands or host wakeup. Saving and enabling are distinct explicit actions. Support bounded intervals or local daily times with IANA time zones and documented weekday/DST rules. The app must be running, synchronized, inactive and authorized; human pending instructions take precedence.

Claims use session locking, fresh runtime/device/generation/heartbeat checks and unique occurrence identities. Missed/busy windows are skipped; there is no surprise backlog after sleep, downtime or re-enable. Persist pending/started markers before dispatch. Uncertain starts require review, never automatic replay.

Stop, disable/update/delete, disconnect, service restart or session deletion cancel reservations and invalidate stale authority while preserving applied history and partial work. No webhook delivery, automatic host wakeup or cross-session worker orchestration is implied.

## 17. Credentials, privacy and diagnostics

Use OS-backed encryption for desktop account/refresh/provider credentials. On Linux, fail securely when an approved unlocked keyring is unavailable; never fall back to plaintext. Keep sensitive records account/service/device scoped and reject late callbacks after sign-out or account changes.

The collaboration service stores centrally required provider secrets with authenticated encryption under an independently generated key. Pair database backups with the matching private key through a deliberate operations plan. Do not invent a key-rotation workflow that cannot safely read existing records.

Google OIDC must verify signatures, issuer, audience, expiry and a fresh nonce. Bind desktop completion to the initiating flow/client/verifier/callback and use one-time completion plus rotating refresh credentials. Store invitation/device/refresh secrets appropriately, not as raw long-lived shared identifiers.

Be explicit about data flow: shared conversation, selected previews/diffs and relevant inference context pass through the collaboration service and chosen provider. Host source files are not wholesale mirrored merely because the project is registered. Selected-account inference credentials remain private according to their host/service boundary.

Logs and activity redact recognized secret formats and avoid raw credentials, private provider metadata and sensitive environment values. Diagnostics are a bounded reviewed local export: show the proposed content, bind approval to its hash and do not silently upload it. Missing telemetry is unknown, never zero.

Notifications are opt-in, redacted and account/session scoped, with background-only behavior where appropriate. Request real OS permissions through an honest user flow. A setting being toggled in a fixture does not establish native delivery.

## 18. Lifecycle, archive and deletion

Closing the window may keep hosted execution running in the tray/menu bar. **Quit** must stop owned workers, terminal process trees and native surfaces safely. Sleep, network failure, worker termination and service restart pause or revoke execution; they must not create automatic side-effect replay. One executor per session is mandatory.

Archive is a reversible private sidebar operation. Permanent session deletion is owner-only, inactive and distinctly confirmed. It removes shared conversation/history, invitations, grants and rendered documents; stops/cleans the corresponding private runtime metadata; and rejects late events or stale resume attempts. Project source and worktree files remain intact unless a separate explicit file deletion is requested.

Offline participants must reconcile deletion on reconnect. Failed central deletion and failed local cleanup are different outcomes and should be reported distinctly. Do not revive deleted data from an old UI cache. Backups retain their documented policy; the product must not imply instant removal from every historical backup if that is untrue.

Account switching, sign-out, project removal, session deletion and upgrades must preserve unrelated accounts, drafts, projects and filesystem work. Test these separations explicitly.

## 19. Fresh infrastructure plan

Begin locally with an isolated development database, test identity/provider endpoints and synthetic workspaces. No existing cloud deployment, account, domain, API origin, resource ID or credential is required. Do not reattach old endpoints to make sign-in appear to work.

For a new authorized production environment, define neutral placeholders first: `<collaboration-domain>`, `<oauth-client>`, `<database>`, `<artifact-store>` and `<backup-store>`. Provision fresh resources only after the owner approves the target architecture and costs. Generate independent application signing/encryption secrets and fresh OAuth clients; restrict callbacks to the new intended domains.

A small single-instance service behind a TLS reverse proxy with private PostgreSQL is a reasonable starting architecture. Cloud vendor and instance size remain choices, not inherited requirements. Keep only HTTPS publicly reachable; do not expose the database or developer ports. Run non-root containers with minimal privileges, read-only filesystems where practical, bounded temporary storage/logs and controlled outbound access.

Design authentication, TLS renewal, database migrations, encrypted backups, restore drills, health/readiness checks, retention, alerting and teardown ownership before publication. If using a cloud account shared with unrelated projects, tag every new resource and record exact ownership. Avoid unnecessary networking components and explain expected recurring costs.

A backup is useful only if restoration has been tested with its matching key. Use an intentional retention policy and publish accurate deletion/retention statements. Keep a sanitized resource inventory so the new project can later be removed without searching an entire account.

## 20. Packaging, updates and provenance

Proposed release targets are macOS Apple Silicon, Windows x64, Linux x64 and Linux ARM64. Intel Macs and additional Linux distributions/architectures remain unsupported until explicitly tested. Establish a supported OS/distro/display/native-library matrix instead of promising generic platform parity.

Build new installers from the new repository. Bundle verified target-native Git, Node/npm and only the approved native agent/runtime tools, with their licenses and exact digests. Tool downloads occur during the build, not unexpectedly on user startup. Review archives, extraction boundaries and executable permissions. Optional project dependencies/vendor SDKs remain separate.

Package allowlists and pre/post guards must exclude credentials, private deployment folders, test fixtures, source caches, other-platform binaries and unintended server bundles. Validate unpacked native extras and symlink boundaries as well as the archive. Keep a build manifest containing the new source commit, clean/dirty status, build time, tool versions and per-artifact hashes.

Create native CI jobs for each target. Bind source checks, package content checks, native launch evidence and release artifacts to one integrated source revision. Creating a private artifact is not publishing it. Do not download a previous public release and call it a fresh local build.

Before opening a fresh test app, verify its build manifest and installed executable path against the current source commit. Label development builds clearly, such as a new development version plus commit/build time. Never rely on file modification time or a UI version string alone for provenance.

Sign/notarize macOS and sign Windows artifacts before making trusted-distribution claims. Verify actual fresh-download Gatekeeper/SmartScreen behavior. An ad-hoc signed local app launching without a prompt is not evidence that a downloaded installer will be trusted.

Updates use a bounded validated release manifest with unique platform/architecture targets, semantic version, publication time, exact filename/URL, file size and SHA-256. Verify the actual hosted bytes. A newer available release appears as a compact sidebar icon; clicking rechecks metadata and begins the explicit download. No automatic installer download, install or restart.

Keep source version, installed build version, published manifest version and server version distinguishable. A local build must never silently advertise an unrelated historical hosted artifact.

## 21. Deliberately deferred features

The following are not part of the core rebuild and must not appear enabled merely because a proposal or placeholder exists:

- File attachments, pasted/dropped images and automatic file mentions/transmission. A future feature needs explicit picker/drop/paste intent, visible sharing disclosure, path/secret checks, byte limits and a documented retention policy.
- Dedicated stage/unstage/commit/push, clone/publish, pull-request lifecycle and forge accounts.
- Provider conversation rewind, exact-byte filesystem restoration and undo of arbitrary shell/external effects. Review snapshots and redacted diff caches are not safe restoration material.
- Arbitrary native agents, generic registry execution, unmanaged hooks/plugins/connectors, worker spawning and coordinated parallel workers sharing one task.
- Browser-only participants, cloud agent execution, moving execution between machines and automatic host wakeup.
- Automatic installation/restart updates, integrated billing/subscription management and invented cost/subscription balances.
- Global native history/profile import, automatic repository guidance inheritance and executable skill packages.
- Physical-device control, continuous device streams, broad browser profiles and agent browser automation unless separately designed and verified.

These exclusions preserve product focus. Additions require their own design, authority, privacy and native acceptance evidence; do not hide them behind a general full-access setting.

## 22. Implementation sequence and exit gates

### Phase 0: establish a demonstrably fresh baseline

Create an empty folder and new repository, write new project instructions and this requirements summary, choose a new package/application-data identity and document all dependency/asset sources. Add a prominent development-build identity and a build provenance manifest. Do not import prior files, binaries, migrations or configuration. Resolve licensing and whether to retain the product name.

**Exit:** the repository's first commits contain a new scaffold and no legacy URLs/resource identifiers/credentials; there is a recorded empty baseline and clear implementation ownership.

### Phase 1: secure installed shell and new frontend foundation

Build Electron main/preload and a new React UI with welcome, loading, offline/error states, basic sidebar/conversation/composer, theme tokens and accessible primitives. Enforce sandboxing/context isolation, narrow validated IPC and packaged asset loading. Produce an initial native app before expanding features.

**Exit:** a clean machine launches the new offline shell without a dev server; the renderer cannot access Node or secrets; the app identifies its actual fresh source/build.

### Phase 2: identity and ordered collaboration

Implement fresh service schema/migrations, Google collaboration sign-in, personal workspace, device registration, session membership, invitations/admission, ordered events, live replay/revocation and role checks. Keep all provider inference disabled initially.

**Exit:** two independent clients share the same attributed discussion and membership; viewers cannot submit, revoked users lose HTTP/socket access and reconnect yields no duplicate events.

### Phase 3: isolated projects and controlled local tools

Implement native folder picking, durable project registration, first-send retry identity, separate Git/ordinary-folder/blank baselines, safe file list/read/write/search/diff and a local durable effect/outbox journal. Keep original dirty files intact.

**Exit:** two chats have independent working copies; a retried first send creates one session; unsafe paths/links/credentials are refused; crash uncertainty cannot repeat a write or command.

### Phase 4: approvals and one real inference engine

Implement immutable action descriptors, generation/owner/device checks, rejection/cancel/expiry behavior and Plan/Build at both boundaries. Add one app-owned provider coding loop with only controlled tools, real Stop/cancellation and scoped provider credentials.

**Exit:** the agent changes an eligible file, waits for an exact original-host test-command approval and shares results; rejection produces no effect; a viewer/collaborator/stale request cannot approve or bypass it.

### Phase 5: shared direction and recovery

Add steer/queue semantics, conflict pause/resolution, explicit decisions, structured questions/plans, lifecycle fencing, explicit Resume, sign-out/account/payer isolation and permanent-session deletion. Complete the primary two-person coding task before optional tools.

**Exit:** two identities perform a real task, resolve a conflict and recover from service/worker/network failure without duplicated effects or changed authority.

### Phase 6: verified native engines

Individually research/pin/verify Codex app-server and Claude SDK distributions. Use private configuration and only controlled tool callbacks. Add capability-driven model/account UX and native process tests. Do not enable unknown versions or extra engines.

**Exit:** each enabled engine passes the same reject/stale/cancel/replay/path/credential/Plan tests using its actual native runtime, then succeeds in real provider acceptance.

### Phase 7: useful review and workspace depth

Complete file/diff/activity panels, private notes, searchable conversation, saved prompts, settings/appearance, project defaults, private PTYs, loopback browser, usage reporting, explicit summaries, independent comparisons and committed-baseline branching. Keep production and demo fixtures distinct.

**Exit:** the installed UI uses real backend data and meaningful errors; private host tools remain private; long lists/text and target-native layouts are usable.

### Phase 8: optional bounded extensions

Add plain skills/commands, reviewed native metadata discovery, one verified selected MCP path, self-contained visual replies, constrained MCP panels, then explicit goals/schedules and optional devices if justified. Each capability has a separate authority/privacy/replay test set.

**Exit:** no extension starts from saved configuration alone or escapes the original-host gate; unsupported capabilities are visibly unavailable.

### Phase 9: fresh deployment and release

Provision only new authorized infrastructure, new TLS/OAuth/secret state, private database and tested backups. Build native installers from one integrated new commit, sign where available, run target installers and live two-user/provider acceptance, publish new artifacts and verify downloaded bytes/manifests. Produce honest release notes naming limitations.

**Exit:** a person can download the actual fresh release, install, sign in, connect inference, create/join a task, approve a command and review the same changes from a second client.

## 23. Required verification matrix

Use meaningful tests for invariants and actual processes. Unit tests alone cannot establish native acceptance; fixtures must be clearly named synthetic. Record OS, artifact hash, fresh source commit, runtime version, model identity and outcomes without credentials.

1. **Clean install:** no preinstalled Git/Node/agent runtime; offline shell launches; online sign-in returns from the system browser; secure cold restart and sign-out/account separation work.
2. **Two identities:** create/admit/invite, ordered simultaneous messages, discussion versus instruction, viewer denial, revocation, conflict resolution and shared decisions/diffs.
3. **Files/worktrees:** dirty originals preserved, blank and ordinary-folder snapshots, independent chats, selected committed ref, traversal/link/secret/binary/size rejection, external-edit stale save.
4. **Exact authority:** changed command/shell/cwd/resource/connection, rejected/canceled/expired approval, old runtime generation, leadership handoff and revoked owner/device checks produce no dispatch.
5. **Crash/replay:** completed retries return saved outcome; interrupted effects become uncertain; worker kill/network loss/Stop/Quit/service restart never cause automatic replay or surprise startup.
6. **Native engines:** actual pinned binaries refuse built-in shells, unmanaged MCP/hooks/plugins/workers and global profiles; unknown versions fail closed; real provider sign-in/inference is separately recorded.
7. **Plan mode:** file writes/shell/external actions fail at service and local boundaries; questions/plans/visual explanation cannot start Build.
8. **Private surfaces:** PTY process-tree cleanup, optional encrypted history, local preview origin/security/focus/viewport behavior, device ownership and cancellation.
9. **Embedded documents:** network/IPC/frame escapes denied; forged source/window/nonce/generation rejected; viewer tool actions refused; stored documents bounded and deleted with session.
10. **Goals/schedules:** no execution from save, disarmed restart/recovery, no missed-run backlog, concurrency/DST/clock jumps and occurrence deduplication, normal command approval preserved.
11. **Deletion:** inactive owner only, confirmation cancellation, offline participant reconciliation, stale callback rejection, central cascades and separate local-cleanup errors; project/worktree/other-account bytes preserved.
12. **Packaging:** per-platform actual installer, archive allowlists, native dependencies, deep links, signing/trust, notification prompts, uninstall, same-version reinstall and a real cross-version upgrade preserving intended private data.
13. **Deployment:** genuine PostgreSQL locking/concurrency, health versus OAuth readiness, TLS/WebSocket/streaming, database/key restore drill, private ports, restart and known resource ownership/cost.
14. **Public release:** exact hosted file sizes/hashes, target selection, new source/artifact provenance, malformed/offline manifest behavior and manual sidebar update flow.
15. **Human completion:** two fresh native installations complete one real coding task with real inference, original-host command approval, consistent changes and reconnect. Name every remaining unsupported target/capability.

## 24. Open decisions and prerequisites

- Confirm product name, license, new application/data identity and whether to recreate a stacked-layer brand. This document does not preserve any old brand asset file.
- Choose new repository location and create its identity under the owner's intended GitHub account only when requested. Check authenticated account and verified commit identity before any push/merge.
- Choose current supported runtime/library versions, distribution terms, supported OS minimums and Linux distro/display/keyring requirements through primary-source research and native verification.
- Create fresh collaboration OAuth clients and provider authorizations. Provider subscriptions, paid usage and account access cannot be reconstructed from product source or this document.
- Choose fresh cloud vendor/domain/resources and an explicit recurring budget before provisioning. Nothing here authorizes paid services or restores deleted resources automatically.
- Set realistic V1 scope. A secure shared-task vertical slice takes priority over reproducing every optional panel before its backend exists.
- Decide exact manual collaborator edit capability, schedule DST policy, retention limits, backup duration, data-deletion statements and the scope of shared diagnostics before enabling them.
- Obtain signing/notarization credentials if trusted public distribution is required. Do not weaken OS security or mislabel unsigned builds as signed.
- Revisit remote MCP OAuth acceptance, unsupported native engines, attachments, dedicated Git actions and rewind only through separate designs. Previous proposals are context, not implementation authorization.

## 25. Copyable starting brief for the next implementation

> Build a new desktop application called MultAI from an empty repository using the requirements in this document. Several people share one coding-agent session while the original host retains source files, execution and exact command/external approval authority. Start with a newly written installed shell, a new React interface, fresh service schema, two-client ordered discussion, isolated worktrees and one controlled inference engine. Preserve dirty originals, credentials, role checks, generation fencing, durable idempotency and explicit recovery. Keep collaboration identity separate from inference account/payer. Do not copy any earlier source, components, CSS, tests, migrations, assets, installers, account profiles, secrets or deployment configuration; do not reuse legacy endpoints or claim old artifacts as new builds. Record provenance and show the actual new source/build identity. Ship a real secure shared-task vertical slice and target-native acceptance before optional tools. Never substitute demo fixtures, historical test counts or an older public release for evidence that this new application works.

The rebuilt product is complete only when the new implementation and its actual installer demonstrate these behaviors. This document preserves the product context; it does not claim that the new product has already been built, tested, deployed or released.
