// SYNTHETIC DEMO FIXTURES. Loaded only when the renderer is built or served with
// `--mode demo`; the UI shows a persistent "Demo data" badge whenever these are in use.
// Nothing here represents a real person, account, project or service response.

import type { Account, Decision, FileChange, Participant, Project, SessionDetail, SessionSummary } from './types';
import { hueFor } from './format';

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

const person = (id: string, name: string) => ({
  id,
  name,
  initials: name.split(' ').map((p) => p[0]).join('').slice(0, 2).toUpperCase(),
  hue: hueFor(id),
});

export const demoAccount: Account = {
  ...person('demo-user-a', 'Demo Host'),
  email: 'host@example.test',
  workspace: 'Personal',
};

const host: Participant = { ...person('demo-user-a', 'Demo Host'), role: 'owner', presence: 'online', isHost: true, isLeader: true };
const sam: Participant = { ...person('demo-user-b', 'Sam Rivera'), role: 'collaborator', presence: 'online', isHost: false, isLeader: false };
const kai: Participant = { ...person('demo-user-c', 'Kai Morgan'), role: 'collaborator', presence: 'idle', isHost: false, isLeader: false };
const lee: Participant = { ...person('demo-user-d', 'Lee Park'), role: 'viewer', presence: 'offline', isHost: false, isLeader: false };

export const demoProjects: Project[] = [
  { id: 'p-checkout', name: 'checkout-service', folderHint: '~/code/checkout-service', expanded: true },
  { id: 'p-docs', name: 'docs-site', folderHint: '~/code/docs-site', expanded: false },
  { id: 'p-empty', name: 'mobile-prototype', folderHint: '~/code/mobile-prototype', expanded: false },
];

export const demoSessions: SessionSummary[] = [
  { id: 's-rate', title: 'Add rate limiting to payment webhooks', projectId: 'p-checkout', status: 'paused', unread: false, pinned: true, archived: false, pendingApprovals: 1, updatedAt: ago(2) },
  { id: 's-retry', title: 'Flaky retry test in ledger sync', projectId: 'p-checkout', status: 'inactive', unread: true, pinned: false, archived: false, pendingApprovals: 0, updatedAt: ago(48) },
  { id: 's-i18n', title: 'Translate onboarding copy', projectId: 'p-docs', status: 'running', unread: false, pinned: false, archived: false, pendingApprovals: 0, updatedAt: ago(9) },
  { id: 's-regex', title: 'Explain this regex', projectId: null, status: 'inactive', unread: false, pinned: false, archived: false, pendingApprovals: 0, updatedAt: ago(60 * 26) },
  { id: 's-sql', title: 'Postgres advisory lock patterns', projectId: null, status: 'inactive', unread: false, pinned: false, archived: false, pendingApprovals: 0, updatedAt: ago(60 * 50) },
  { id: 's-old', title: 'Old spike: websocket fan-out', projectId: null, status: 'inactive', unread: false, pinned: false, archived: true, pendingApprovals: 0, updatedAt: ago(60 * 24 * 9) },
];

export const demoDecisions: Decision[] = [
  { id: 'd1', text: 'Limit by merchant ID, not IP address.', reason: 'Webhooks come from a small pool of provider IPs.', authorId: sam.id, source: 'Team discussion', status: 'current', createdAt: ago(31) },
  { id: 'd2', text: 'Return 429 with a Retry-After header; never drop silently.', authorId: host.id, source: 'Conflict resolution', status: 'current', createdAt: ago(14) },
  { id: 'd0', text: 'Use a fixed 60 requests/minute window.', authorId: kai.id, source: 'Agent instruction', status: 'replaced', createdAt: ago(40) },
];

