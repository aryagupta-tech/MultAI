import { beforeAll, describe, expect, test } from 'vitest';

beforeAll(() => {
  const backing = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => { backing.set(k, v); },
    removeItem: (k: string) => { backing.delete(k); },
  };
});

const build = (channel: 'development' | 'demo' | 'production') => ({ version: '0.1.0', commit: 'abc', dirty: false, builtAt: '', channel, platform: 'darwin' as const, serviceOrigin: 'https://api.multai.si' });

describe('invitation links', () => {
  test('release builds share multai:// links; development builds keep multai-dev://', async () => {
    const { useApp } = await import('../model/store');
    const { inviteLink } = await import('./controller');
    useApp.setState({ build: build('production') });
    expect(inviteLink('tok_abcdefghijklmnop')).toBe('multai://join?token=tok_abcdefghijklmnop');
    useApp.setState({ build: build('development') });
    expect(inviteLink('tok_abcdefghijklmnop')).toBe('multai-dev://join?token=tok_abcdefghijklmnop');
  });

  test('either link form, or a bare code, yields the same token; junk yields nothing', async () => {
    const { parseInvite } = await import('./controller');
    const token = 'AbC_-123456789012345';
    expect(parseInvite(`multai://join?token=${token}`)).toBe(token);
    expect(parseInvite(`  multai-dev://join?token=${token}  `)).toBe(token);
    expect(parseInvite(token)).toBe(token);
    for (const junk of ['', 'short', 'multai://join?token=<script>', 'multai://join', `${token} extra`]) expect(parseInvite(junk)).toBeNull();
  });
});
