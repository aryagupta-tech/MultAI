import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readConfig} from '../src/config.js';

const base = {DATABASE_URL: 'postgresql://user:placeholder@127.0.0.1:5432/multai'};
test('development cannot expose the bearer API on a public interface', () => {
  assert.equal(readConfig(base).host, '127.0.0.1');
  assert.throws(() => readConfig({...base, HOST: '0.0.0.0'}));
  assert.throws(() => readConfig({...base, PUBLIC_ORIGIN: 'http://example.com'}));
});
test('configuration refuses insecure production origins and arbitrary callbacks', () => {
  assert.throws(() => readConfig({...base, NODE_ENV: 'production'}));
  assert.throws(() => readConfig({...base, PUBLIC_ORIGIN: 'https://example.com/path'}));
  assert.throws(() => readConfig({...base, DESKTOP_CALLBACK_URI: 'https://example.com/steal'}));
  assert.throws(() => readConfig({...base, GOOGLE_CLIENT_ID: 'incomplete'}));
  assert.throws(() => readConfig({...base, DATABASE_URL: 'file:///tmp/db'}));
  assert.equal(readConfig({...base, NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://collaboration.example', HOST: '0.0.0.0'}).environment, 'production');
});
test('each environment serves only its own desktop identity', () => {
  const production = {...base, NODE_ENV: 'production', PUBLIC_ORIGIN: 'https://collaboration.example', HOST: '0.0.0.0'};
  const dev = readConfig(base);
  assert.equal(dev.desktopCallbackUri, 'multai-dev://auth/callback');
  assert.equal(dev.desktopClientId, 'multai-desktop-development');
  const release = readConfig(production);
  assert.equal(release.desktopCallbackUri, 'multai://auth/callback');
  assert.equal(release.desktopClientId, 'multai-desktop');
  assert.throws(() => readConfig({...production, DESKTOP_CALLBACK_URI: 'multai-dev://auth/callback'}));
  assert.throws(() => readConfig({...base, DESKTOP_CALLBACK_URI: 'multai://auth/callback'}));
  assert.throws(() => readConfig({...production, DESKTOP_CALLBACK_URI: 'multai://auth/callback?x=1'}));
});
test('only private proxy addresses can be trusted for client IPs', () => {
  assert.deepEqual(readConfig(base).trustedProxies, []);
  assert.deepEqual(readConfig({...base, TRUST_PROXY: '172.30.0.0/24, 10.0.0.1'}).trustedProxies, ['172.30.0.0/24', '10.0.0.1']);
  for (const bad of ['0.0.0.0/0', '8.8.8.8', '172.30.0.0/8', 'true', '*', '::1']) assert.throws(() => readConfig({...base, TRUST_PROXY: bad}), bad);
});

test('the companion web origin is explicit and cannot select provider redirect or insecure production hosts', () => {
  const api = 'https://api.multai.test', web = 'https://app.multai.test';
  const production = {...base, NODE_ENV: 'production', PUBLIC_ORIGIN: api, HOST: '0.0.0.0', GOOGLE_CLIENT_ID:'synthetic-client', GOOGLE_CLIENT_SECRET:'synthetic-secret'};
  const configured = readConfig({...production, COMPANION_WEB_ORIGIN:web});
  assert.equal(configured.companionWebOrigin, web);
  assert.equal(configured.googleRedirectUri, `${api}/v1/auth/google/callback`);
  assert.equal(readConfig(production).companionWebOrigin, api, 'existing deployments remain same-origin by default');
  assert.equal(readConfig({...base, COMPANION_WEB_ORIGIN:'http://localhost:4311'}).companionWebOrigin, 'http://localhost:4311');
  for (const origin of ['http://app.multai.test','https://localhost','https://user@app.multai.test','https://app.multai.test/path','https://app.multai.test?x=1','https://app.multai.test#x','https://*.multai.test']) {
    assert.throws(()=>readConfig({...production,COMPANION_WEB_ORIGIN:origin}),origin);
  }
});
