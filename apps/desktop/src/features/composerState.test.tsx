import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { Composer } from './Composer';
import { readPrompts, SavedPrompts } from './ComposerControls';
import { readSeen, useTeam } from './TeamPanel';
import { useApp } from '../model/store';
import { composeAttachmentText } from './attachments';

// SSR otherwise reads Zustand's creation-time snapshot. Read the current real store for each render.
vi.mock('../model/store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../model/store')>();
  const useCurrent = <T,>(selector: (state: ReturnType<typeof actual.useApp.getState>) => T) => selector(actual.useApp.getState());
  return { ...actual, useApp: Object.assign(useCurrent, actual.useApp) };
});

const account = (id: string) => ({ id, name: id, email: `${id}@example.test`, initials: id[0]!, hue: 0, workspace: 'Personal' });
const backing = new Map<string, string>();
beforeEach(() => {
  vi.useFakeTimers();
  backing.clear();
  vi.stubGlobal('localStorage', { getItem: (key: string) => backing.get(key) ?? null, setItem: (key: string, value: string) => { backing.set(key, value); } });
  useApp.setState({ dataMode: 'demo', account: account('a'), drafts: {}, sessions: [], details: {}, activeId: null, toasts: [], sending: {} });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('composer attachment delivery', () => {
  test('renders a file picker beside the screenshot control, removable filenames, and a sendable files-only draft', () => {
    useApp.getState().setDraft('new', { text: '', files: [{ name: 'notes.md', text: '# Read me' }] });
    const html = renderToStaticMarkup(<Composer d={null} draftKey="new" />);
    expect(html).toContain('aria-label="Attach a screenshot"');
    expect(html).toContain('aria-label="Attach text or source files"');
    expect(html).toContain('aria-label="Remove notes.md"');
    const send = html.match(/<button\b[^>]*aria-label="Send to agent"[^>]*>/u)?.[0];
    expect(send).toBeDefined();
    expect(send).not.toContain('disabled');
  });

  test('persists files only within their account and includes content once on confirmed demo delivery', () => {
    const files = [{ name: 'notes.md', text: '# Keep this content' }];
    useApp.getState().setDraft('new', { text: 'Review', files, image: 'data:image/jpeg;base64,fixture' });
    useApp.getState().loadDemo({ account: account('b'), sessions: [], projects: [], details: {} });
    expect(useApp.getState().drafts.new).toBeUndefined();
    useApp.getState().loadDemo({ account: account('a'), sessions: [], projects: [], details: {} });
    expect(useApp.getState().drafts.new?.files).toEqual(files);
    expect(useApp.getState().send('new', 'discussion')).toBe(true);
    const detail = useApp.getState().details[useApp.getState().activeId!];
    const message = detail?.timeline[0];
    expect(message?.type).toBe('message');
    if (message?.type !== 'message') throw new Error('Expected delivered message');
    expect(message.text).toBe(composeAttachmentText('Review', files));
    expect(message.image).toBe('data:image/jpeg;base64,fixture');
    expect(useApp.getState().drafts.new).toMatchObject({ text: '', files: undefined, image: undefined });
  });

  test('failed sends retain files and over-limit payloads never send', () => {
    const files = [{ name: 'notes.md', text: 'retry content' }];
    useApp.setState({ dataMode: 'live' });
    useApp.getState().setDraft('new', { text: 'Review', files });
    expect(useApp.getState().send('new', 'instruction')).toBe(false);
    expect(useApp.getState().drafts.new?.files).toEqual(files);
    useApp.setState({ dataMode: 'demo' });
    useApp.getState().setDraft('new', { text: 'x'.repeat(16_000) });
    expect(useApp.getState().send('new', 'discussion')).toBe(false);
    const html = renderToStaticMarkup(<Composer d={null} draftKey="new" />);
    expect(html.match(/<button\b[^>]*aria-label="Send to agent"[^>]*>/u)?.[0]).toContain('disabled');
    expect(useApp.getState().drafts.new?.files).toEqual(files);
  });
});

describe('account-scoped composer storage', () => {
  test('saved prompts read the current account without showing another account’s content', () => {
    backing.set('multai.prompts.v1:a', JSON.stringify([{ id: 'private', label: 'A only', text: 'Private A prompt' }]));
    backing.set('multai.prompts.v1:b', JSON.stringify([{ id: 'other', label: 'B only', text: 'Private B prompt' }]));
    expect(readPrompts()[0]?.text).toBe('Private A prompt');
    useApp.setState({ account: account('b') });
    expect(readPrompts()[0]?.text).toBe('Private B prompt');
    // Rendering initializes the menu from B’s storage after an account switch.
    expect(renderToStaticMarkup(<SavedPrompts text="" onInsert={() => undefined} />)).not.toContain('Private A prompt');
  });

  test('corrupt seen values cannot crash the team panel or become negative unread offsets', () => {
    for (const raw of ['null', '[]', '"bad"', '{broken']) {
      backing.set('multai.team-seen.v1:a', raw);
      expect(readSeen()).toEqual({});
    }
    backing.set('multai.team-seen.v1:a', JSON.stringify({ valid: 2, negative: -1, fractional: 1.2, text: '2', huge: 1e99 }));
    expect(readSeen()).toEqual({ valid: 2 });
    useApp.setState({ account: account('b') });
    expect(useTeam.getState().seen).toEqual({});
  });
});
