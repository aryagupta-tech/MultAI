import { describe, expect, test, vi } from 'vitest';
vi.mock('../bridge/client', () => ({ getBridge: () => null }));
import { toPcm16Base64 } from './voice';

describe('voice recording', () => {
  test('turns float samples into clamped little-endian PCM16', () => {
    const bytes = Uint8Array.from(atob(toPcm16Base64([Float32Array.from([0, 1, -1]), Float32Array.from([2, -2, 0.5])])), (c) => c.charCodeAt(0));
    const view = new DataView(bytes.buffer);
    expect([0, 2, 4, 6, 8, 10].map((offset) => view.getInt16(offset, true))).toEqual([0, 32767, -32768, 32767, -32768, 16383]);
    expect(toPcm16Base64([])).toBe('');
  });
});
