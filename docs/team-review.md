# Team requirements, verification and browser review

These features extend the existing host-local session. They do not grant a guest access to the host's shell, files, model credentials or command approvals. Deploy the current backend and apply migrations 008 and 009 before using the new desktop build against it.

## Agree and verify

Open the **Verification** inspector tab in a live session. Any admitted collaborator can propose a required behavior and an optional check command. The original host approves the requirement. Revising it increments its version and requires approval again; only the host can revise or withdraw it. Browser guests can propose requirements after admission.

**Run checks and reviewer** needs Build mode, a selected model, 1–20 approved requirements and an empty instruction queue. It starts a separate host run. The runtime executes the exact commands stored in the approved requirements, through the existing approval broker and effect journal. The model cannot substitute or weaken those commands. A separate model context then inspects coverage using read-only source tools; it does not inherit the builder's conversation or gain write, shell, MCP or steering tools. If the model review fails while the host lease remains valid, actual completed command results are retained and the missing review is disclosed.

The service records the source fingerprint, requirement version, exact command, exit code and bounded output. A zero exit code means **Check passed**, not that the whole requirement is proven. Missing commands require human review. Failed, interrupted, rejected, source-changing and uncompleted checks cannot create a passing result. Source changes during a check or later in that verification pass discard the affected result. Human acceptance/rejection is a separate, attributed record bound to that exact evidence; accepting behavior never turns a failed check green. **Ask agent to repair** queues the failing requirement and starts the ordinary approved builder workflow; rerun verification afterward.

The server receives host-reported process evidence; it does not independently execute or attest the host's commands. Check output is shared with admitted native participants and browser reviewers. Runtime redaction and bounded output still apply.

## Freshness

The revision hashes source bytes, relative names and executable bits, including tracked deletions and untracked, nonignored files. Dependency/generated folders, ignored files and protected secrets are excluded. It is a source fingerprint, not an operating-system, dependency or external-service snapshot. A command can depend on environmental conditions that this fingerprint does not capture.

Fingerprinting fails closed for source symlinks, special files, concurrent changes or size limits (20,000 files, 16 MiB per file, 128 MiB total). The host rechecks the revision while the Verification tab is open, and keeps a bounded background monitor for recently verified sessions (once per minute while idle). External edits are detected on those checks, not by an instantaneous filesystem transaction. Source-changing runs and native undo/revert/discard/terminal actions invalidate evidence first. A source scan failure leaves it stale. The browser shows the last source revision confirmed by the host; it cannot inspect an offline computer.

Requirement edits and saved host decisions also invalidate earlier evidence. Host conflict resolutions bump approved requirement versions, so synchronizing the same source bytes cannot revive evidence from the old decisions.

## Browser review

In **People → Browser reviewers**, create a one-day invitation and share its link. The visitor chooses a name; the host explicitly admits them. Names are self-chosen, so admit a person you recognize. Guests can read a limited timeline and catch-up briefs, comment, propose requirements, and accept or reject current evidence. Their comments reach builder and catch-up context as attributed feedback, never as queued instructions.

Screenshots are shared separately with a visible host action. Admitted guests can drag a rectangle and attach a comment. The desktop shows that feedback and can display the marked screenshot. Removing the screenshot prevents future retrieval; it cannot retract an image someone already viewed or saved.

Reviewer credentials are scoped to one session, held only in browser memory, hashed in the database, and never usable as native accounts. Invitations are in URL fragments rather than request URLs. Every operation revalidates expiry, invitation revocation, admission and session deletion. Same-origin requests, strict inputs and a restrictive content security policy protect the served page. Public watch links remain read-only and grant no reviewer permissions.

Leaving clears the guest credential; refreshing requires a new admission. Network errors hide private content until a successful refresh, and late responses cannot restore it after leaving or revocation. Revoking an invitation fences all reviewers admitted through it. Session deletion removes review content and receipts along with other collaboration data.

The browser layout supports phone-sized screens. This is not an Android APK, iOS native app, TestFlight release or remote owner-control feature. The owner's future distribution preference is a browser link for iOS and a signed Android APK, without a paid Apple Developer membership.

## Host conflict decisions

When different participants have pending directions, the agent waits for the original host. The dialog shows each attributed direction and, for interrupted cross-author steering, the prior run's direction. **Ask agent to compare** explicitly runs an optional model comparison and displays possible contradictions and suggested resolutions. Multiple authors alone are not asserted to be a contradiction, and model advice never grants authority.

The host chooses a participant's direction, edits a suggested combination or writes a resolution. Saving replaces the entire displayed pending queue with the host's decision. Other reviewed directions are removed rather than accidentally executed afterward. An immutable queue fingerprint rejects decisions if messages change, are removed or are steered while the dialog is open. A different participant steering an active run stops it for host review; restarting cannot bypass that review simply because only one pending author remains.

## Suggested demonstration

Use a real small project with a reproducible failing behavior. Agree on one precise automated check and one manual requirement, admit a browser reviewer, and share a screenshot deliberately. Run verification and show the actual failure. Ask the builder to repair it, rerun the same locked check, then let the reviewer accept or request changes. Show one conflicting pair of directions and the host's recorded resolution. Keep the video explicit about real execution, edited waiting time and any synthetic fixture used.