const changes: FileChange[] = [
  {
    path: 'src/webhooks/rate-limit.ts', status: 'added', additions: 38, deletions: 0,
    hunks: [{
      header: '@@ -0,0 +1,38 @@',
      lines: [
        "import { TokenBucket } from '../lib/token-bucket';",
        '',
        'const buckets = new Map<string, TokenBucket>();',
        '',
        'export function takeToken(merchantId: string, now = Date.now()) {',
        '  let bucket = buckets.get(merchantId);',
        '  if (!bucket) {',
        '    bucket = new TokenBucket({ capacity: 120, refillPerSecond: 2 });',
        '    buckets.set(merchantId, bucket);',
        '  }',
        '  return bucket.take(now);',
        '}',
      ].map((text, i) => ({ kind: 'add' as const, text, newNo: i + 1 })),
    }],
  },
  {
    path: 'src/webhooks/handler.ts', status: 'modified', additions: 9, deletions: 2,
    hunks: [{
      header: '@@ -14,8 +14,15 @@ export async function handleWebhook(req, res) {',
      lines: [
        { kind: 'context', text: '  const event = parseEvent(req.body);', oldNo: 14, newNo: 14 },
        { kind: 'context', text: '  const merchantId = event.account;', oldNo: 15, newNo: 15 },
        { kind: 'del', text: '  await enqueue(event);', oldNo: 16 },
        { kind: 'del', text: '  res.status(200).end();', oldNo: 17 },
        { kind: 'add', text: '  const result = takeToken(merchantId);', newNo: 16 },
        { kind: 'add', text: '  if (!result.ok) {', newNo: 17 },
        { kind: 'add', text: "    res.setHeader('Retry-After', String(result.retryAfterSeconds));", newNo: 18 },
        { kind: 'add', text: '    return res.status(429).end();', newNo: 19 },
        { kind: 'add', text: '  }', newNo: 20 },
        { kind: 'add', text: '  await enqueue(event);', newNo: 21 },
        { kind: 'add', text: '  res.status(200).end();', newNo: 22 },
        { kind: 'context', text: '}', oldNo: 18, newNo: 23 },
      ],
    }],
  },
  {
    path: 'test/webhooks/rate-limit.test.ts', status: 'added', additions: 24, deletions: 0,
    hunks: [{
      header: '@@ -0,0 +1,24 @@',
      lines: [
        "test('returns 429 after the bucket empties', async () => {",
        "  for (let i = 0; i < 120; i++) takeToken('m_1', 0);",
        "  expect(takeToken('m_1', 0)).toEqual({ ok: false, retryAfterSeconds: 1 });",
        '});',
      ].map((text, i) => ({ kind: 'add' as const, text, newNo: i + 1 })),
    }],
  },
];

