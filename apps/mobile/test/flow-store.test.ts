import assert from 'node:assert/strict';
import {test} from 'node:test';
import {nativeFlowKey, nativeFlowStore} from '../src/flow-store.ts';
import type {SecureStore} from '@multai/companion-core';

const key = 'account.pendingFlow';
function fixture() {
  const persisted = new Map<string, string>();
  const secure: SecureStore = {get: async name => persisted.get(name) ?? null, set: async (name, value) => {persisted.set(name, value);}, remove: async name => {persisted.delete(name);}};
  return {persisted, secure};
}

test('PKCE is durable before the Custom Tab opens and restores after process death', async () => {
  const {persisted, secure} = fixture();
  const flows = await nativeFlowStore(secure, [key]);
  flows.set(key, 'private-verifier');
  assert.equal(flows.get(key), 'private-verifier');
  await flows.flush();
  assert.equal(persisted.get(await nativeFlowKey(key)), 'private-verifier');
  const restarted = await nativeFlowStore(secure, [key]);
  assert.equal(restarted.get(key), 'private-verifier');
  restarted.remove(key);
  await restarted.flush();
  assert.equal((await nativeFlowStore(secure, [key])).get(key), null);
});

test('serialized writes cannot resurrect an old flow or erase its replacement', async () => {
  const {secure} = fixture();
  const flows = await nativeFlowStore(secure, [key]);
  flows.set(key, 'first');
  flows.remove(key);
  flows.set(key, 'newer');
  await flows.flush();
  assert.equal((await nativeFlowStore(secure, [key])).get(key), 'newer');
});

test('failed native storage blocks opening a sign-in rather than losing its verifier', async () => {
  const {secure} = fixture();
  const flows = await nativeFlowStore({...secure, set: async () => {throw new Error('Keystore failed');}}, [key]);
  flows.set(key, 'private-verifier');
  await assert.rejects(flows.flush(), /Secure sign-in storage is unavailable/u);
  const unreadable = await nativeFlowStore({...secure, get: async () => {throw new Error('Keystore failed');}}, [key]);
  assert.equal(unreadable.get(key), null);
  await assert.rejects(unreadable.flush(), /Secure sign-in storage is unavailable/u);
});

test('origin-separated names fit native key limits and unsupported storage writes are rejected', async () => {
  const first = await nativeFlowKey('companion.joinIntent.v1:https://api.multai.si');
  const second = await nativeFlowKey('companion.joinIntent.v1:http://localhost:4319');
  assert.notEqual(first, second);
  assert.match(first, /^[a-zA-Z0-9._-]{1,64}$/u);
  const flows = await nativeFlowStore(fixture().secure, [key]);
  assert.throws(() => flows.set('other', 'value'), /Unsupported/u);
});
