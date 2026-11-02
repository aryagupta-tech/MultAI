import { describe, expect, it } from 'vitest';
import { planWindows } from './SidebarStatus';

describe('sidebar usage', () => {
  it('shows plan windows as usage left, never per-minute API budgets', () => {
    expect(planWindows({ at: 0, windows: [{ label: '5-hour', usedPercent: 36 }, { label: 'Weekly', usedPercent: 10 }, { label: 'Tokens per minute', usedPercent: 80 }, { label: 'Requests per minute', usedPercent: 1 }] }).map((w) => w.label)).toEqual(['5-hour', 'Weekly']);
    expect(planWindows(null)).toEqual([]);
  });
});
