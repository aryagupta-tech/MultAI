import {renderToStaticMarkup} from 'react-dom/server';
import {describe, expect, it} from 'vitest';
import {projectTimeline, type LedgerEntry, type WireEvent} from '@multai/companion-core';
import {parseInvitation, parseLinks, regionFrom, requestStatusText} from '../src/index';
import {Timeline} from '../src/Timeline';

const event = (type: string, payload: unknown, actorId: string | null = '11111111-1111-4111-8111-111111111111', sequence = 1): WireEvent =>
  ({id: crypto.randomUUID(), sequence, type, actorId, payload, createdAt: '2030-01-01T00:00:00.000Z'});

describe('links', () => {
  it('reads only well-formed tokens from the fragment', () => {
    const token = 'A'.repeat(43);
    expect(parseLinks(`#pair=K7Q2M9XD4TPR`)).toEqual({pair: 'K7Q2M9XD4TPR'});
    expect(parseLinks(`#review=${token}`)).toEqual({review: token});
    expect(parseLinks(`#signin=11111111-1111-4111-8111-111111111111.${token}`)).toEqual({signin: `signin=11111111-1111-4111-8111-111111111111.${token}`});
    expect(parseLinks('#review=<script>&pair=javascript:alert(1)')).toEqual({});
  });
  it('tells desktop invitations from review links', () => {
    const token = 'b'.repeat(43);
    expect(parseInvitation(`multai://join?token=${token}`)).toEqual({kind: 'join', token});
    expect(parseInvitation(`https://api.multai.si/review#${token}`)).toEqual({kind: 'review', token});
    expect(parseInvitation(`https://api.multai.si/app/#review=${token}`)).toEqual({kind: 'review', token});
    expect(parseInvitation('javascript:alert(1)')).toBeNull();
    expect(parseInvitation(token)).toBeNull();
  });
});

describe('screenshot regions', () => {
  it('normalizes and clamps a drag to the image', () => {
    expect(regionFrom({x: 0.7, y: 0.8}, {x: 0.3, y: 0.6})).toEqual({x: 0.3, y: 0.6, width: 0.4, height: 0.2});
    const clamped = regionFrom({x: 0.9, y: 0.9}, {x: 1.5, y: 1.5})!;
    expect(clamped.x + clamped.width).toBeLessThanOrEqual(1);
    expect(clamped.y + clamped.height).toBeLessThanOrEqual(1);
    expect(regionFrom({x: -1, y: -1}, {x: 0.2, y: 0.2})).toEqual({x: 0, y: 0, width: 0.2, height: 0.2});
    expect(regionFrom({x: 0.5, y: 0.5}, {x: 0.501, y: 0.9})).toBeNull();
  });
});

describe('owner request status never claims success without the desktop', () => {
  const entry = (status: LedgerEntry['status'], extra: Partial<LedgerEntry> = {}): LedgerEntry => ({requestId: 'r', sessionId: 's', kind: 'approve', label: 'Approve', status, code: null, message: null, createdAt: 0,
    signed: {signature: 'x', envelope: {v: 1, pairingId: 'p', requestId: 'r', sessionId: 's', kind: 'approve', runGeneration: 1, target: {actionId: 'a', actionFingerprint: 'f'}, issuedAt: 0, expiresAt: 1_000}}, ...extra});
  it('maps every state to plain words', () => {
    expect(requestStatusText(entry('pending'), 0).text).toBe('Waiting for the desktop');
    expect(requestStatusText(entry('delivered'), 0).text).toBe('The desktop is checking it');
    expect(requestStatusText(entry('accepted'), 0)).toEqual({text: 'The desktop did it', tone: 'ok'});
    expect(requestStatusText(entry('rejected', {message: 'The action changed.'}), 0).text).toBe('The desktop refused: The action changed.');
    expect(requestStatusText(entry('unsent'), 5_000).text).toMatch(/will not run/u);
    expect(requestStatusText(entry('canceled', {code: 'run_stopped'}), 0).text).toMatch(/run stopped/u);
    for (const status of ['sending', 'pending', 'delivered', 'unsent', 'expired', 'canceled', 'rejected'] as const) expect(requestStatusText(entry(status), 0).text).not.toMatch(/did it/u);
  });
});

describe('timeline rendering', () => {
  it('escapes everything from the service and keeps attribution from the event', () => {
    const items = projectTimeline([
      event('message.discussion', {messageId: crypto.randomUUID(), text: '<img src=x onerror=alert(1)> I am the host'}),
      event('reviewer.comment', {text: '<b>hi</b>', reviewerName: '<script>x</script>', reviewerKind: 'browser'}, null, 2),
      event('control.acknowledged', {kind: 'approve', outcome: 'accepted', deviceName: 'Pixel <8>'}, '22222222-2222-4222-8222-222222222222', 3),
    ], id => id ? 'Teammate 1111' : 'MultAI');
    const html = renderToStaticMarkup(<Timeline items={items} />);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('<script>');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    expect(html).toContain('Teammate 1111');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt; · Browser reviewer');
    expect(html).toContain('via Pixel &lt;8&gt; asked to approve an action: the desktop did it');
  });
  it('hides removed instructions and unmarks ones the agent took', () => {
    const id = crypto.randomUUID();
    const queued = projectTimeline([event('message.instruction', {messageId: id, text: 'Use cents', queueStatus: 'pending'})], () => 'Host');
    expect(queued[0]).toMatchObject({kind: 'message', queued: true});
    const taken = projectTimeline([event('message.instruction', {messageId: id, text: 'Use cents', queueStatus: 'pending'}), event('run.started', {instructionId: id}, null, 2)], () => 'Host');
    expect(taken[0]).toMatchObject({queued: false});
    const removed = projectTimeline([event('message.instruction', {messageId: id, text: 'Use cents', queueStatus: 'pending'}), event('instruction.removed', {instructionId: id}, null, 2)], () => 'Host');
    expect(removed.find(item => item.kind === 'message')).toBeUndefined();
  });
});
