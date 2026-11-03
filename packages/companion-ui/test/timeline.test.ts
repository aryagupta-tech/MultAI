import {describe, expect, it} from 'vitest';
import type {TimelineItem} from '@multai/companion-core';
import {groups} from '../src/Timeline';

const at = '2030-01-01T00:00:00.000Z';
const sys = (n: number, tone: 'info' | 'ok' | 'warn' | 'error' = 'info'): TimelineItem => ({id: `s${n}`, sequence: n, at, kind: 'system', tone, text: `line ${n}`});
const msg = (n: number): TimelineItem => ({id: `m${n}`, sequence: n, at, kind: 'message', style: 'discussion', who: 'Sam', authorId: 'a', text: 'hi', screenshot: false, queued: false});

describe('timeline folding', () => {
  it('folds runs of routine lines, never messages, warnings or a lone line', () => {
    const out = groups([sys(1), sys(2), {id: 'a3', sequence: 3, at, kind: 'activity', text: 'Read cart.js', failed: false}, msg(4), sys(5), sys(6, 'warn'), sys(7, 'ok'), sys(8), {id: 'a9', sequence: 9, at, kind: 'activity', text: 'npm test', failed: true}]);
    expect(out.map(item => Array.isArray(item) ? item.map(i => i.id) : item.id)).toEqual([['s1', 's2', 'a3'], 'm4', 's5', 's6', ['s7', 's8'], 'a9']);
  });
});
