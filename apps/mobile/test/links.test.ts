import assert from 'node:assert/strict';
import {test} from 'node:test';
import {nativeLinks} from '../src/links.ts';

const origin = 'https://api.multai.si';
const token = 'A'.repeat(43);
const signin = `signin=00000000-0000-4000-8000-000000000001.${token}`;
const parse = (url: string | undefined) => nativeLinks(url, origin, 'multai-companion');

test('production App Links support HTTPS invitations, review and pairing without a download', () => {
  assert.deepEqual(parse(`${origin}/app/#join=${token}`), {join: token});
  assert.deepEqual(parse(`${origin}/app#review=${token}`), {review: token});
  assert.deepEqual(parse(`${origin}/app/#pair=K7Q2-M9XD-4TPR`), {pair: 'K7Q2-M9XD-4TPR'});
});

test('only the build-specific native callback may complete a sign-in', () => {
  assert.deepEqual(parse(`multai-companion://auth/callback#${signin}`), {signin});
  assert.deepEqual(parse(`multai-companion-dev://auth/callback#${signin}`), {});
  assert.deepEqual(nativeLinks(`multai-companion-dev://auth/callback#${signin}`, 'http://localhost:4319', 'multai-companion-dev'), {signin});
  assert.deepEqual(nativeLinks(`multai-companion://auth/callback#${signin}`, 'http://localhost:4319', 'multai-companion-dev'), {});
  assert.deepEqual(parse(`${origin}/app/#${signin}`), {});
  assert.deepEqual(parse(`multai-companion://auth/callback#join=${token}`), {});
});

test('foreign services, lookalike paths, queries and malformed tokens are ignored', () => {
  for (const url of [undefined, 'not a url', `https://example.com/app/#join=${token}`, `http://api.multai.si/app/#join=${token}`, `${origin}/application#join=${token}`, `${origin}/app/other#join=${token}`, `${origin}/app/?join=${token}`, `${origin}/app/?tracking=1#join=${token}`, `https://user@api.multai.si/app/#join=${token}`, `${origin}/app/#join=short`, `multai-companion://auth:123/callback#${signin}`, `multai-companion://auth/callback/extra#${signin}`]) {
    assert.deepEqual(parse(url), {}, `must reject ${url}`);
  }
});

test('a crafted URL has one entry intent and cannot mix sign-in with an admission', () => {
  assert.deepEqual(parse(`multai-companion://auth/callback#${signin}&join=${token}`), {signin});
  assert.deepEqual(parse(`${origin}/app/#join=${token}&review=${token}`), {review: token});
});
