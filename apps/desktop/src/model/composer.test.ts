import { describe, expect, test } from 'vitest';
import { applyFormat, draftMeter, resolveEnter, type KeyInput } from './composer';
import { fuzzyFilter, fuzzyScore } from './fuzzy';

const key = (over: Partial<KeyInput>): KeyInput => ({
  key: 'Enter', shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, isComposing: false, ...over,
});

describe('resolveEnter', () => {
  test('plain Enter sends in the selected mode', () => expect(resolveEnter(key({}))).toBe('send'));
  test('Shift+Enter adds a line', () => expect(resolveEnter(key({ shiftKey: true }))).toBe('newline'));
  test('Cmd/Ctrl+Enter uses the alternate delivery', () => {
    expect(resolveEnter(key({ metaKey: true }))).toBe('send-alternate');
    expect(resolveEnter(key({ ctrlKey: true }))).toBe('send-alternate');
  });
  test('IME composition never sends', () => {
    expect(resolveEnter(key({ isComposing: true }))).toBe('ignore');
    expect(resolveEnter(key({ keyCode: 229 }))).toBe('ignore');
    expect(resolveEnter(key({ isComposing: true, metaKey: true }))).toBe('ignore');
  });
  test('other keys are ignored', () => expect(resolveEnter(key({ key: 'a' }))).toBe('ignore'));
});

describe('applyFormat', () => {
  test('wraps the selection and keeps it selected', () => {
    expect(applyFormat('make this bold', 5, 9, 'bold')).toEqual({ text: 'make **this** bold', selectionStart: 7, selectionEnd: 11 });
  });
  test('prefixes every selected line for lists', () => {
    expect(applyFormat('a\nb', 0, 3, 'list')?.text).toBe('- a\n- b');
  });
  test('leaves the draft unchanged when the limit would be exceeded', () => {
    expect(applyFormat('abcd', 0, 4, 'bold', 6)).toBeNull();
  });
});

describe('draftMeter', () => {
  test('hidden for short drafts, error past the limit', () => {
    expect(draftMeter(10, 100).show).toBe(false);
    expect(draftMeter(95, 100).tone).toBe('warn');
    expect(draftMeter(101, 100).tone).toBe('error');
  });
});

describe('fuzzy', () => {
  test('matches subsequences and rejects others', () => {
    expect(fuzzyScore('nc', 'New chat')).not.toBeNull();
    expect(fuzzyScore('zz', 'New chat')).toBeNull();
  });
  test('ranks contiguous word-start matches first', () => {
    expect(fuzzyFilter(['Toggle sidebar', 'Open settings', 'New project'], 'set', (x) => x)[0]).toBe('Open settings');
  });
});
