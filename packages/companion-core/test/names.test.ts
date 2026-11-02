import assert from 'node:assert/strict';
import {test} from 'node:test';
import {personLabel, projectTimeline} from '../src/index.js';

const me = {id: '11111111-1111-4111-8111-111111111111', displayName: 'Ada'};
const owner = '22222222-2222-4222-8222-222222222222';
const guest = 'abcdef12-0000-4000-8000-000000000000';

test('people show the name they gave, the host is marked, and unknown people keep a generic label', () => {
  const names = new Map([[owner, 'Arya Gupta'], [guest, 'Sam Lee']]);
  assert.equal(personLabel(me.id, me, owner, names), 'You');
  assert.equal(personLabel(owner, me, owner, names), 'Arya Gupta (host)');
  assert.equal(personLabel(guest, me, owner, names), 'Sam Lee');
  assert.equal(personLabel(owner, me, owner), 'Host');
  assert.equal(personLabel(guest, me, owner), 'Teammate ABCD');
  assert.equal(personLabel(guest, me, owner, new Map([[guest, '   ']])), 'Teammate ABCD');
});

test('someone leaving shows as a timeline line with their name', () => {
  const names = new Map([[guest, 'Sam Lee']]);
  const items = projectTimeline([{id: 'e1', sessionId: 's', sequence: 1, actorId: guest, type: 'participant.left', payload: {userId: guest}, createdAt: '2030-01-01T00:00:00.000Z'}] as never, id => personLabel(id, me, owner, names));
  assert.equal(items.length, 1);
  assert.equal((items[0] as {text: string}).text, 'Sam Lee left the session.');
});
