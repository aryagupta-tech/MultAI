// Signed owner-control requests. The phone signs with a non-extractable P-256 key; the service checks
// the binding and the original desktop host verifies the signature again with the key it confirmed.
import {fromBase64Url, hex, sha256, sha256Hex, stable, toBase64Url, utf8} from './canonical.js';

export const CONTROL_DOMAIN = 'multai-control-v1\n';
export const PAIR_DOMAIN = 'multai-pair-v1\n';
export const PREVIEW_DOMAIN = 'multai-preview-v1\n';
/** A request is only good for two minutes; an old one is never run after a reconnect. */
export const MAX_REQUEST_LIFETIME_MS = 120_000;
export const DEFAULT_REQUEST_LIFETIME_MS = 90_000;

export interface PublicJwk {kty: 'EC'; crv: 'P-256'; x: string; y: string}
export type ControlKind = 'start' | 'resolve' | 'stop' | 'steer' | 'approve' | 'reject';
export interface ControlTargets {
  start: {instructionId: string; queueFingerprint: string};
  resolve: {instructionId: string; queueFingerprint: string; resolution: string};
  stop: Record<string, never>;
  steer: {instructionId: string};
  approve: {actionId: string; actionFingerprint: string};
  reject: {actionId: string; actionFingerprint: string};
}
interface EnvelopeBase {v: 1; pairingId: string; requestId: string; sessionId: string; runGeneration: number; issuedAt: number; expiresAt: number}
export type ControlEnvelope = {[K in ControlKind]: EnvelopeBase & {kind: K; target: ControlTargets[K]}}[ControlKind];
export interface SignedControl {envelope: ControlEnvelope; signature: string}

const SIGN = {name: 'ECDSA', namedCurve: 'P-256'} as const;
const SIGN_HASH = {name: 'ECDSA', hash: 'SHA-256'} as const;
const AGREE = {name: 'ECDH', namedCurve: 'P-256'} as const;

export const publicPart = (key: JsonWebKey | PublicJwk): PublicJwk => {
  if (key.kty !== 'EC' || key.crv !== 'P-256' || typeof key.x !== 'string' || typeof key.y !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(key.x) || !/^[A-Za-z0-9_-]{43}$/u.test(key.y)) throw new TypeError('Expected a P-256 public key.');
  return {kty: 'EC', crv: 'P-256', x: key.x, y: key.y};
};
const ordered = (key: PublicJwk) => ({crv: key.crv, kty: key.kty, x: key.x, y: key.y});

export function controlBytes(envelope: ControlEnvelope): Uint8Array<ArrayBuffer> {return utf8(`${CONTROL_DOMAIN}${stable(envelope)}`);}

/** Phone keys: private halves are non-extractable, so page scripts can use them but never copy them out. */
export interface PhoneKeys {signing: CryptoKeyPair; encryption: CryptoKeyPair}
export async function generatePhoneKeys(): Promise<PhoneKeys> {
  const signing = await crypto.subtle.generateKey(SIGN, false, ['sign', 'verify']) as CryptoKeyPair;
  const encryption = await crypto.subtle.generateKey(AGREE, false, ['deriveBits']) as CryptoKeyPair;
  return {signing, encryption};
}
export async function exportPublic(key: CryptoKey): Promise<PublicJwk> {return publicPart(await crypto.subtle.exportKey('jwk', key));}

export async function keyThumbprint(signingKey: PublicJwk, encryptionKey: PublicJwk): Promise<string> {
  return sha256Hex(stable({enc: ordered(encryptionKey), sign: ordered(signingKey)}));
}
/** Six digits shown on both the phone and the desktop before the host confirms the phone. */
export async function verificationCode(pairingId: string, thumbprint: string): Promise<string> {
  const bytes = await sha256(`${PAIR_DOMAIN}${pairingId}\n${thumbprint}`);
  const value = (((bytes[0]! << 24) >>> 0) + (bytes[1]! << 16) + (bytes[2]! << 8) + bytes[3]!) % 1_000_000;
  const text = value.toString().padStart(6, '0');
  return `${text.slice(0, 3)} ${text.slice(3)}`;
}

