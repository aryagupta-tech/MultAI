export interface CriterionReview {reviewerId:string;reviewerName:string;reviewerKind:'participant'|'browser';decision:'accept'|'reject';comment:string|null;createdAt:string}
export interface CriterionEvidence {id:string;criterionVersion:number;revision:string;kind:'command'|'manual';command:string|null;exitCode:number|null;output:string;timedOut:boolean;canceled:boolean;durationMs:number|null;createdAt:string;reviews:CriterionReview[]}
export interface AcceptanceCriterion {id:string;text:string;checkCommand:string|null;version:number;state:'proposed'|'approved'|'withdrawn';authorId:string;authorName:string;authorKind:'participant'|'browser';status:'proposed'|'needs_review'|'passed'|'failed'|'stale';evidence:CriterionEvidence|null}
export interface AcceptanceSnapshot {revision:string|null;criteria:AcceptanceCriterion[]}
export interface BrowserReviewers {invitations:{id:string;expiresAt:string}[];reviewers:{id:string;name:string;status:'pending'|'admitted'|'revoked';createdAt:string;expiresAt:string}[];screenshots:{id:string;label:string;image:string;createdAt:string}[]}
export type ReviewOperation=
  |{kind:'acceptance'|'reviewers'}
  |{kind:'propose';requestId:string;text:string;checkCommand?:string|null}
  |{kind:'approve';requestId:string;criterionId:string;expectedVersion:number}
  |{kind:'revise';requestId:string;criterionId:string;expectedVersion:number;text:string;checkCommand?:string|null;withdraw?:boolean}
  |{kind:'decision';requestId:string;criterionId:string;criterionVersion:number;evidenceId:string;revision:string;decision:'accept'|'reject';comment?:string}
  |{kind:'invite';expiresInSeconds:number}
  |{kind:'revokeInvite';invitationId:string}
  |{kind:'admit';reviewerId:string;decision:'admit'|'revoke'}
  |{kind:'screenshot';image:string;label:string}
  |{kind:'removeScreenshot';screenshotId:string};
