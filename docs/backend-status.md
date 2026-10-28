# Backend milestone · 29 October 2026

The repository began at empty commit `d8d6f36`. All backend source, schema and tests in this milestone were written independently from the preserved product requirements. Development identity: `0.0.0-dev.1`, desktop client `multai-desktop-development`, callback scheme `multai-dev`. These identities make no production registration or publication claim.

| Requirement | Evidence in this milestone | Remaining work |
| --- | --- | --- |
| Identity and personal workspace | Google signature/issuer/audience/expiry/nonce checks; PKCE and fixed flow bindings; hashed one-use/rotating credentials; device proof and revocation; synthetic signed-token tests | New Google credentials, live consent/browser callback acceptance, native secure storage/protocol registration |
| Ordered collaboration | PostgreSQL transactions, session-row locks, monotonic events, concurrent retry tests, actual WebSocket replay and revocation tests | Desktop projections, two native clients and live acceptance |
| Membership and permissions | Pending invitation admission; viewer denial; original owner/device controls; revoked access fenced | Explicit leadership policy, team workspaces and sharing UI |
| Durable first send | Idempotent session plus first message in one transaction | Private worktree creation and durable retry association on the host |
| Shared direction | Distinct discussion and attributed pending instruction queue | Queue edits/claims, safe-boundary delivery, decisions, conflict resolution, structured questions/plans |
| Plan and approval policy | Plan-default session; original-host mode changes; independent local exact-action policy and SQLite dispatch journal | Central action reservations, trusted IPC/worker integration, actual command cancellation and all native authority tests |
| Recovery and deletion | Journal reopen cancels approvals and marks executing calls uncertain; ordered outbox; generation-bound confirmed shared deletion and tombstones | Worker/process recovery, private local cleanup reconciliation, reviewed retention and backup policy |
| Fresh provenance | Exact dependency lock, source/build manifest, new schema/checksums, no old service resources | Public license decision, native artifact manifest and release acceptance |

The service has no provider connection, inference grant, shell dispatch, project-file endpoint or running executor. The `execute` capability is always false. A Build session does not grant execution through this API. The journal is an independently testable library, not a connected native worker.

Database migrations cover only implemented entities; optional goals, schedules, provider secrets, rendered documents and project mappings are deliberately absent until their behaviors and privacy boundaries exist. The pending queue cannot currently be consumed, so cross-author conflicts cannot silently execute.

Next backend work should connect durable host workspace creation to first-send retry identity, add a centrally validated one-executor lease/action reservation protocol, integrate the local journal and lifecycle fencing, then implement decisions/conflict resolution before enabling one reviewed inference engine. Preserve original dirty checkouts throughout. Desktop, Google, native runtime and multi-platform acceptance must be recorded independently of these tests.

No cloud resources were provisioned and no external infrastructure or historical profiles were reused. The development/test PostgreSQL image and npm dependency versions are pinned. The runtime SQLite journal is private-permission storage; it is **not encrypted**, and must not contain provider credentials. Production retention, capacity policy, backup restoration and rate-limit/proxy configuration remain release prerequisites.