export function buildEnvelope<K extends ControlKind>(input: {pairingId: string; sessionId: string; runGeneration: number; kind: K; target: ControlTargets[K]; now: number; requestId?: string; lifetimeMs?: number}): ControlEnvelope {
  const lifetime = Math.min(input.lifetimeMs ?? DEFAULT_REQUEST_LIFETIME_MS, MAX_REQUEST_LIFETIME_MS);
  return {v: 1, pairingId: input.pairingId, requestId: input.requestId ?? crypto.randomUUID(), sessionId: input.sessionId, kind: input.kind, runGeneration: input.runGeneration,
    target: input.target, issuedAt: Math.floor(input.now), expiresAt: Math.floor(input.now) + lifetime} as ControlEnvelope;
}
export async function signControl(envelope: ControlEnvelope, privateKey: CryptoKey): Promise<SignedControl> {
  const signature = new Uint8Array(await crypto.subtle.sign(SIGN_HASH, privateKey, controlBytes(envelope)));
  return {envelope, signature: toBase64Url(signature)};
}
export async function verifyControl(signed: SignedControl, key: PublicJwk): Promise<boolean> {
  try {
    const publicKey = await crypto.subtle.importKey('jwk', ordered(publicPart(key)), SIGN, false, ['verify']);
    return await crypto.subtle.verify(SIGN_HASH, publicKey, fromBase64Url(signed.signature), controlBytes(signed.envelope));
  } catch {return false;}
}
export const controlFingerprint = (envelope: ControlEnvelope) => sha256Hex(stable(envelope));

// ---------------------------------------------------------------- End-to-end encrypted approval previews

/** A file-change preview the host encrypts to one phone; the service only relays ciphertext. */
export interface SealedPreview {pairingId: string; ephemeral: PublicJwk; salt: string; iv: string; data: string}
const previewInfo = (pairingId: string, actionId: string, fingerprint: string) => utf8(`${PREVIEW_DOMAIN}${pairingId}\n${actionId}\n${fingerprint}`);
async function previewKey(privateKey: CryptoKey, publicKey: PublicJwk, salt: Uint8Array<ArrayBuffer>, info: Uint8Array<ArrayBuffer>, usage: 'encrypt' | 'decrypt') {
  const peer = await crypto.subtle.importKey('jwk', ordered(publicKey), AGREE, false, []);
  const shared = await crypto.subtle.deriveBits({name: 'ECDH', public: peer}, privateKey, 256);
  const base = await crypto.subtle.importKey('raw', shared, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey({name: 'HKDF', hash: 'SHA-256', salt, info}, base, {name: 'AES-GCM', length: 256}, false, [usage]);
}
export async function sealPreview(text: string, phoneKey: PublicJwk, binding: {pairingId: string; actionId: string; fingerprint: string}): Promise<SealedPreview> {
  const ephemeral = await crypto.subtle.generateKey(AGREE, true, ['deriveBits']) as CryptoKeyPair;
  const salt = crypto.getRandomValues(new Uint8Array(16)), iv = crypto.getRandomValues(new Uint8Array(12));
  const info = previewInfo(binding.pairingId, binding.actionId, binding.fingerprint);
  const key = await previewKey(ephemeral.privateKey, phoneKey, salt, info, 'encrypt');
  const data = new Uint8Array(await crypto.subtle.encrypt({name: 'AES-GCM', iv, additionalData: info}, key, utf8(text)));
  return {pairingId: binding.pairingId, ephemeral: await exportPublic(ephemeral.publicKey), salt: toBase64Url(salt), iv: toBase64Url(iv), data: toBase64Url(data)};
}
export async function openPreview(sealed: SealedPreview, privateKey: CryptoKey, binding: {actionId: string; fingerprint: string}): Promise<string> {
  const info = previewInfo(sealed.pairingId, binding.actionId, binding.fingerprint);
  const key = await previewKey(privateKey, sealed.ephemeral, fromBase64Url(sealed.salt), info, 'decrypt');
  const plain = await crypto.subtle.decrypt({name: 'AES-GCM', iv: fromBase64Url(sealed.iv), additionalData: info}, key, fromBase64Url(sealed.data));
  return new TextDecoder('utf-8', {fatal: true}).decode(plain);
}

// ---------------------------------------------------------------- Pairing codes

const CODE = /^[0-9A-HJKMNP-TV-Z]{12}$/u;
/** Accepts what people type: lower case, spaces, dashes, O for 0 and I/L for 1. */
export function normalizePairingCode(raw: string): string | null {
  const value = raw.toUpperCase().replace(/[\s-]/gu, '').replace(/O/gu, '0').replace(/[IL]/gu, '1');
  return CODE.test(value) ? value : null;
}
export const formatPairingCode = (code: string) => `${code.slice(0, 4)}-${code.slice(4, 8)}-${code.slice(8)}`;
export {hex};
