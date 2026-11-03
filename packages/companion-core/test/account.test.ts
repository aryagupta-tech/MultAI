import assert from 'node:assert/strict';
import {test} from 'node:test';
import {Account, ApiClient, type PlainStore, type SecureStore} from '../src/index.js';

const token = (c: string) => c.repeat(43);
const flowId = '33333333-3333-4333-8333-333333333333';

test('signing in as a different account on the same phone enrolls the phone anew', async () => {
  const secure = new Map<string, string>([['account.deviceId', '44444444-4444-4444-8444-444444444444'], ['account.deviceSecret', token('s')]]);
  const store: SecureStore = {get: async key => secure.get(key) ?? null, set: async (key, value) => {secure.set(key, value);}, remove: async key => {secure.delete(key);}};
  const flows = new Map<string, string>([['account.pendingFlow', JSON.stringify({flowId, verifier: 'v', expiresAt: Date.now() + 60_000})]]);
  const plain: PlainStore = {get: key => flows.get(key) ?? null, set: (key, value) => {flows.set(key, value);}, remove: key => {flows.delete(key);}};
  const exchanges: Record<string, unknown>[] = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === '/v1/auth/google/exchange') {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      exchanges.push(body);
      if (body.deviceId) return new Response(JSON.stringify({error: {code: 'device_account_mismatch', message: 'The verified account needs its own device enrollment.'}}), {status: 401});
      return new Response(JSON.stringify({accessToken: token('a'), expiresIn: 600, deviceId: '55555555-5555-4555-8555-555555555555', refreshToken: token('r'), deviceSecret: token('n')}));
    }
    if (path === '/v1/me') return new Response(JSON.stringify({id: '66666666-6666-4666-8666-666666666666', displayName: 'Owner', workspaceId: '77777777-7777-4777-8777-777777777777', deviceId: '55555555-5555-4555-8555-555555555555'}));
    return new Response('{}', {status: 404});
  }) as typeof globalThis.fetch;
  const account = new Account(new ApiClient({origin: 'https://api.multai.si', mode: 'app', fetch}), {secure: store, flows: plain, deviceName: () => 'Phone', openSignIn: async () => undefined});

  const state = await account.completeSignIn(`signin=${flowId}.${token('c')}`);
  assert.equal(state.status, 'signed-in');
  assert.equal(exchanges.length, 2);
  assert.ok(exchanges[0]!.deviceId && !exchanges[1]!.deviceId);
  assert.equal(secure.get('account.deviceId'), '55555555-5555-4555-8555-555555555555');
  assert.equal(secure.get('account.deviceSecret'), token('n'));
});
