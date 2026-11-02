// Pairing phones as owner controllers. Phone keys and credentials never reach the renderer; it sees
// names, scopes and the six-digit code to compare with the phone.
import type {Result} from './contract';

export interface PairingOffer {id: string; code: string; link: string; codeExpiresAt: string; sessionIds: string[]; qr: boolean[][]}
export interface PairingReview {
  id: string; status: 'awaiting_device' | 'awaiting_confirmation' | 'active' | 'declined' | 'revoked';
  sessionIds: string[]; grantSeconds: number; deviceName: string | null; platform: 'android' | 'ios' | 'web' | null;
  codeExpiresAt: string;
  /** Computed on this computer from the phone's keys. */
  verificationCode: string | null;
}
export interface PairedPhone {
  id: string; deviceName: string; platform: string;
  /** `untrusted`: the service lists it, but this computer never confirmed it, so its requests are refused. */
  status: 'active' | 'untrusted' | 'revoked';
  sessionIds: string[]; expiresAt: string | null; lastSeenAt: string | null; revokedAt: string | null; revokedBy: string | null; confirmedAt: string | null;
}
export interface ControllerApi {
  createPairing(sessionIds: string[], grantSeconds: number): Promise<PairingOffer>;
  reviewPairing(id: string): Promise<PairingReview>;
  confirmPairing(id: string, sessionIds: string[]): Promise<PairedPhone>;
  declinePairing(id: string): Promise<null>;
  revokePairing(id: string): Promise<null>;
  listPhones(): Promise<PairedPhone[]>;
  audit(id: string): Promise<{event: string; at: string; detail: string}[]>;
}
/** The renderer's view: every call returns a Result. */
export type ControllerBridge = {[K in keyof ControllerApi]: (...args: Parameters<ControllerApi[K]>) => Promise<Result<Awaited<ReturnType<ControllerApi[K]>>>>} & {onChange(listener: () => void): () => void};
export const CONTROLLER_IPC = {invoke: 'multai:controller', changed: 'multai:controller-changed'} as const;
