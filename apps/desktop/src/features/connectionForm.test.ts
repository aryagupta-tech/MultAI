import { describe, expect, test } from 'vitest';
import { baseUrlError, canSubmit, hostOf, keyError, nameError, statusLabel, toInput, type FormState } from './connectionForm';

const form = (over: Partial<FormState> = {}): FormState => ({ provider: 'openai', name: '', apiKey: '', baseUrl: '', ...over });

describe('keyError', () => {
  test('empty is not an error, just not ready', () => expect(keyError('   ')).toBeNull());
  test('accepts a normal key and ignores surrounding whitespace', () => expect(keyError('  sk-abc123  ')).toBeNull());
  test('rejects inner spaces, tabs and pasted line breaks', () => {
    expect(keyError('sk-abc 123')).toMatch(/spaces/);
    expect(keyError('sk-abc\t123')).toMatch(/spaces/);
    expect(keyError('sk-abc\n123')).toMatch(/spaces/);
  });
  test('rejects control characters', () => expect(keyError('sk-\u0007abc')).toMatch(/spaces/));
  test('enforces the 8192 character bound exactly', () => {
    expect(keyError('a'.repeat(8192))).toBeNull();
    expect(keyError('a'.repeat(8193))).toMatch(/8,192/);
  });
});

describe('nameError', () => {
  test('optional name, bounded to 80', () => {
    expect(nameError('')).toBeNull();
    expect(nameError('a'.repeat(80))).toBeNull();
    expect(nameError('a'.repeat(81))).toMatch(/80/);
  });
  test('rejects control characters', () => expect(nameError('Work\nkey')).toMatch(/line breaks/));
});

describe('baseUrlError', () => {
  test('accepts a public https endpoint with a path', () => expect(baseUrlError('https://api.provider.example/v1')).toBeNull());
  test.each([
    ['provider.example/v1', /full address/],
    ['http://api.provider.example/v1', /https/],
    ['https://user:pw@api.provider.example', /username/],
    ['https://api.provider.example/v1?key=1', /query/],
    ['https://api.provider.example/v1#x', /query/],
    ['https://api.provider.example:8443/v1', /ports/],
    ['https://localhost/v1', /Local/],
    ['https://models.local/v1', /Local/],
    ['https://192.168.1.4/v1', /Private/],
    ['https://10.0.0.2/v1', /Private/],
    ['https://127.0.0.1/v1', /Private/],
    ['https://[::1]/v1', /Private|Local/],
  ])('rejects %s', (input, message) => expect(baseUrlError(input)).toMatch(message));
  test('allows explicit :443', () => expect(baseUrlError('https://api.provider.example:443/v1')).toBeNull());
});

describe('canSubmit and toInput', () => {
  test('needs a valid key', () => {
    expect(canSubmit(form())).toBe(false);
    expect(canSubmit(form({ apiKey: 'sk-1' }))).toBe(true);
    expect(canSubmit(form({ apiKey: 'sk 1' }))).toBe(false);
  });
  test('compatible needs a valid base URL; others ignore it', () => {
    expect(canSubmit(form({ provider: 'compatible', apiKey: 'k' }))).toBe(false);
    expect(canSubmit(form({ provider: 'compatible', apiKey: 'k', baseUrl: 'http://x.example' }))).toBe(false);
    expect(canSubmit(form({ provider: 'compatible', apiKey: 'k', baseUrl: 'https://x.example/v1' }))).toBe(true);
    expect(toInput(form({ provider: 'openai', apiKey: 'k', baseUrl: 'https://stale.example' }))).toEqual({ provider: 'openai', apiKey: 'k' });
  });
  test('trims and omits an empty name', () => {
    expect(toInput(form({ apiKey: '  k  ', name: '   ' }))).toEqual({ provider: 'openai', apiKey: 'k' });
    expect(toInput(form({ apiKey: 'k', name: ' Work ' }))).toEqual({ provider: 'openai', apiKey: 'k', name: 'Work' });
  });
});

describe('display helpers', () => {
  test('status labels', () => {
    expect(statusLabel('ready')).toEqual({ text: 'Ready', tone: 'ok' });
    expect(statusLabel('sign-in-required').tone).toBe('warn');
    expect(statusLabel('plan-permission-required').text).toMatch(/permission/);
  });
  test('hostOf tolerates bad input', () => {
    expect(hostOf('https://api.openai.com/v1')).toBe('api.openai.com');
    expect(hostOf('not a url')).toBe('not a url');
  });
});
