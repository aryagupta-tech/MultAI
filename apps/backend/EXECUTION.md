# Original-host execution protocol

The service grants authority; the original desktop host owns inference credentials, workspaces, files and processes. A collaborator never receives a shell/filesystem endpoint. The renderer receives typed summaries through validated IPC, not provider/service bearer credentials or canonical workspace paths.

Sending an instruction creates an attributed pending entry. The original owner/device explicitly chooses **Run instruction** or **Resume** with a selected connection/model. Configuration, model discovery, project registration and startup never dispatch a run.

## Routes and context

All routes require the ordinary service bearer header. Runtime routes additionally require current original-host authority. Lease secrets stay in native memory/request bodies, never URLs, logs or participant events.

| Route | Purpose |
| --- | --- |
| POST /v1/sessions/:sessionId/runs | Claim one pending instruction with request identity, connection/model, expected generation and native-generated lease secret. Explicit resume acknowledges interrupted authority. |
| POST /v1/sessions/:sessionId/runs/:runId/heartbeat | Renew the host lease. |
| POST /v1/sessions/:sessionId/runs/:runId/events | Publish bounded, redacted events with durable event identities. |
| POST /v1/sessions/:sessionId/runs/:runId/actions | Reserve an immutable exact descriptor for a mutating action. |
| POST /v1/sessions/:sessionId/runs/:runId/actions/:actionId | Advance the exact hash through approval/rejection, one-use consumption and completion. |
| POST /v1/sessions/:sessionId/runs/:runId/finish | Complete or fail a run; unresolved actions prevent successful completion. |
| POST /v1/sessions/:sessionId/stop | Fence host execution. Native cleanup can bind the call to its exact run/lease. |
| POST /v1/sessions/:sessionId/decisions | Save an inactive decision or explicitly replace one according to owner/author permissions. |

The service locks actor/session authority in the same transaction as the operation. One database advisory-lock owner and a fresh service epoch fence old leases. Leases last **30 seconds**; the native coordinator heartbeats every **8 seconds** and checks authority at provider turns/tool boundaries.

Run context returns the exact selectedInstruction (id, authorId, text), bounded attributed discussion/applied history and current decisions. Unselected pending instructions are excluded. The selected entry is claimed once. Several authors with pending directions require an explicit owner resolution saved as a decision; no automatic winner or timeout answer is chosen. Current decisions are not silently omitted when their bound is exceeded.

## Plan and exact review

Plan is the default. A Plan run may use controlled list/read/search tools; service and native gates deny writes, shell and external effects. Only the original host explicitly switches an inactive session to Build.

Every mutating descriptor binds its request/session/owner/device, account/session/runtime generations, connection/payer, workspace resource, canonical cwd, exact executable/argv or file hashes, expiry and deterministic SHA-256 fingerprint. The first action pins the run's canonical workspace. Changed, stale, expired, consumed, rejected or canceled requests cannot reuse approval.

The original host receives exact native command or complete write-content review. This coordinator limits complete write previews to **16,000 characters**. POSIX commands have exact canonical executable/argv, bounded output/deadlines, a minimal environment and process-tree cancellation; no login profile or provider credentials are inherited. Windows shell dispatch is unavailable.

Approval is **not an OS sandbox**: an approved process retains the host OS user's access. Shared action events contain hashes/kinds/status summaries. A participant event or leadership change does not grant approval authority.

## Effects and recovery

The private SQLite journal independently prepares/approves/consumes the same action, saves completed outcomes and retains an ordered outbound queue. Exact completed retries return the saved outcome. Interrupted executing calls become **uncertain** and cannot automatically run again. Invalidation cancels pending/approved authority while retaining rejection history. The journal has private file permissions but is not encrypted and must not contain provider credentials.

Stop, sign-out, account/connection changes, sleep, failed heartbeat/network and Quit abort owned work and fence late callbacks. Service restart makes interrupted runs uncertain and pauses sessions with an advanced generation. Safety transitions still commit at retained-content capacity. A complete human reconciliation interface remains follow-up work; Resume cannot replay an old uncertain side effect.

Confirmed shared deletion removes conversation/grants and retains minimal reconciliation tombstones; project/source bytes are preserved. Central deletion and private cleanup remain distinct outcomes.

The coordinator currently prepares one deterministic private **blank workspace** per account/service/device/session, including first-send preparation. Registered-project Git worktrees, dirty baselines and ordinary-folder snapshots are not implemented. See [status](../../docs/backend-status.md), [runtime safety](../../packages/runtime/README.md) and [verification](../../docs/verification.md).
