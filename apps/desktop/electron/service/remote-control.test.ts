import {randomUUID} from 'node:crypto';
import {describe, expect, it, vi} from 'vitest';
import type {ActionDescriptor} from '@multai/runtime';
import {buildEnvelope, exportPublic, generatePhoneKeys, keyThumbprint, openPreview, signControl, verificationCode, type ControlKind, type ControlTargets} from '@multai/companion-core';
import {ApprovalBroker} from '../inference/approvals';
import {RemoteControlHost, routeController, type TrustedPhone} from './remote-control';

const sessionId = randomUUID(), otherSession = randomUUID(), owner = randomUUID();
const fingerprint = 'f'.repeat(64);
const queueFingerprint = 'q'.replace('q', 'a').repeat(64);

function descriptor(command: string): ActionDescriptor {
  return {version: 1, requestId: randomUUID(), sessionId, originalOwnerId: owner, originalDeviceId: owner, accountGeneration: 1, sessionGeneration: 4, runtimeGeneration: 4, connectionId: owner, payerId: owner, resourceIdentity: `workspace:${sessionId}`, cwd: '/synthetic', expiresAt: Date.now() + 60_000, operation: {kind: 'shell', executable: '/bin/sh', argv: ['-c', command], commandText: command}};
}

async function setup(options: {status?: 'inactive' | 'running'; generation?: number; requiresReview?: boolean; pending?: string[]} = {}) {
  const phoneKeys = await generatePhoneKeys();
  const signingKey = await exportPublic(phoneKeys.signing.publicKey), encryptionKey = await exportPublic(phoneKeys.encryption.publicKey);
  const pairingId = randomUUID();
  const trusted: TrustedPhone = {pairingId, deviceName: 'Synthetic Pixel', platform: 'android', signingKey, encryptionKey, thumbprint: await keyThumbprint(signingKey, encryptionKey), sessionIds: [sessionId], expiresAt: Date.now() + 86_400_000, confirmedAt: Date.now()};
  let saved: TrustedPhone[] = [trusted];
  const state = {status: options.status ?? 'running', generation: options.generation ?? 4};
  const instructionId = randomUUID();
  const calls: {method: string; path: string; body?: unknown}[] = [];
  const request = vi.fn(async (method: string, path: string, body?: unknown) => {
    calls.push({method, path, body});
    if (path === `/v1/sessions/${sessionId}`) return {session: {runtimeGeneration: state.generation, status: state.status, capabilities: {execute: true}}};
    if (path.startsWith('/v1/host/control-requests?')) return new Promise(() => undefined);
    return {};
  });
  const approvals = new ApprovalBroker(() => undefined);
  const coordinator = {
    run: vi.fn(async () => ({runId: randomUUID()})),
    stop: vi.fn(async () => null),
    conflictContext: vi.fn(async () => ({fingerprint: queueFingerprint, requiresReview: options.requiresReview ?? false, pending: (options.pending ?? [instructionId]).map(id => ({id, authorId: owner, authorName: 'Host', text: 'Fix it', revision: 1}))})),
    selection: vi.fn(async () => ({connectionId: randomUUID(), model: 'synthetic-model'})),
    lockedActions: vi.fn(async () => []),
  };
  const host = new RemoteControlHost({request, accountGeneration: () => 1, identity: async () => ({userId: owner, deviceId: owner}),
    trust: () => ({load: async () => saved, save: async value => {saved = value;}}), coordinator: coordinator as never, approvals});
  await host.start();
  const sign = async <K extends ControlKind>(kind: K, target: ControlTargets[K], extra: {now?: number; sessionId?: string; generation?: number; pairingId?: string} = {}) => {
    const envelope = buildEnvelope({pairingId: extra.pairingId ?? pairingId, sessionId: extra.sessionId ?? sessionId, runGeneration: extra.generation ?? 4, kind, target, now: extra.now ?? Date.now()});
    const signed = await signControl(envelope, phoneKeys.signing.privateKey);
    return {id: envelope.requestId, pairingId: extra.pairingId ?? pairingId, sessionId: envelope.sessionId, envelope, signature: signed.signature};
  };
  return {host, approvals, coordinator, request, calls, state, sign, pairingId, instructionId, phoneKeys, saved: () => saved};
}

