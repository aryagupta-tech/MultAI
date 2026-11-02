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

test('typing expiry is broadcast while another participant continues typing', t => {
  t.mock.timers.enable({apis: ['setTimeout', 'Date'], now: 1_000_000});
  const hub = new PresenceHub();
  const received: PresenceEntry[][] = [];
  const ana = {}, ben = {};
  const leaveAna = hub.join('s', ana, 'ana', message => received.push(message.participants));
  const leaveBen = hub.join('s', ben, 'ben', () => undefined);
  t.after(() => {leaveAna(); leaveBen();});
  hub.update('s', ana, {typing: true, viewing: null});
  t.mock.timers.tick(4_000);
  hub.update('s', ben, {typing: true, viewing: null});
  t.mock.timers.tick(2_010);
  hub.update('s', ben, {typing: true, viewing: null});
  t.mock.timers.tick(90);
  assert.deepEqual(received.at(-1)?.map(entry => [entry.userId, entry.typing]), [['ana', false], ['ben', true]]);
  t.mock.timers.tick(6_000);
  assert.deepEqual(received.at(-1)?.map(entry => [entry.userId, entry.typing]), [['ana', false], ['ben', false]]);
});

test('viewed file follows the latest device change, regardless of connection order', () => {
  const hub = new PresenceHub();
  const laptop = {}, phone = {};
  const leaveLaptop = hub.join('s', laptop, 'ana', () => undefined);
  const leavePhone = hub.join('s', phone, 'ana', () => undefined);
  hub.update('s', phone, {typing: false, viewing: 'old.js'});
  hub.update('s', laptop, {typing: false, viewing: 'new.js'});
  assert.equal(hub.snapshot('s')[0]?.viewing, 'new.js');
  // A heartbeat from the older view must not steal the file indicator back.
  hub.update('s', phone, {typing: false, viewing: 'old.js'});
  assert.equal(hub.snapshot('s')[0]?.viewing, 'new.js');
  hub.update('s', laptop, {typing: false, viewing: null});
  assert.equal(hub.snapshot('s')[0]?.viewing, 'old.js');
  leavePhone();
  assert.equal(hub.snapshot('s')[0]?.viewing, null);
  leaveLaptop();
});
