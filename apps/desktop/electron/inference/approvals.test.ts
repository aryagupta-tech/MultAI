import {randomUUID} from 'node:crypto';
import {describe, expect, it, vi} from 'vitest';
import type {ActionDescriptor} from '@multai/runtime';
import {ApprovalBroker} from './approvals';

const sessionId = randomUUID();
function descriptor(operation: ActionDescriptor['operation'], expiresIn = 60_000): ActionDescriptor {
  const id = randomUUID();
  return {version: 1, requestId: randomUUID(), sessionId, originalOwnerId: id, originalDeviceId: id, accountGeneration: 1, sessionGeneration: 1, runtimeGeneration: 1, connectionId: id, payerId: id, resourceIdentity: `workspace:${sessionId}`, cwd: '/synthetic', expiresAt: Date.now() + expiresIn, operation};
}
const shell = (commandText: string) => ({kind: 'shell' as const, executable: '/bin/sh', argv: ['-c', commandText], commandText});
const write = {kind: 'file_write' as const, relativePath: 'app.py', expectedContentHash: null, contentHash: 'a'.repeat(64)};

describe('host approvals', () => {
  it('shows a card at ask and resolves with the host\'s decision', async () => {
    const shown = vi.fn();
    const broker = new ApprovalBroker(shown);
    const pending = broker.request(descriptor(write), new AbortController().signal, 'print("hi")\n');
    expect(broker.list()).toEqual([expect.objectContaining({kind: 'file_write', path: 'app.py', newFile: true, preview: 'print("hi")\n', sessionId})]);
    broker.decide(broker.list()[0]!.id, true);
    await expect(pending).resolves.toBe(true);
    expect(broker.list()).toEqual([]);
    expect(shown).toHaveBeenLastCalledWith([]);
  });

  it('approve-for-me runs ordinary work unasked but still asks about risky commands', async () => {
    const broker = new ApprovalBroker(() => undefined);
    broker.setAccess(sessionId, 'auto');
    await expect(broker.request(descriptor(write), new AbortController().signal, 'x')).resolves.toBe(true);
    await expect(broker.request(descriptor(shell('python3 app.py')), new AbortController().signal)).resolves.toBe(true);
    const risky = broker.request(descriptor(shell('rm -rf build')), new AbortController().signal);
    expect(broker.list()[0]).toMatchObject({kind: 'shell', command: 'rm -rf build', reason: expect.stringMatching(/delete/)});
    broker.decide(broker.list()[0]!.id, false);
    await expect(risky).resolves.toBe(false);
  });

  it('full access runs everything, and only for the session it was granted to', async () => {
    const broker = new ApprovalBroker(() => undefined);
    broker.setAccess(sessionId, 'full');
    await expect(broker.request(descriptor(shell('rm -rf build')), new AbortController().signal)).resolves.toBe(true);
    const other = {...descriptor(shell('ls')), sessionId: randomUUID()};
    void broker.request(other, new AbortController().signal);
    expect(broker.list()).toHaveLength(1);
    broker.rejectAll();
  });

  it('expiry, Stop and account changes reject; a file write without its preview never asks', async () => {
    vi.useFakeTimers();
    try {
      const broker = new ApprovalBroker(() => undefined);
      const expired = broker.request(descriptor(shell('ls'), 1000), new AbortController().signal);
      vi.advanceTimersByTime(1001);
      await expect(expired).resolves.toBe(false);
      const controller = new AbortController();
      const stopped = broker.request(descriptor(shell('ls')), controller.signal);
      controller.abort();
      await expect(stopped).resolves.toBe(false);
      const signedOut = broker.request(descriptor(shell('ls')), new AbortController().signal);
      broker.rejectAll();
      await expect(signedOut).resolves.toBe(false);
      await expect(broker.request(descriptor(write), new AbortController().signal)).resolves.toBe(false);
      expect(broker.list()).toEqual([]);
    } finally {vi.useRealTimers();}
  });

  it('rejects unknown access levels and non-boolean decisions', () => {
    const broker = new ApprovalBroker(() => undefined);
    expect(() => broker.setAccess(sessionId, 'admin')).toThrow();
    expect(() => broker.decide(randomUUID(), 'yes')).toThrow();
  });
});