describe('the original host independently validates phone requests', () => {
  it('approves only the exact waiting action, once, even when the desktop decides at the same time', async () => {
    const t = await setup();
    const first = t.approvals.request(descriptor('npm test'), new AbortController().signal, undefined, fingerprint);
    const id = t.approvals.list()[0]!.id;
    expect(await t.host.decide(await t.sign('approve', {actionId: id, actionFingerprint: 'e'.repeat(64)}))).toMatchObject({outcome: 'rejected', code: 'action_changed'});
    expect(await t.host.decide(await t.sign('approve', {actionId: id, actionFingerprint: fingerprint}))).toMatchObject({outcome: 'accepted', code: 'approved'});
    await expect(first).resolves.toBe(true);
    // The desktop (or another phone) got there first: the late decision is refused, not applied.
    const second = t.approvals.request(descriptor('npm run build'), new AbortController().signal, undefined, fingerprint);
    const secondId = t.approvals.list()[0]!.id;
    t.approvals.decide(secondId, false);
    await expect(second).resolves.toBe(false);
    expect(await t.host.decide(await t.sign('approve', {actionId: secondId, actionFingerprint: fingerprint}))).toMatchObject({outcome: 'rejected', code: 'approval_unavailable'});
  });

  it('Stop invalidates waiting approvals, so a late phone approval does nothing', async () => {
    const t = await setup();
    const controller = new AbortController();
    const waiting = t.approvals.request(descriptor('npm test'), controller.signal, undefined, fingerprint);
    const id = t.approvals.list()[0]!.id;
    expect(await t.host.decide(await t.sign('stop', {}))).toMatchObject({outcome: 'accepted', code: 'stopped'});
    expect(t.coordinator.stop).toHaveBeenCalledWith(sessionId);
    controller.abort();
    await expect(waiting).resolves.toBe(false);
    expect(await t.host.decide(await t.sign('approve', {actionId: id, actionFingerprint: fingerprint}))).toMatchObject({outcome: 'rejected', code: 'approval_unavailable'});
  });

  it('refuses forged, foreign, out-of-scope, expired, stale and pre-reconnect requests', async () => {
    const t = await setup();
    const good = await t.sign('stop', {});
    expect(await t.host.decide({...good, signature: good.signature.slice(0, -2) + (good.signature.endsWith('AA') ? 'BB' : 'AA')})).toMatchObject({code: 'bad_signature'});
    expect(await t.host.decide({...good, envelope: {...good.envelope, runGeneration: 5}})).toMatchObject({code: 'bad_signature'});
    expect(await t.host.decide({...good, pairingId: randomUUID()})).toMatchObject({code: 'unknown_phone'});
    expect(await t.host.decide({...good, id: randomUUID()})).toMatchObject({code: 'request_mismatch'});
    expect(await t.host.decide(await t.sign('stop', {}, {sessionId: otherSession}))).toMatchObject({code: 'session_scope'});
    expect(await t.host.decide(await t.sign('stop', {}, {now: Date.now() - 125_000}))).toMatchObject({code: 'expired'});
    // Signed before this host (re)started listening: never executed after a reconnect.
    expect(await t.host.decide(await t.sign('stop', {}, {now: Date.now() - 60_000}))).toMatchObject({code: 'issued_before_reconnect'});
    t.state.generation = 5;
    expect(await t.host.decide(good)).toMatchObject({code: 'stale_generation'});
    expect(t.coordinator.stop).not.toHaveBeenCalled();
  });

  it('starts only the selected pending instruction from the exact reviewed queue', async () => {
    const t = await setup({status: 'inactive'});
    expect(await t.host.decide(await t.sign('start', {instructionId: t.instructionId, queueFingerprint: 'b'.repeat(64)}))).toMatchObject({code: 'queue_changed'});
    expect(await t.host.decide(await t.sign('start', {instructionId: randomUUID(), queueFingerprint}))).toMatchObject({code: 'instruction_unavailable'});
    expect(await t.host.decide(await t.sign('start', {instructionId: t.instructionId, queueFingerprint}))).toMatchObject({outcome: 'accepted', code: 'started'});
    expect(t.coordinator.run).toHaveBeenCalledWith(expect.objectContaining({sessionId, instructionId: t.instructionId, model: 'synthetic-model'}));
    expect(t.coordinator.run.mock.calls[0]).not.toContainEqual(expect.objectContaining({resolution: expect.anything()}));
  });

  it('conflicting directions need a resolution, which is bound to the reviewed queue', async () => {
    const t = await setup({status: 'inactive', requiresReview: true});
    expect(await t.host.decide(await t.sign('start', {instructionId: t.instructionId, queueFingerprint}))).toMatchObject({code: 'instruction_conflict'});
    expect(await t.host.decide(await t.sign('resolve', {instructionId: t.instructionId, queueFingerprint, resolution: 'Use integer cents.'}))).toMatchObject({outcome: 'accepted'});
    expect(t.coordinator.run).toHaveBeenCalledWith(expect.objectContaining({resolution: 'Use integer cents.', resolutionFingerprint: queueFingerprint}));
  });

  it('a phone removed on this desktop is refused immediately, even before the service hears about it', async () => {
    const t = await setup();
    t.request.mockImplementationOnce(async () => {throw new Error('offline');});
    await expect(t.host.revokePairing(t.pairingId)).rejects.toThrow();
    expect(t.saved()).toEqual([]);
    expect(await t.host.decide(await t.sign('stop', {}))).toMatchObject({code: 'unknown_phone'});
  });

  it('file previews in host reports open only on the paired phone', async () => {
    const t = await setup();
    const write = {...descriptor('x'), operation: {kind: 'file_write' as const, relativePath: 'src/total.ts', expectedContentHash: null, contentHash: 'a'.repeat(64)}};
    void t.approvals.request(write, new AbortController().signal, 'export const total = cents;\n', fingerprint);
    const state = await t.host.state(sessionId, 'online');
    expect(state.run.status).toBe('blocked');
    expect(state.approval).toMatchObject({kind: 'file_write', path: 'src/total.ts', newFile: true, fingerprint});
    expect(JSON.stringify(state)).not.toContain('cents');
    const sealed = state.approval!.preview![0]!;
    await expect(openPreview(sealed, t.phoneKeys.encryption.privateKey, {actionId: write.requestId, fingerprint})).resolves.toBe('export const total = cents;\n');
  });

  it('pairing review computes the six digits from the phone keys on this computer', async () => {
    const t = await setup();
    const keys = await generatePhoneKeys();
    const signingKey = await exportPublic(keys.signing.publicKey), encryptionKey = await exportPublic(keys.encryption.publicKey);
    const id = randomUUID();
    t.request.mockImplementation(async (_method: string, path: string) => path === `/v1/controller-pairings/${id}` ? {pairing: {id, status: 'awaiting_confirmation', sessionIds: [sessionId], grantSeconds: 3600, deviceName: 'Phone', platform: 'ios', keyThumbprint: 'x', signingKey, encryptionKey, codeExpiresAt: new Date().toISOString(), createdAt: new Date().toISOString(), confirmedAt: null, expiresAt: null, revokedAt: null, revokedBy: null, lastSeenAt: null, verificationCode: '000 000'}} : {});
    const review = await t.host.reviewPairing(id);
    expect(review.verificationCode).toBe(await verificationCode(id, await keyThumbprint(signingKey, encryptionKey)));
    expect(review.verificationCode).not.toBe('000 000');
  });

  it('validates renderer arguments before acting', async () => {
    const t = await setup();
    expect(await routeController(t.host, 'createPairing', [['not-a-uuid'], 3600])).toMatchObject({ok: false, error: {code: 'invalid_request'}});
    expect(await routeController(t.host, 'createPairing', [[sessionId], 60])).toMatchObject({ok: false});
    expect(await routeController(t.host, 'runShell', [])).toMatchObject({ok: false});
  });
});