export function demoSessionDetail(): SessionDetail {
  return {
    id: 's-rate',
    title: 'Add rate limiting to payment webhooks',
    objective: 'Protect the webhook endpoint from bursty retries without dropping legitimate events.',
    mode: 'build',
    status: 'paused',
    role: 'owner',
    capabilities: { submit: true, approve: true, configure: true, decide: true, delete: true },
    hostName: 'Demo Host’s MacBook',
    hostOnline: true,
    baseline: 'main @ 4f2c9a1',
    worktree: 'chat-rate-limit-7c1e',
    model: { id: 'demo-large', label: 'Large model', engine: 'App coding loop', reasoning: ['Low', 'Medium', 'High'] },
    reasoning: 'Medium',
    participants: [host, sam, kai, lee],
    decisions: demoDecisions,
    changes,
    timeline: [
      { id: 't1', sequence: 1, at: ago(52), type: 'system', tone: 'info', text: 'Session started from main @ 4f2c9a1 in a private worktree.' },
      { id: 't2', sequence: 2, at: ago(51), type: 'message', kind: 'instruction', authorId: host.id, text: 'Our payment webhook endpoint gets hammered when the provider retries. Add rate limiting so we return 429 instead of falling over.', queue: 'applied' },
      { id: 't3', sequence: 3, at: ago(50), type: 'tools', calls: [
        { id: 'c1', tool: 'search', summary: 'Searched for “webhook” in src/', status: 'completed', detail: '7 matches in 3 files', durationMs: 120 },
        { id: 'c2', tool: 'read', summary: 'Read src/webhooks/handler.ts', status: 'completed', detail: '64 lines', durationMs: 18 },
        { id: 'c3', tool: 'read', summary: 'Read src/lib/token-bucket.ts', status: 'completed', detail: '41 lines', durationMs: 11 },
      ] },
      { id: 't4', sequence: 4, at: ago(49), type: 'agent', model: 'Large model', streaming: false, text: 'There’s already a **token bucket** in `src/lib/token-bucket.ts`, so I’ll reuse it rather than add a dependency.\n\nTwo open questions before I write anything:\n- Should limits be keyed by **IP** or by **merchant ID**?\n- What should happen to rejected requests: drop, queue, or `429`?' },
      { id: 't5', sequence: 5, at: ago(40), type: 'message', kind: 'instruction', authorId: kai.id, text: 'Just use a fixed 60/minute window per IP, keep it simple.', queue: 'applied' },
      { id: 't6', sequence: 6, at: ago(33), type: 'message', kind: 'discussion', authorId: sam.id, text: 'IP won’t work, the provider sends from like four addresses. Every merchant would share one bucket.' },
      { id: 't7', sequence: 7, at: ago(32), type: 'message', kind: 'discussion', authorId: kai.id, text: 'Oh good point. Merchant ID then 👍' },
      { id: 't8', sequence: 8, at: ago(31), type: 'decision', decisionId: 'd1' },
      { id: 't9', sequence: 9, at: ago(16), type: 'message', kind: 'instruction', authorId: sam.id, text: 'Drop requests over the limit, the provider retries anyway.', queue: 'applied' },
      { id: 't10', sequence: 10, at: ago(15), type: 'conflict', instructionIds: ['t9', 't2'], resolved: true },
      { id: 't11', sequence: 11, at: ago(14), type: 'decision', decisionId: 'd2' },
      { id: 't12', sequence: 12, at: ago(12), type: 'plan', title: 'Rate-limit webhooks', steps: [
        { text: 'Key a token bucket by merchant ID', state: 'done' },
        { text: 'Return 429 + Retry-After from the handler', state: 'done' },
        { text: 'Add tests for the empty-bucket path', state: 'done' },
        { text: 'Run the webhook test suite', state: 'active' },
      ] },
      { id: 't13', sequence: 13, at: ago(10), type: 'tools', calls: [
        { id: 'c4', tool: 'write', summary: 'Created src/webhooks/rate-limit.ts', status: 'completed', detail: '+38', durationMs: 9 },
        { id: 'c5', tool: 'write', summary: 'Edited src/webhooks/handler.ts', status: 'completed', detail: '+9 −2', durationMs: 7 },
        { id: 'c6', tool: 'write', summary: 'Created test/webhooks/rate-limit.test.ts', status: 'completed', detail: '+24', durationMs: 6 },
      ] },
      { id: 't14', sequence: 14, at: ago(3), type: 'agent', model: 'Large model', streaming: false, text: 'The limiter is wired in and keyed by merchant ID, per the current decisions. I’d like to run the webhook tests to confirm the 429 path.' },
      { id: 't15', sequence: 15, at: ago(2), type: 'approval', title: 'Run the webhook test suite', reason: 'Verify the new 429 path and that existing webhook tests still pass.', state: 'pending', descriptor: {
        executable: '/bin/zsh', args: ['-lc', 'npm test -- test/webhooks'], cwd: '~/…/worktrees/chat-rate-limit-7c1e', connection: 'App coding loop · Large model', generation: 3, hash: 'sha256:9f1c…a07e', expiresAt: new Date(Date.now() + 9 * 60_000).toISOString(),
      } },
    ],
  };
}

export const demoPeople = { host, sam, kai, lee };
