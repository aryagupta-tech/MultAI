import { describe, expect, test } from 'vitest';
import type { WireEvent, WireMe, WireSession } from '../bridge/wire';
import { mergeEvents, personFor, projectSession, sessionTitle, titleFromMessage } from './projection';

const me: WireMe = { id: '11111111-1111-4111-8111-111111111111', displayName: 'Ada Lovelace', workspaceId: '22222222-2222-4222-8222-222222222222', deviceId: '33333333-3333-4333-8333-333333333333' };
const other = 'abcdef12-0000-4000-8000-000000000000';

const session = (over: Partial<WireSession> = {}): WireSession => ({
  id: '44444444-4444-4444-8444-444444444444', workspaceId: me.workspaceId, ownerId: me.id, title: null, mode: 'plan', status: 'inactive',
  runtimeGeneration: 3, lastSequence: 3, role: 'owner', createdAt: '2026-10-29T00:00:00.000Z', updatedAt: '2026-10-29T00:05:00.000Z',
  capabilities: { submit: true, manage: true, execute: false }, ...over,
});

const ev = (sequence: number, type: string, actorId: string | null, payload: unknown): WireEvent => ({
  id: `e${sequence}`, sessionId: session().id, sequence, type, actorId, payload, createdAt: `2026-10-29T00:0${sequence}:00.000Z`,
});

describe('projectSession', () => {
  const events = [
    ev(1, 'session.created', me.id, { mode: 'plan', inferenceEnabled: false }),
    ev(2, 'message.instruction', me.id, { messageId: 'm1', text: 'Add rate limiting', queueStatus: 'pending' }),
    ev(3, 'message.discussion', other, { messageId: 'm2', text: 'Key it by merchant' }),
    ev(4, 'participant.admitted', me.id, { userId: other, role: 'collaborator' }),
    ev(5, 'something.new', me.id, {}),
  ];
  const d = projectSession({ session: session(), participants: [{ userId: me.id, role: 'owner', admittedAt: '' }, { userId: other, role: 'collaborator', admittedAt: '' }], events, me });

  test('maps messages with authors, kinds and queue state', () => {
    const msgs = d.timeline.filter((t) => t.type === 'message');
    expect(msgs).toHaveLength(2);
    expect(msgs[0]).toMatchObject({ kind: 'instruction', authorId: me.id, text: 'Add rate limiting', queue: 'pending' });
    expect(msgs[1]).toMatchObject({ kind: 'discussion', authorId: other });
  });

  test('turns lifecycle events into readable system lines and skips unknown types', () => {
    const systems = d.timeline.filter((t) => t.type === 'system').map((t) => t.type === 'system' && t.text);
    expect(systems).toEqual(['You started this session in Plan mode.', 'Teammate ABCD joined as collaborator.']);
    expect(d.timeline.map((t) => t.sequence)).toEqual([1, 2, 3, 4]);
  });

  test('derives capabilities from the service, never more', () => {
    expect(d.capabilities).toEqual({ submit: true, approve: true, configure: true, decide: false, delete: true });
    const viewer = projectSession({ session: session({ role: 'viewer', ownerId: other, capabilities: { submit: false, manage: false, execute: false } }), participants: [], events: [], me });
    expect(viewer.capabilities).toEqual({ submit: false, approve: false, configure: false, decide: false, delete: false });
    expect(viewer.hostName).toBe('Teammate ABCD’s computer');
  });

  test('titles come from the service, then the first message', () => {
    expect(d.title).toBe('Add rate limiting');
    expect(sessionTitle(session({ title: 'Named' }))).toBe('Named');
    expect(sessionTitle(session())).toBe('Untitled session');
    expect(titleFromMessage('  first line\nsecond')).toBe('first line');
  });

  test('never invents names for other people', () => {
    expect(personFor(me.id, me).name).toBe('Ada Lovelace');
    expect(personFor(me.id, me).initials).toBe('AL');
    expect(personFor(other, me).name).toBe('Teammate ABCD');
  });
});

describe('mergeEvents', () => {
  test('appends in order, deduplicates by sequence, and sorts out-of-order batches', () => {
    const a = [ev(1, 'x', null, {}), ev(2, 'x', null, {})];
    expect(mergeEvents(a, [ev(3, 'x', null, {})]).map((e) => e.sequence)).toEqual([1, 2, 3]);
    expect(mergeEvents(a, [ev(2, 'x', null, {}), ev(4, 'x', null, {}), ev(3, 'x', null, {})]).map((e) => e.sequence)).toEqual([1, 2, 3, 4]);
    expect(mergeEvents(a, [])).toBe(a);
  });
});
