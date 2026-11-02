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
  test('share standard HTTPS links on the configured service with tokens only in fragments', async () => {
    const { useApp } = await import('../model/store');
    const { inviteLink } = await import('./controller');
    useApp.setState({ build: build('production') });
    expect(inviteLink('tok_abcdefghijklmnop')).toBe('https://api.multai.si/app/#join=tok_abcdefghijklmnop');
    useApp.setState({ build: build('development') });
    expect(inviteLink('tok_abcdefghijklmnop')).toBe('https://api.multai.si/app/#join=tok_abcdefghijklmnop');
    useApp.setState({build:{...build('development'),serviceOrigin:'http://127.0.0.1:4310'}});
    const local=new URL(inviteLink('tok_abcdefghijklmnop'));
    expect(local.origin).toBe('http://127.0.0.1:4310');
    expect(local.search).toBe('');
    expect(local.hash).toBe('#join=tok_abcdefghijklmnop');
  });

  test('either link form, or a bare code, yields the same token; junk yields nothing', async () => {
    const { parseInvite } = await import('./controller');
    const token = 'AbC_-12345678901234567890123456789012345678';
    expect(parseInvite(`multai://join?token=${token}`)).toBe(token);
    expect(parseInvite(`  multai-dev://join?token=${token}  `)).toBe(token);
    expect(parseInvite(token)).toBe(token);
    expect(parseInvite(`https://api.multai.si/app/#join=${token}`)).toBe(token);
    expect(parseInvite(`https://example.com/?token=${token}`)).toBeNull();
    expect(parseInvite(`javascript:alert(1)?token=${token}`)).toBeNull();
    for (const junk of ['', 'short', 'AbC_-123456789012345', `${token}x`, 'multai://join?token=<script>', 'multai://join', `${token} extra`]) expect(parseInvite(junk)).toBeNull();
  });
});
