import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
const { transcribe } = vi.hoisted(() => ({ transcribe: vi.fn() }));
vi.mock('../bridge/client', () => ({ getBridge: () => ({ inference: { transcribe } }) }));
import { cancelVoice, toggleVoice, toPcm16Base64, useVoice } from './voice';
import { useApp } from '../model/store';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const flush = async () => { await Promise.resolve(); await Promise.resolve(); };
let stopTrack: ReturnType<typeof vi.fn>;
let getUserMedia: ReturnType<typeof vi.fn>;
beforeEach(() => {
  stopTrack = vi.fn();
  getUserMedia = vi.fn().mockResolvedValue({ getTracks: () => [{ stop: stopTrack }] });
  vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });
  vi.stubGlobal('document', { querySelector: () => null });
  vi.stubGlobal('AudioContext', class {
    destination = {};
    close = vi.fn().mockResolvedValue(undefined);
    createMediaStreamSource = () => ({ connect: vi.fn() });
    createScriptProcessor = () => ({ connect: vi.fn(), onaudioprocess: null });
  });
  useApp.setState({ account: { id: 'a', name: 'A', email: 'a@example.test', workspace: 'A', initials: 'A', hue: 0 }, drafts: {}, toast: vi.fn() });
  transcribe.mockReset();
});
afterEach(() => { cancelVoice(); vi.unstubAllGlobals(); });

describe('voice recording', () => {
  test('turns float samples into clamped little-endian PCM16', () => {
    const bytes = Uint8Array.from(atob(toPcm16Base64([Float32Array.from([0, 1, -1]), Float32Array.from([2, -2, 0.5])])), (c) => c.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    expect([0, 2, 4, 6, 8, 10].map((offset) => view.getInt16(offset, true))).toEqual([0, 32767, -32768, 32767, -32768, 16383]);
    expect(toPcm16Base64([])).toBe('');
  });

  test('deduplicates pending microphone permission and releases a late grant after cancellation', async () => {
    const permission = deferred<unknown>();
    getUserMedia.mockReturnValue(permission.promise);
    toggleVoice('new'); toggleVoice('new');
    expect(getUserMedia).toHaveBeenCalledTimes(1);
    cancelVoice();
    permission.resolve({ getTracks: () => [{ stop: stopTrack }] });
    await flush();
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(useVoice.getState().recording).toBeNull();
    expect(transcribe).not.toHaveBeenCalled();
  });

  test('releases the microphone if audio initialization fails', async () => {
    vi.stubGlobal('AudioContext', class { constructor() { throw new Error('audio device unavailable'); } });
    toggleVoice('new'); await flush();
    expect(stopTrack).toHaveBeenCalledTimes(1);
    expect(useVoice.getState()).toMatchObject({ starting: null, recording: null, busy: null });
    expect(useApp.getState().toast).toHaveBeenCalledOnce();
  });

  test('account switching fences a pending transcript from the next account’s draft', async () => {
    const transcript = deferred<unknown>();
    transcribe.mockReturnValue(transcript.promise);
    toggleVoice('new'); await flush(); toggleVoice('new');
    expect(transcribe).toHaveBeenCalledOnce();
    useApp.setState({ account: { id: 'b', name: 'B', email: 'b@example.test', workspace: 'B', initials: 'B', hue: 0 }, drafts: { new: { text: 'B’s draft', kind: 'instruction' } } });
    transcript.resolve({ ok: true, value: { text: 'A’s private transcript' } }); await flush();
    expect(useApp.getState().drafts.new?.text).toBe('B’s draft');
    expect(useVoice.getState().busy).toBeNull();
  });

  test('canceled transcription cannot append text or clear a newer transcription', async () => {
    const old = deferred<unknown>(); const next = deferred<unknown>();
    transcribe.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
    toggleVoice('first'); await flush(); toggleVoice('first'); cancelVoice();
    toggleVoice('second'); await flush(); toggleVoice('second');
    old.resolve({ ok: true, value: { text: 'old' } }); await flush();
    expect(useApp.getState().drafts.first).toBeUndefined();
    expect(useVoice.getState().busy).toBe('second');
    next.resolve({ ok: true, value: { text: 'new' } }); await flush();
    expect(useApp.getState().drafts.second?.text).toBe('new');
    expect(useVoice.getState().busy).toBeNull();
  });

  test('a rejected transcription clears busy state and reports the failure', async () => {
    transcribe.mockRejectedValue(new Error('IPC disconnected'));
    toggleVoice('new'); await flush(); toggleVoice('new'); await flush();
    expect(useVoice.getState().busy).toBeNull();
    expect(useApp.getState().toast).toHaveBeenCalledOnce();
  });
});
