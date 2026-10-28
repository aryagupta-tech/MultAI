# Backend implementation guidance

Read the root README, docs/MultAI.md, and docs/backend-status.md before expanding scope. Implement fresh source; do not restore historical source, resources, credentials or deployment configuration.

Keep changes for this backend task on the backend branch. When another task shares a checkout, use an isolated worktree and stage only the intended source files. Do not commit another task's frontend changes.

The collaboration service must never access host project files or execute shell/provider tools. Every protected operation must revalidate the actor inside the same transaction as its permission check and mutation. Serialize shared events and membership changes on the session row. Bind retries to immutable fingerprints; deletion/revocation must fence old retries.

No production authentication bypass, raw secret logging, client-supplied OAuth callback or automatic inference on configuration/save. Treat native desktop authority and the collaboration identity as independent boundaries. Keep unsupported execution visibly disabled.

Validate significant invariant changes using real PostgreSQL with `npm run test:integration`, and run `npm run typecheck` and `npm run build`. Report synthetic and live acceptance separately. Preserve migration bytes once applied; add a new migration for subsequent changes.
