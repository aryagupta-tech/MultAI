import { beforeAll, describe, expect, test } from 'vitest';

const backing = new Map<string, string>();
beforeAll(() => {
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => backing.get(k) ?? null,
    setItem: (k: string, v: string) => { backing.set(k, v); },
    removeItem: (k: string) => { backing.delete(k); },
  };
});

const accountA = { id: 'user-a', name: 'A', initials: 'A', hue: 1, email: 'a@example.test', workspace: 'Personal' };
const accountB = { id: 'user-b', name: 'B', initials: 'B', hue: 2, email: 'b@example.test', workspace: 'Personal' };

describe('account-scoped drafts', () => {
  test('drafts written under one account are invisible to another and survive sign-out', async () => {
    const { useApp } = await import('./store');
    const s = useApp.getState();
    s.loadDemo({ account: accountA, sessions: [], projects: [], details: {} });
    useApp.getState().setDraft('new', { text: 'secret plan for A', kind: 'instruction' });
    expect(useApp.getState().drafts['new']?.text).toBe('secret plan for A');

    useApp.getState().signOut();
    expect(useApp.getState().drafts['new']).toBeUndefined();

    useApp.getState().loadDemo({ account: accountB, sessions: [], projects: [], details: {} });
    expect(useApp.getState().drafts['new']).toBeUndefined();

    useApp.getState().signOut();
    useApp.getState().loadDemo({ account: accountA, sessions: [], projects: [], details: {} });
    expect(useApp.getState().drafts['new']?.text).toBe('secret plan for A');
  });
});
