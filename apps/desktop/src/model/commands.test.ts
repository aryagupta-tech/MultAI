import { describe, expect, it } from 'vitest';
import { parseSlash, replaceTrigger, shellCommand, triggerAt, withFolders } from './commands';

describe('composer triggers', () => {
  it('opens commands only at the start of the draft', () => {
    expect(triggerAt('/rev', 4)).toEqual({ kind: 'slash', query: 'rev', start: 0, end: 4 });
    expect(triggerAt('/', 1)).toMatchObject({ kind: 'slash', query: '' });
    expect(triggerAt('fix /rev', 8)).toBeNull();
    expect(triggerAt('/review now', 11)).toBeNull();
  });
  it('opens files after an @ that starts a word, not inside e-mail addresses', () => {
    expect(triggerAt('look at @src/ca', 15)).toEqual({ kind: 'mention', query: 'src/ca', start: 8, end: 15 });
    expect(triggerAt('(@a', 3)).toMatchObject({ kind: 'mention', query: 'a' });
    expect(triggerAt('me@example.com', 14)).toBeNull();
    // Caret in the middle of a token: the whole token is replaced.
    expect(triggerAt('@src/cart.js done', 4)).toEqual({ kind: 'mention', query: 'src', start: 0, end: 12 });
  });
  it('replaces the token and adds a space, except after folders', () => {
    const file = replaceTrigger('see @ca and', { kind: 'mention', query: 'ca', start: 4, end: 7 }, '@src/cart.js');
    expect(file).toEqual({ text: 'see @src/cart.js and', caret: 16 });
    expect(replaceTrigger('@sr', { kind: 'mention', query: 'sr', start: 0, end: 3 }, '@src/')).toEqual({ text: '@src/', caret: 5 });
    expect(replaceTrigger('/re', { kind: 'slash', query: 're', start: 0, end: 3 }, '/review')).toEqual({ text: '/review ', caret: 8 });
  });
  it('parses whole-draft commands and ! terminal commands', () => {
    expect(parseSlash('/plan add a cache')).toEqual({ name: 'plan', args: 'add a cache' });
    expect(parseSlash(' /compact ')).toEqual({ name: 'compact', args: '' });
    expect(parseSlash('please /compact')).toBeNull();
    expect(shellCommand('! npm test')).toBe('npm test');
    expect(shellCommand('not !this')).toBeNull();
  });
  it('lists the folders a file list implies', () => {
    expect(withFolders(['src/a.ts', 'src/lib/b.ts', 'README.md'])).toEqual(['src/', 'src/lib/', 'src/a.ts', 'src/lib/b.ts', 'README.md']);
  });
});
