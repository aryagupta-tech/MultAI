# Collaboration API foundation

All routes require an opaque `Authorization: Bearer <accessToken>` header. A
Google identity is separate from inference authorization. This milestone cannot
start an engine, run shell commands, open a host file, or authorize a tool.

## Session and conversation routes

| Method and path | Request | Result |
| --- | --- | --- |
| `POST /v1/sessions` | `{requestId, title?, message:{kind,text}}` | `{session,event}`; creates one inactive Plan session and first attributed message |
| `GET /v1/sessions` | Query `after?` (session UUID), `limit?` (1–100) | `{sessions,cursor}` for active memberships |
| `GET /v1/sessions/:sessionId` | — | `{session,participants}` |
| `POST /v1/sessions/:sessionId/messages` | `{requestId,kind,text}` | `{event}` |
| `GET /v1/sessions/:sessionId/events` | Query `after?` (sequence, default 0), `limit?` (1–100) | `{events,cursor}` in ascending sequence |
| `GET /v1/sessions/:sessionId/live` | Query `after?` | Authenticated WebSocket; see the main backend README for stream framing |
| `PATCH /v1/sessions/:sessionId/mode` | `{mode,expectedGeneration}` | `{session}`; original owner/device, inactive only |

`requestId` is a client-generated UUID, retained with the unsent draft and reused
for an exact retry. Concurrent retries return the same saved response. Reusing an
identity for another operation, session, host, or normalized content returns
`409 idempotency_conflict`. Authentication and current membership are rechecked
before returning an old response. A retry cannot recreate a deleted session.

`kind` is `discussion` or `instruction`. Discussion creates conversation only.
Instructions also create attributed pending queue entries; dispatch, conflict
resolution, queue editing and provider inference remain unimplemented. Creating
the central session does not create a local worktree in this milestone.

Events have `{id,sessionId,sequence,type,actorId,payload,createdAt}`. Clients persist
their last received sequence and request only events after it. They deduplicate by
session and sequence, including after reconnect. A cursor ahead of the session
returns `409 cursor_ahead`. Session and event timestamps are UTC ISO strings.

## Invitation and membership routes

| Method and path | Request | Result |
| --- | --- | --- |
| `POST /v1/sessions/:sessionId/invitations` | `{expiresInSeconds?}` (60–86400; default 3600) | `{invitation:{id,sessionId,token,expiresAt}}` |
| `DELETE /v1/sessions/:sessionId/invitations/:invitationId` | — | `{revoked:true}` |
| `POST /v1/invitations/join` | `{token}` | Pending `{requestId,sessionId,status}` or already admitted `{sessionId,status}` |
| `GET /v1/sessions/:sessionId/join-requests` | — | Owner-private `{requests:[{id,userId,createdAt}]}` |
| `POST /v1/sessions/:sessionId/join-requests/:requestId/admit` | `{role:"collaborator"\|"viewer"}` | `{admitted:true,userId,role}` |
| `DELETE /v1/sessions/:sessionId/participants/:userId` | — | `{revoked:true}` |

Invitation creation, revocation, admission and participant revocation require the
original owner on the original registered host. An invitation token creates a
pending request; it grants no conversation access. Tokens are random, expire,
are stored only as SHA-256 hashes, and appear neither in events nor snapshots.
Place the token in the join request body, not in a logged URL.

An admitted viewer can read but cannot submit messages or instructions. An
admitted collaborator can submit both. Revocation and message creation serialize
on the session row; a revoked participant loses HTTP and replay access. Old
pending/admitted requests are invalidated on participant revocation. Re-admission
requires a fresh invitation request and a new explicit owner admission. The
original owner role and executing-device association cannot be reassigned here.

## Permanent deletion

`POST /v1/sessions/:sessionId/deletion-challenge` returns
`{sessionId,confirmationToken,expiresInSeconds:60}` after checking the original
owner/device and inactivity. A distinct confirmation UI should name this exact
session. On explicit confirmation, send
`DELETE /v1/sessions/:sessionId` with `{confirmationToken}`. Mode/generation
changes, expiry, another session, another device and an old token invalidate the
confirmation. A canceled UI must not call DELETE.

Deletion removes events, pending instructions, invitation/admission records,
membership grants and stored retry response contents. It leaves a minimal
session tombstone, prior request fingerprints and former-reader IDs so offline
clients receive `410 session_deleted` and discard cached conversation content.
Other users receive `404`. Local runtime cleanup is a separate future integration;
this API does not touch project source or worktree bytes. Backup retention and
automatic tombstone retention are not defined by this development milestone.

## Bounds and unavailable features

Messages are limited to 16000 UTF-16 code units; titles to 120; unsupported control
characters and unknown body fields are rejected. Each session supports at most
100 active participants, 100 active invitations, 1000 admission requests and 512
pending instructions. Ordinary event writes stop at sequence 99744; 256 further
sequence slots are reserved so existing participant/invitation grants can still
be revoked at capacity. A session row lock covers authority checks, mutations and
event allocation within a PostgreSQL transaction.

There is no shared file-edit authority, provider connection, tool dispatch,
runtime lease, leadership transfer, decisions API, goal, schedule, project-folder
mapping, or source mirroring yet. `session.capabilities.execute` is always false,
including after an explicit switch to Build. `manage` is true only for the
original owner on the original registered host; do not treat a UI capability flag
as an authorization boundary.
