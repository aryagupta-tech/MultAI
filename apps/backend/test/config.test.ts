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
