# Desktop bug fixes and usability audit — 2 November 2026

Source work extends current main without replacing the mobile/companion implementation that arrived in recent commits.

## Changes

- Invitation expiry buttons stay on one line, the description wraps within its column, and long links no longer push Copy outside the dialog. Invitation creation ignores stale responses after closing or switching sessions/accounts.
- Copy uses the trusted native clipboard bridge in the desktop sandbox and reports success only after completion. Browser previews retain the browser Clipboard API. This applies to invitations, codes, replay links, reviewer links, phone pairing and queued messages. Native arguments and sender are checked.
- Invitations arriving before the renderer subscribes are queued until the listener is ready. Release links keep multai:// and development links multai-dev://. Pasted invitation parsing accepts supported browser/native formats and rejects unrelated schemes. Companion paste also accepts complete codes and browser join links.
- The existing browser companion at https://api.multai.si/app/ returned 404 during this audit. It remains a separately pending backend/companion deployment; the desktop does not generate a browser URL that is known unavailable.
- Composer has a separate paperclip picker, removable filename chips and explicit text/source attachments. Up to four UTF-8 files, each at most 12 KB, must fit with the message inside the existing 16,000-character payload. Filenames and contents are included once. Binary/PDF/Word files and credential files are explicitly rejected; there is no implied binary/document parser. Failed sends preserve attachments. Cross-account/session conversions and canceled/replaced attachments cannot revive stale content.
- Delayed sends cannot erase newer edits or another account's drafts; repeated sends are gated, and changing message kind changes retry identity. Assistant caches, saved prompts and work/terminal state are scoped or reset across account changes.
- Model fetch errors offer retry, malformed team storage does not crash the panel, and narrow composer controls retain the selected model. Screenshot-outline errors fall back to manual marking and stale responses cannot apply an old outline.
- Replay and reviewer dialogs distinguish failed loading from an empty list, reject stale responses and gate duplicate actions. Phone polling is sequential, expiry remains live, failed cancellation preserves the pairing offer, and actions report actual results.
- MCP setup starts with name and command. Optional arguments and environment fields are inside a disclosure, retain exact configuration bytes and surface save/test/remove errors.
- Successful agent steps and routine lifecycle/usage/approval bookkeeping are grouped into compact expandable activity summaries. Agent messages, pending approvals, failures and their output, cancellations and conflicts remain visible. Shared events are retained; this is presentation grouping. Shell command results now keep their actual output and exit status.
- Approval validation rejects aborted, expired, duplicate and oversized requests. Account reset clears saved native access grants. Stop/sign-out fences terminal commands still preparing to start. Terminal output preserves UTF-8 across chunks, uses a portable shell fallback and matches output to the confirmed command ID. Work refreshes cannot restore discarded or previous-account work; failed discard cannot report success.

## Verification

The workspace suites passed: backend 100 tests against disposable PostgreSQL, desktop 322 tests (final rerun including compact activity), companion core 6, companion UI 6, runtime 59 — 493 tests in total. Root typechecking and build passed. Native smoke checked actual OS clipboard write/readback with restoration, cold invitation delivery, trusted IPC, sandbox/context isolation, signed-out boundaries and a macOS Keychain round trip. Browser interactions exercised file picking/removal/send failure/navigation, narrow layouts, MCP/phone/replay failure paths and compact activity expansion with pending approval controls still visible.

The first sandboxed desktop run could not open loopback listeners and failed seven tests with EPERM; the subsequent approved executions outside that restriction passed. Optional Chromium tests ran locally with the installed browser; CI environments without that binary explicitly skip them.

## Live Meta acceptance

The owner explicitly authorized use of existing Meta credit. Tests ran through the installed MultAI application's trusted preload/native runtime, using its encrypted Meta connection without extracting keys. Its live catalog offered Muse Wonder 1.0, selected for the test. The installed build for that provider test identified commit ae06bc935c47, so this live acceptance is separate from the rebuilt-source native checks above.

A disposable checkout module/test session reproduced two failures out of four checks (concurrent and repeated same-key requests), while distinct keys and invalid negative amounts passed. Muse Wonder edited the module. The deliberately bounded Low-effort run reached its turn limit before final verification. A follow-up Medium-effort run executed the exact test command and completed with four passes, zero failures and exit code zero. The visible session is titled “QA: Meta Wonder checkout edge cases”. Only the two named fixture files and their exact node test command were approved for this QA; no dependencies were installed or billing settings changed.

Provider-reported cumulative usage was 38,201 tokens for the first run and 3,988 for recovery. Exact billed credit consumption was not independently verified. Raw fixture evidence stays in local temporary files and is not committed. No production project was modified by the model.

This audit is broad regression coverage, not a guarantee that every possible bug has been found. No production database migration or browser companion deployment was performed. Native mobile hardware and remote billing balances were not reverified.
