import { describe, expect, test, vi } from 'vitest';
vi.mock('../bridge/client', () => ({ getBridge: () => null }));
import { boxAround, boxFrom } from './MarkProblem';

describe('marking the problem by hand', () => {
  test('a click makes a box around it that stays on the image', () => {
    expect(boxAround(500, 400, 1000, 800)).toEqual({ x1: 440, y1: 352, x2: 560, y2: 448 });
    expect(boxAround(2, 3, 1000, 800)).toEqual({ x1: 0, y1: 0, x2: 62, y2: 51 });
    expect(boxAround(999, 799, 1000, 800)).toEqual({ x1: 939, y1: 751, x2: 999, y2: 799 });
  });
  test('a drag in any direction becomes a box clamped to the image', () => {
    expect(boxFrom({ x: 300.4, y: 50 }, { x: 100, y: 250.6 }, 1000, 800)).toEqual({ x1: 100, y1: 50, x2: 300, y2: 251 });
    expect(boxFrom({ x: -20, y: -5 }, { x: 5000, y: 900 }, 1000, 800)).toEqual({ x1: 0, y1: 0, x2: 999, y2: 799 });
  });
});
