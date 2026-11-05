# End-to-end task suite (frozen)

Fixed set of real repo tasks for Benchmark §5. No retries, no human help
mid-run. Failures stay in the report. Status: defined 29 Oct 2026, not yet
run end-to-end (needs a live Muse Spark 1.3 connection in the desktop app).

| # | Task | Pass check |
|---|---|---|
| 1 | Add a health endpoint field reporting the desktop protocol version | backend tests pass |
| 2 | Make the sidebar show a relative "last active" label for sessions | desktop tests + visual check |
| 3 | Add a bounded `limit` parameter to the session events replay route | backend tests pass |
| 4 | Fix the composer draft meter to turn warn at 90% of the limit | desktop unit test |
| 5 | Add a migration that indexes shared events by session and sequence | migration + backend tests |
| 6 | Show the inviter's chosen name in the join-request list | desktop + backend tests |
| 7 | Reject a shell approval whose descriptor expired before dispatch | runtime tests pass |
| 8 | Add `/health/ready` reporting of the release identity configuration | backend tests pass |
| 9 | Make Stop cancel a streaming agent reply and fence its late chunks | desktop tests pass |
| 10 | Add a keyboard shortcut to toggle the inspector panel | desktop tests + visual check |
