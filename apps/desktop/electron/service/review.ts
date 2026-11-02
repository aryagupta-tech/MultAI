import {z} from 'zod';
import type {Account} from './account';
const uuid=z.uuid(),version=z.number().int().positive(),command=z.string().min(1).max(2000).nullable().optional();
export const reviewSchema=z.discriminatedUnion('kind',[
  z.object({kind:z.literal('acceptance')}).strict(),z.object({kind:z.literal('reviewers')}).strict(),
  z.object({kind:z.literal('propose'),requestId:uuid,text:z.string().trim().min(1).max(2000),checkCommand:command}).strict(),
  z.object({kind:z.literal('approve'),requestId:uuid,criterionId:uuid,expectedVersion:version}).strict(),
  z.object({kind:z.literal('revise'),requestId:uuid,criterionId:uuid,expectedVersion:version,text:z.string().trim().min(1).max(2000),checkCommand:command,withdraw:z.boolean().optional()}).strict(),
  z.object({kind:z.literal('decision'),requestId:uuid,criterionId:uuid,criterionVersion:version,evidenceId:uuid,revision:z.string().regex(/^[a-f0-9]{64}$/u),decision:z.enum(['accept','reject']),comment:z.string().trim().min(1).max(2000).optional()}).strict(),
  z.object({kind:z.literal('invite'),expiresInSeconds:z.number().int().min(60).max(86400)}).strict(),
  z.object({kind:z.literal('revokeInvite'),invitationId:uuid}).strict(),
  z.object({kind:z.literal('admit'),reviewerId:uuid,decision:z.enum(['admit','revoke'])}).strict(),
  z.object({kind:z.literal('screenshot'),label:z.string().trim().min(1).max(120),image:z.string().max(110000).regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/u)}).strict(),
  z.object({kind:z.literal('removeScreenshot'),screenshotId:uuid}).strict(),
]);
const invitationResponse=z.object({invitation:z.object({id:uuid,token:z.string().regex(/^[A-Za-z0-9_-]{43}$/u),expiresAt:z.iso.datetime()})});
export async function routeReview(account:Pick<Account,'request'|'origin'>,sessionId:string,input:unknown):Promise<unknown>{
  uuid.parse(sessionId);const op=reviewSchema.parse(input),base=`/v1/sessions/${sessionId}`;
  const req=account.request.bind(account);
  switch(op.kind){
    case 'acceptance':return req('GET',`${base}/acceptance`);
    case 'reviewers':return req('GET',`${base}/reviewers`);
    case 'propose':{const {kind:_kind,...body}=op;return req('POST',`${base}/acceptance/criteria`,body);}
    case 'approve':{const {kind:_kind,criterionId,...body}=op;return req('POST',`${base}/acceptance/criteria/${criterionId}/approve`,body);}
    case 'revise':{const {kind:_kind,criterionId,...body}=op;return req('POST',`${base}/acceptance/criteria/${criterionId}/revise`,body);}
    case 'decision':{const {kind:_kind,...body}=op;return req('POST',`${base}/acceptance/reviews`,body);}
    case 'invite':{const result=invitationResponse.parse(await req('POST',`${base}/reviewer-invitations`,{expiresInSeconds:op.expiresInSeconds}));return {id:result.invitation.id,link:`${account.origin}/review#${result.invitation.token}`,expiresAt:result.invitation.expiresAt};}
    case 'revokeInvite':return req('DELETE',`${base}/reviewer-invitations/${op.invitationId}`);
    case 'admit':return req('POST',`${base}/reviewers/${op.reviewerId}`,{decision:op.decision});
    case 'screenshot':return req('POST',`${base}/reviewer-screenshots`,{image:op.image,label:op.label});
    case 'removeScreenshot':return req('DELETE',`${base}/reviewer-screenshots/${op.screenshotId}`);
  }
}
