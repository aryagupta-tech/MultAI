import assert from 'node:assert/strict';
import {test} from 'node:test';
import {buildEnvelope, controlBytes, describeStatus, exportPublic, generatePhoneKeys, keyThumbprint, normalizePairingCode, openPreview, sealPreview, signControl, stable, verificationCode, verifyControl, MAX_REQUEST_LIFETIME_MS, type ControlEnvelope} from '../src/index.js';

// The service's own Node implementation, so both sides are proven to agree byte for byte.
const service = await import(new URL('../../../apps/backend/src/owner-control.ts', import.meta.url).href) as typeof import('../../../apps/backend/src/owner-control.js');

const ids = {pairingId: '11111111-1111-4111-8111-111111111111', sessionId: '22222222-2222-4222-8222-222222222222'};

test('a phone signature verifies in WebCrypto and in the service, and nowhere else', async () => {
  const keys = await generatePhoneKeys();
  assert.equal(keys.signing.privateKey.extractable, false, 'the private signing key must never be exportable');
  assert.equal(keys.encryption.privateKey.extractable, false);
  const key = await exportPublic(keys.signing.publicKey);
  const envelope = buildEnvelope({...ids, runGeneration: 7, kind: 'approve', target: {actionId: '33333333-3333-4333-8333-333333333333', actionFingerprint: 'a'.repeat(64)}, now: Date.now()});
  const signed = await signControl(envelope, keys.signing.privateKey);
  assert.equal(signed.signature.length, 86);
  assert.ok(await verifyControl(signed, key));
  assert.ok(service.verifyControl(service.envelopeSchema.parse(envelope), signed.signature, key));
  assert.equal(Buffer.from(controlBytes(envelope)).toString(), service.controlBytes(service.envelopeSchema.parse(envelope)).toString());
  // Any changed field breaks the signature: a changed command needs a new approval.
  for (const changed of [
    {...envelope, runGeneration: 8},
    {...envelope, sessionId: '44444444-4444-4444-8444-444444444444'},
    {...envelope, expiresAt: envelope.expiresAt + 1},
    {...envelope, target: {actionId: '33333333-3333-4333-8333-333333333333', actionFingerprint: 'b'.repeat(64)}},
    {...envelope, kind: 'reject'},
  ] as ControlEnvelope[]) {
    assert.equal(await verifyControl({envelope: changed, signature: signed.signature}, key), false);
    assert.equal(service.verifyControl(changed, signed.signature, key), false);
  }
  const other = await generatePhoneKeys();
  assert.equal(await verifyControl(signed, await exportPublic(other.signing.publicKey)), false);
  assert.equal(service.verifyControl(envelope, signed.signature, await exportPublic(other.signing.publicKey)), false);
});

test('thumbprints and six-digit verification codes match the service', async () => {
  const keys = await generatePhoneKeys();
  const signing = await exportPublic(keys.signing.publicKey), encryption = await exportPublic(keys.encryption.publicKey);
  const thumbprint = await keyThumbprint(signing, encryption);
  assert.equal(thumbprint, service.keyThumbprint(signing, encryption));
  assert.match(await verificationCode(ids.pairingId, thumbprint), /^\d{3} \d{3}$/u);
  assert.equal(await verificationCode(ids.pairingId, thumbprint), service.verificationCode(ids.pairingId, thumbprint));
  assert.notEqual(thumbprint, await keyThumbprint(encryption, signing), 'swapping the keys changes the fingerprint');
});

test('envelopes never outlive two minutes and keys are sorted', () => {
  const envelope = buildEnvelope({...ids, runGeneration: 1, kind: 'stop', target: {}, now: 1_000, lifetimeMs: 10 * 60_000});
  assert.equal(envelope.expiresAt - envelope.issuedAt, MAX_REQUEST_LIFETIME_MS);
  assert.equal(stable({b: 1, a: [{d: 1, c: 2}]}), '{"a":[{"c":2,"d":1}],"b":1}');
  assert.equal(service.stable({b: 1, a: [{d: 1, c: 2}]}), stable({b: 1, a: [{d: 1, c: 2}]}));
});

test('approval previews open only on the paired phone, for that exact action', async () => {
  const phone = await generatePhoneKeys();
  const binding = {pairingId: ids.pairingId, actionId: '33333333-3333-4333-8333-333333333333', fingerprint: 'c'.repeat(64)};
  const sealed = await sealPreview('export const total = cents / 100;\n', await exportPublic(phone.encryption.publicKey), binding);
  assert.ok(!sealed.data.includes('cents'));
  assert.equal(await openPreview(sealed, phone.encryption.privateKey, binding), 'export const total = cents / 100;\n');
  await assert.rejects(openPreview(sealed, phone.encryption.privateKey, {...binding, fingerprint: 'd'.repeat(64)}));
  const other = await generatePhoneKeys();
  await assert.rejects(openPreview(sealed, other.encryption.privateKey, binding));
});

test('pairing codes accept what people type', () => {
  assert.equal(normalizePairingCode('k7q2-m9xd-4tpr'), 'K7Q2M9XD4TPR');
  assert.equal(normalizePairingCode(' K7Q2 M9XD 4TPO '), 'K7Q2M9XD4TP0');
  assert.equal(normalizePairingCode('K7Q2-M9XD-4TPU'), null, 'U is not in the alphabet');
  assert.equal(normalizePairingCode('short'), null);
  assert.equal(normalizePairingCode('<script>alert(1)</script>'), null);
  assert.equal(service.normalizeCode('k7q2-m9xd-4tpr'), normalizePairingCode('k7q2-m9xd-4tpr'));
});

test('status never says online without a fresh report or a live connection', () => {
  const report = (host: 'online' | 'asleep', ageMs: number, status = 'idle') => ({state: {host, run: {status}, locked: 0}, ageMs});
  assert.equal(describeStatus({sessionStatus: 'inactive'}).availability, 'unknown');
  assert.equal(describeStatus({sessionStatus: 'inactive', report: report('online', 1_000)}).headline, 'Desktop online · Idle');
  assert.equal(describeStatus({sessionStatus: 'inactive', report: report('online', 45_000)}).headline, 'Desktop is offline');
  assert.equal(describeStatus({sessionStatus: 'inactive', report: report('asleep', 1_000)}).headline, 'Desktop is asleep');
  assert.equal(describeStatus({sessionStatus: 'inactive', report: null, connected: false}).headline, 'Host isn’t connected');
  assert.equal(describeStatus({sessionStatus: 'running', report: report('online', 1_000, 'running'), pendingAction: true}).phase, 'blocked');
  assert.equal(describeStatus({sessionStatus: 'inactive', report: report('online', 1_000, 'completed')}).headline, 'Desktop online · Run completed');
  assert.equal(describeStatus({sessionStatus: 'inactive', report: report('online', 1_000), conflict: true}).headline, 'Desktop online · Conflicting directions');
});
