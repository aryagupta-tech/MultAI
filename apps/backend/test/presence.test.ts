import assert from 'node:assert/strict';
import {test} from 'node:test';
import {PresenceHub, type PresenceEntry} from '../src/presence.js';

test('presence merges devices, limits update rate and lets typing expire', () => {
  let now = 1_000_000;
  const hub = new PresenceHub(() => now);
  const received: PresenceEntry[][] = [];
  const send = (message: {participants: PresenceEntry[]}) => {received.push(message.participants);};
  const laptop = {}, phone = {}, other = {};
  const leaveLaptop = hub.join('s', laptop, 'ana', send);
  hub.join('s', phone, 'ana', () => undefined);
  hub.join('s', other, 'ben', () => undefined);
  assert.deepEqual(hub.snapshot('s').map(entry => entry.userId), ['ana', 'ben']);
  assert.equal(hub.update('s', phone, {typing: true, viewing: 'cart.js'}), true);
  assert.deepEqual(hub.snapshot('s')[0], {userId: 'ana', typing: true, viewing: 'cart.js'});
  for (let i = 0; i < 3; i++) hub.update('s', phone, {typing: true, viewing: 'cart.js'});
  assert.equal(hub.update('s', phone, {typing: true, viewing: 'x'}), false);
  now += 7_000;
  assert.equal(hub.snapshot('s')[0]!.typing, false);
  leaveLaptop();
  assert.deepEqual(hub.snapshot('s').map(entry => entry.userId), ['ana', 'ben']);
  assert.ok(received.length >= 2);
  assert.equal(hub.snapshot('none').length, 0);
});
