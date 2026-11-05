# MultAI measurements and comparison

## Local control benchmark — 5 November 2026

The [raw report](results/control-2026-11-05.json) contains every measured latency,
nearest-rank percentiles, case counts, machine information, the production source
commit and SHA-256 hashes of the measured sources and runner. This is one local
component run on an Apple M5, macOS Darwin 27.0.0, arm64, Node 24.22.0. It uses the
actual runtime, workspace, companion-signing and service-verification functions.
Production sources were unchanged from `fd526dee4d188e6d9f8afd669a7e9929e996ce96`.

### Results

| Operation | Measured samples | Median | p95 |
|---|---:|---:|---:|
| Minimal durable atomic file write, without approval checks | 100 | 7.69 ms | 8.92 ms |
| Prepare, approve and complete a durable write through MultAI | 100 | 10.65 ms | 13.30 ms |
| Replay a completed write's result without replacing its file | 100 | 0.25 ms | 0.39 ms |
| Sign an owner-control request, validate it at the service, verify it again at the host | 100 | 0.14 ms | 0.17 ms |
| Reopen SQLite and refuse an unfinished reserved action | 30 | 0.40 ms | 0.63 ms |

In this fixture, the approved write path's median was **about 3 ms above** the
minimal durable-write baseline. This is a difference between observed medians,
not a comparison with another product or a whole-agent latency measurement.

| Fixed-case check | Observed outcome |
|---|---:|
| Approved writes had the expected bytes and a completed journal entry | 100/100 |
| Completed-result replay preserved the file's inode and nanosecond modification time | 100/100 |
| Writes attempted before approval were refused; their target files remained absent | 100/100 |
| Collaborator attempts to approve were refused | 100/100 |
| File contents changed after approval were refused; their target files remained absent | 100/100 |
| Unfinished reservations remained uncertain and could not dispatch after reopen | 30/30 |
| Valid signed requests were accepted by both service and host verifiers | 100/100 |
| Mutated signed requests were rejected by both verifiers | 100/100 |

These are repetitions of defined cases, not a count of distinct vulnerabilities
or an estimate of failure rates in arbitrary real-world traffic.

### Reproduce

From the repository root, with Node 24:

```sh
npm ci --ignore-scripts
npm run --silent bench:control > /tmp/multai-control-results.json
```

The [runner](control.mjs) creates private disposable folders and SQLite journals,
then removes them. It never reads a user's app profile or credentials, calls a
model, contacts the hosted service, or starts another product. A failed assertion
exits nonzero before a complete report is printed. Latencies will vary by
machine, filesystem and background activity.

### Protocol

- **File fixture:** a new 16,384-byte UTF-8 source file for each observation. Both
  paths write a temporary file, sync it and atomically rename it; on POSIX both
  also sync the parent directory. The baseline omits workspace, authority and
  execution-journal checks. MultAI uses its real `ControlledWorkspace.write`
  with a file-backed `ExecutionJournal` (`journal_mode=DELETE`,
  `synchronous=FULL`). There are 10 warm-up pairs followed by 100 measured pairs,
  alternating which path runs first. Setup and output-content assertions are
  outside valid-write timing. Approval is an immediate programmatic fixture;
  it does not measure a person's decision time.
- **Replay:** repeats the exact completed action and checks its returned hash,
  inode and modification time. This measures reuse of a recorded result.
- **Refusals:** 100 repetitions each of missing approval, a non-owner approval
  and changed file contents. Refusal checks are outside valid-path timing.
- **Recovery:** 30 different sessions reserve an action, close SQLite without a
  completion and reopen the journal. Each timed observation includes journal
  construction and refusal to dispatch that uncertain action. This simulates
  an unfinished reservation across reopen; it is not a process-kill, power-loss
  or real agent-recovery experiment. It has no warm-up phase and the journal
  grows across observations.
- **Phone protocol:** one generated, non-extractable P-256 signing key; 10
  warm-ups, then 100 measured sign → service schema validation/signature check
  → host signature check cycles. Key generation is outside timing. The actual
  service's Node verifier and companion/host WebCrypto verifier run in this one
  Node process. Negative cases change one of five schema-valid fields without
  re-signing: generation, session, action identity, action fingerprint or kind,
  20 cases each. They run outside valid-signature timing.
- **Statistics:** nearest-rank p50/p95 over the stated samples, with raw
  observations retained. Warm-ups still have correctness assertions; they are
  excluded from reported valid-write, replay and signature samples. No latency
  threshold is used to select a successful run.

### Effectiveness evidence and limits

The local measurements show bounded control overhead and the behavior of the
specified authority/replay cases. They do **not** measure coding-task quality,
browser-to-desktop network latency, human catch-up time, multi-user productivity,
SAM detection accuracy, parallel-agent speedup, or performance against Codex,
Claude Code or T3 Code.

Separate [3 November live acceptance](../docs/verification/release-2026-11-03.md)
recorded one Muse Wonder checkout task recovering from a failed command and
passing four actual Node tests, and one Wonder → Spark handoff that preserved
10 earlier steps. Those are dated, single-scenario observations with host review
and follow-up instructions, not a no-human-help coding benchmark or a general
success rate. The [proposed ten-task suite](tasks.md) has not been executed as
a comparative benchmark.

## Comparison with coding-agent products

Documentation reviewed **5 November 2026**. This compares documented workflows,
not measured product effectiveness. Availability can depend on versions,
subscriptions, settings and deployment. Other products were not run in the
component benchmark, and an omitted capability must not be read as unsupported.

| Product | Documented approach |
|---|---|
| **MultAI** | A host-local coding runtime with worktrees and approvals, model connections and parallel agents. Its collaboration workflow adds admitted participants with distinct roles, attributed directions, catch-up briefs, host-reviewed conflicting requests, browser reviewers and paired phone control. [Workflow](../README.md#what-happens-in-a-session), [team permissions](../docs/team-review.md), [phone controls](../docs/mobile-companion.md). |
| **Codex** | Engineering work on a connected host, with worktrees, steering and queued prompts, code review and remote approval decisions through ChatGPT mobile. [Official OpenAI documentation](https://developers.openai.com/blog/mastering-codex-remote-for-engineering). |
| **Claude Code** | A coding agent across terminal, IDE, desktop and browser. Remote Control connects browser/mobile clients to a local session and synchronizes messages and progress across surfaces. [Overview](https://code.claude.com/docs/en/overview), [Remote Control](https://code.claude.com/docs/en/remote-control). |
| **T3 Code** | A control plane for multiple existing coding-agent providers, with mid-thread model switching, per-thread branches, diff/PR workflows and desktop, web and mobile clients. [Product](https://t3.codes/), [installation and providers](https://github.com/pingdotgg/t3code/blob/main/docs/user/install.md). |

MultAI targets a team working inside one live agent session, with Muse Spark for
execution, Muse Wonder for catch-up/PR drafting and SAM 3.1 for visual grounding.
The current evidence does not establish that it writes better code, finishes
faster or costs less than the products above. Such a claim needs a matched task
set, pinned models/versions, equivalent context and permissions, explicit human
intervention rules, repeated trials, and correctness, time and cost recorded for
every attempt, including failures.
