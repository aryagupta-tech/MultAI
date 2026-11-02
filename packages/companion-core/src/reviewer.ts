// A browser reviewer (guest) admitted by the host. The credential is created here, kept only in memory
// and sent only in a header; reloading or leaving requires a new admission, as on the review page.
import {ApiClient, ApiError} from './client.js';
import {randomSecret} from './canonical.js';
import {reviewViewSchema, type Region, type ReviewView} from './wire.js';
import {z} from 'zod';

export const invitationPattern = /^[A-Za-z0-9_-]{43}$/u;

export class Reviewer {
  private credential: string | null = null;
  private join: {invitationToken: string; credential: string; requestId: string; name: string} | null = null;
  private left = false;
  constructor(private readonly api: ApiClient, private invitation: string | null) {
    if (invitation && !invitationPattern.test(invitation)) this.invitation = null;
  }
  get hasInvitation(): boolean {return Boolean(this.invitation);}
  get joined(): boolean {return Boolean(this.credential);}

  async request(name: string): Promise<{status: string}> {
    if (!this.invitation) throw new ApiError(400, 'review_unavailable', 'Open the complete review invitation from your host.', 'invalid');
    const trimmed = name.trim();
    // A retry after a lost answer reuses the same identity; a new name is a new request.
    if (!this.join || this.join.name !== trimmed) this.join = {invitationToken: this.invitation, credential: randomSecret(), requestId: crypto.randomUUID(), name: trimmed};
    const result = await this.api.request('POST', '/v1/browser-review/join', {body: this.join, schema: z.object({reviewer: z.object({id: z.uuid(), status: z.string(), expiresAt: z.string()})})});
    if (this.left) throw new ApiError(403, 'review_unavailable', 'You left this review.', 'invalid');
    this.credential = this.join.credential;
    this.invitation = null;
    this.join = null;
    return {status: result.reviewer.status};
  }
  private auth() {
    if (!this.credential) throw new ApiError(403, 'review_unavailable', 'Reopen the invitation to request admission again.', 'invalid');
    return {type: 'review' as const, token: this.credential};
  }
  async view(after: number): Promise<ReviewView> {
    const credential = this.credential;
    const result = await this.api.request('POST', '/v1/browser-review/view', {auth: this.auth(), body: {after}, schema: reviewViewSchema});
    // A late answer cannot restore content after leaving or revocation.
    if (this.credential !== credential) throw new ApiError(403, 'review_unavailable', 'You left this review.', 'invalid');
    return result;
  }
  comment(input: {requestId: string; text: string; screenshotId?: string; region?: Region}) {
    return this.api.request('POST', '/v1/browser-review/comment', {auth: this.auth(), body: input});
  }
  propose(input: {requestId: string; text: string; checkCommand?: string}) {
    return this.api.request('POST', '/v1/browser-review/criteria', {auth: this.auth(), body: input});
  }
  decide(input: {requestId: string; criterionId: string; criterionVersion: number; evidenceId: string; revision: string; decision: 'accept' | 'reject'; comment?: string}) {
    return this.api.request('POST', '/v1/browser-review/decision', {auth: this.auth(), body: input});
  }
  leave(): void {this.left = true; this.credential = null; this.invitation = null; this.join = null;}
}
