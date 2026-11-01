// Host approvals in the conversation instead of a native dialog. The main process decides what
// may run on its own (access.ts); everything else becomes a card only the original host can answer.
import type {ActionDescriptor} from '@multai/runtime';
import type {HostApproval} from '../../src/bridge/execution';
import {ACCESS_LEVELS, needsHost, type AccessLevel} from './access';

const PREVIEW_LIMIT = 16_000;

export class ApprovalBroker {
  private readonly levels = new Map<string, AccessLevel>();
  private readonly pending = new Map<string, {approval: HostApproval; settle(approved: boolean): void}>();
  constructor(private readonly show: (pending: HostApproval[]) => void) {}

  access(sessionId: string): AccessLevel {return this.levels.get(sessionId) ?? 'ask';}
  setAccess(sessionId: string, level: unknown): AccessLevel {
    if (!ACCESS_LEVELS.includes(level as AccessLevel)) throw new TypeError('Unknown access level.');
    if (level === 'ask') this.levels.delete(sessionId); else this.levels.set(sessionId, level as AccessLevel);
    return this.access(sessionId);
  }
  list(): HostApproval[] {return [...this.pending.values()].map(entry => entry.approval);}

  /** Resolves true only for an automatic grant or the host's explicit Approve before expiry. */
  request(descriptor: ActionDescriptor, signal: AbortSignal, preview?: string): Promise<boolean> {
    const operation = descriptor.operation;
    if (operation.kind === 'file_write' && preview === undefined) return Promise.resolve(false);
    const level = this.access(descriptor.sessionId);
    const reason = needsHost(level, operation);
    if (reason === null) return Promise.resolve(true);
    const approval: HostApproval = {
      id: descriptor.requestId, sessionId: descriptor.sessionId, reason, expiresAt: new Date(descriptor.expiresAt).toISOString(),
      ...(operation.kind === 'file_write' ? {kind: 'file_write', path: operation.relativePath, newFile: operation.expectedContentHash === null, preview: (preview ?? '').slice(0, PREVIEW_LIMIT)}
        : operation.kind === 'shell' ? {kind: 'shell', command: operation.commandText ?? operation.argv.join(' ')}
        : {kind: 'external', command: JSON.stringify(operation).slice(0, 2000)}),
    };
    return new Promise<boolean>(resolve => {
      const timer = setTimeout(() => settle(false), Math.max(0, descriptor.expiresAt - Date.now()));
      const onAbort = () => settle(false);
      const settle = (approved: boolean) => {
        if (!this.pending.delete(approval.id)) return;
        clearTimeout(timer); signal.removeEventListener('abort', onAbort);
        this.show(this.list());
        resolve(approved && !signal.aborted);
      };
      if (signal.aborted) return resolve(false);
      signal.addEventListener('abort', onAbort, {once: true});
      this.pending.set(approval.id, {approval, settle});
      this.show(this.list());
    });
  }

  decide(id: string, approved: unknown): null {
    if (typeof approved !== 'boolean') throw new TypeError('A decision must be approve or reject.');
    this.pending.get(id)?.settle(approved);
    return null;
  }
  /** Account changes, sleep and quitting reject everything still waiting. */
  rejectAll(): void {for (const entry of [...this.pending.values()]) entry.settle(false);}
}
