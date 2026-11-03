import {requireBrowserOrigin} from './web-origin.js';
import {createHash, randomBytes, randomUUID} from 'node:crypto';
import type {FastifyInstance, FastifyRequest} from 'fastify';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {CollaborationService, requireOriginalHost, type SessionRow} from './collaboration.js';
import {assertActor, transaction} from './db.js';
import {ApiError} from './errors.js';
import {redact} from './execution.js';
import {replayEvent, type ReplayEvent} from './replay.js';
import {readAcceptance, proposeAcceptanceCriterion, reviewAcceptanceEvidence} from './acceptance.js';
import {REVIEW_CSS, REVIEW_HTML, REVIEW_JS} from './browser-review-page.js';
import type {Actor} from './types.js';

const uuid=z.uuid();
const secret=z.string().regex(/^[A-Za-z0-9_-]{43}$/u);
const text=(max:number)=>z.string().trim().min(1).max(max).refine(value=>!/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value));
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
const regionSchema=z.object({x:z.number().min(0).max(1),y:z.number().min(0).max(1),width:z.number().positive().max(1),height:z.number().positive().max(1)}).strict().refine(value=>value.x+value.width<=1.000001&&value.y+value.height<=1.000001);
const imageSchema=z.string().max(110000).regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/u).refine(value=>{
  const bytes=Buffer.from(value.slice(value.indexOf(',')+1),'base64');
  return value.startsWith('data:image/png;')?bytes.subarray(0,8).equals(Buffer.from([137,80,78,71,13,10,26,10])):
    value.startsWith('data:image/jpeg;')?bytes[0]===255&&bytes[1]===216&&bytes[2]===255:bytes.toString('ascii',0,4)==='RIFF'&&bytes.toString('ascii',8,12)==='WEBP';
});
interface ReviewerRow {id:string;session_id:string;invitation_id:string;name:string;status:'pending'|'admitted'|'revoked';expires_at:Date;created_at:Date}
const unavailable=()=>new ApiError(403,'review_unavailable','This review invitation or access expired or was revoked. Ask the host for a new invitation.');

/** Browser credentials never become native accounts, instruction authors or execution actors. */
export class BrowserReviewService extends CollaborationService {
  private async host(client:PoolClient,actor:Actor,sessionId:string){
    await assertActor(client,actor);
    const authorized=await this.authorize(client,actor,uuid.parse(sessionId));
    requireOriginalHost(authorized,actor);
    return authorized.session;
  }
  private async session(client:PoolClient,id:string){
    const row=await client.query<SessionRow>('SELECT * FROM sessions WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',[id]);
    if(!row.rows[0])throw unavailable();
    return row.rows[0];
  }
  /** Lookup obtains the session id only; authorization is rechecked after acquiring its lock. */
  private async guest(client:PoolClient,credential:string,admitted=true){
    const digest=hash(secret.parse(credential));
    const found=await client.query<{session_id:string}>('SELECT session_id FROM browser_reviewers WHERE token_hash=$1',[digest]);
    if(!found.rows[0])throw unavailable();
    const session=await this.session(client,found.rows[0].session_id);
    const rows=await client.query<ReviewerRow>(`SELECT r.* FROM browser_reviewers r JOIN browser_review_invitations i ON i.id=r.invitation_id
      WHERE r.token_hash=$1 AND r.status<>'revoked' AND r.expires_at>now() AND i.revoked_at IS NULL AND i.expires_at>now()`,[digest]);
    const reviewer=rows.rows[0];
    if(!reviewer)throw unavailable();
    if(admitted&&reviewer.status!=='admitted')throw new ApiError(403,'review_admission_required','Wait for the host to admit you.');
    return {session,reviewer};
  }
  private async appendReview(client:PoolClient,session:SessionRow,type:string,payload:unknown){
    if(session.event_sequence>=99744)throw new ApiError(409,'session_capacity','This session has reached its event capacity.');
    const sequence=++session.event_sequence;
    await client.query('INSERT INTO shared_events(id,session_id,sequence,type,actor_id,payload) VALUES($1,$2,$3,$4,NULL,$5)',[randomUUID(),session.id,sequence,type,JSON.stringify(payload)]);
    await client.query('UPDATE sessions SET event_sequence=$2,updated_at=now() WHERE id=$1',[session.id,sequence]);
    return {sequence};
  }
  private async control(client:PoolClient,session:SessionRow,actor:Actor,type:string,payload:unknown){
    // Revocation must work even when no more content fits in the shared timeline.
    if(session.event_sequence>=99744)return;
    await this.append(client,session,actor,type,payload);
  }
  async createReviewInvitation(actor:Actor,sessionId:string,input:unknown){
    const body=z.object({expiresInSeconds:z.number().int().min(3600).max(7*86400).default(86400)}).strict().parse(input??{});
    return transaction(this.db,async client=>{
      const session=await this.host(client,actor,sessionId);
      const count=await client.query<{count:number}>('SELECT count(*)::int AS count FROM browser_review_invitations WHERE session_id=$1 AND revoked_at IS NULL AND expires_at>now()',[session.id]);
      if(count.rows[0]!.count>=20)throw new ApiError(409,'review_capacity','Revoke a review invitation before creating another.');
      const id=randomUUID(),token=randomBytes(32).toString('base64url');
      const result=await client.query<{expires_at:Date}>('INSERT INTO browser_review_invitations(id,session_id,token_hash,expires_at) VALUES($1,$2,$3,now()+$4*interval \'1 second\') RETURNING expires_at',[id,session.id,hash(token),body.expiresInSeconds]);
      const expiresAt=result.rows[0]!.expires_at.toISOString();
      await this.append(client,session,actor,'reviewer.invitation_created',{id,expiresAt});
      return {invitation:{id,token,expiresAt}};
    });
  }
  async list(actor:Actor,sessionId:string){
    return transaction(this.db,async client=>{
      await this.host(client,actor,sessionId);
      const invitations=await client.query<{id:string;expires_at:Date}>('SELECT id,expires_at FROM browser_review_invitations WHERE session_id=$1 AND revoked_at IS NULL AND expires_at>now() ORDER BY created_at DESC',[sessionId]);
      const reviewers=await client.query<ReviewerRow>(`SELECT r.* FROM browser_reviewers r JOIN browser_review_invitations i ON i.id=r.invitation_id
        WHERE r.session_id=$1 AND r.expires_at>now() AND i.revoked_at IS NULL AND i.expires_at>now() ORDER BY r.created_at DESC LIMIT 200`,[sessionId]);
      return {invitations:invitations.rows.map(row=>({id:row.id,expiresAt:row.expires_at.toISOString()})),reviewers:reviewers.rows.map(row=>({id:row.id,name:row.name,status:row.status,createdAt:row.created_at.toISOString(),expiresAt:row.expires_at.toISOString()})),screenshots:await this.screenshots(client,sessionId)};
    });
  }
  async revokeReviewInvitation(actor:Actor,sessionId:string,id:string){
    return transaction(this.db,async client=>{
      const session=await this.host(client,actor,sessionId);
      const found=await client.query('UPDATE browser_review_invitations SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND session_id=$2',[uuid.parse(id),session.id]);
      if(!found.rowCount)throw new ApiError(404,'review_invitation_not_found','Review invitation not found.');
      await client.query("UPDATE browser_reviewers SET status='revoked' WHERE invitation_id=$1",[id]);
      await this.control(client,session,actor,'reviewer.invitation_revoked',{id});
      return {revoked:true};
    });
  }
  async decideReviewer(actor:Actor,sessionId:string,id:string,input:unknown){
    const {decision}=z.object({decision:z.enum(['admit','revoke'])}).strict().parse(input);
    return transaction(this.db,async client=>{
      const session=await this.host(client,actor,sessionId);
      const found=await client.query<ReviewerRow>(`SELECT r.* FROM browser_reviewers r JOIN browser_review_invitations i ON i.id=r.invitation_id
        WHERE r.id=$1 AND r.session_id=$2 AND r.expires_at>now() AND i.revoked_at IS NULL AND i.expires_at>now()`,[uuid.parse(id),session.id]);
      const reviewer=found.rows[0];
      if(!reviewer)throw unavailable();
      if(decision==='admit'&&reviewer.status==='revoked')throw unavailable();
      const status=decision==='admit'?'admitted':'revoked';
      if(reviewer.status===status)return {id,status};
      await client.query('UPDATE browser_reviewers SET status=$2 WHERE id=$1',[id,status]);
      if(decision==='revoke')await this.control(client,session,actor,'reviewer.revoked',{reviewerId:id,reviewerName:reviewer.name});
      else await this.append(client,session,actor,'reviewer.admitted',{reviewerId:id,reviewerName:reviewer.name});
      return {id,status};
    });
  }
  async join(input:unknown){
    const body=z.object({invitationToken:secret,credential:secret,requestId:uuid,name:text(60)}).strict().parse(input);
    const fingerprint=hash(JSON.stringify({name:body.name,credential:hash(body.credential)}));
    return transaction(this.db,async client=>{
      const initial=await client.query<{session_id:string}>('SELECT session_id FROM browser_review_invitations WHERE token_hash=$1',[hash(body.invitationToken)]);
      if(!initial.rows[0])throw unavailable();
      const session=await this.session(client,initial.rows[0].session_id);
      const invitation=await client.query<{id:string;expires_at:Date}>('SELECT id,expires_at FROM browser_review_invitations WHERE token_hash=$1 AND revoked_at IS NULL AND expires_at>now()',[hash(body.invitationToken)]);
      const invite=invitation.rows[0];if(!invite)throw unavailable();
      const previous=await client.query<{id:string;status:string;fingerprint:string;expires_at:Date}>('SELECT id,status,fingerprint,expires_at FROM browser_reviewers WHERE invitation_id=$1 AND request_id=$2',[invite.id,body.requestId]);
      if(previous.rows[0]){
        const prior=previous.rows[0];
        if(prior.fingerprint!==fingerprint)throw new ApiError(409,'idempotency_conflict','This join retry changed.');
        if(prior.status==='revoked'||prior.expires_at.getTime()<=Date.now())throw unavailable();
        return {reviewer:{id:prior.id,status:prior.status,expiresAt:prior.expires_at.toISOString()}};
      }
      const count=await client.query<{count:number}>('SELECT count(*)::int AS count FROM browser_reviewers WHERE session_id=$1',[session.id]);
      if(count.rows[0]!.count>=200)throw new ApiError(409,'review_capacity','This session has reached its browser reviewer limit.');
      const credentialUsed=await client.query('SELECT 1 FROM browser_reviewers WHERE token_hash=$1',[hash(body.credential)]);
      if(credentialUsed.rowCount)throw new ApiError(409,'review_credential_used','Create a new browser review request.');
      const id=randomUUID(),expiresAt=new Date(Math.min(invite.expires_at.getTime(),Date.now()+86400000));
      await client.query('INSERT INTO browser_reviewers(id,session_id,invitation_id,request_id,fingerprint,name,token_hash,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',[id,session.id,invite.id,body.requestId,fingerprint,redact(body.name),hash(body.credential),expiresAt]);
      await this.appendReview(client,session,'reviewer.requested',{reviewerId:id,reviewerName:redact(body.name)});
      return {reviewer:{id,status:'pending',expiresAt:expiresAt.toISOString()}};
    });
  }
  async view(credential:string,input:unknown){
    const {after}=z.object({after:z.number().int().min(0).max(100000).default(0)}).strict().parse(input??{});
    return transaction(this.db,async client=>{
      const {session,reviewer}=await this.guest(client,credential,false);
      if(reviewer.status==='pending')return {status:'pending' as const};
      const people=await client.query<{user_id:string}>('SELECT user_id FROM session_participants WHERE session_id=$1 ORDER BY admitted_at,user_id',[session.id]);
      const labels=new Map(people.rows.map((row,index)=>[row.user_id,row.user_id===session.owner_id?'Host':`Teammate ${index+1}`]));
      const rows=await client.query<{sequence:number;type:string;actor_id:string|null;payload:unknown;created_at:Date;removed:boolean|null}>(`SELECT e.sequence,e.type,e.actor_id,e.payload,e.created_at,q.status='removed' AS removed FROM shared_events e LEFT JOIN instruction_queue q ON q.event_id=e.id
        WHERE e.session_id=$1 AND e.sequence>$2 ORDER BY e.sequence LIMIT 100`,[session.id,after]);
      const events=rows.rows.filter(row=>!row.removed).map(row=>{
        if(row.type==='reviewer.comment'){
          const p=row.payload as {text:string;reviewerName:string;reviewerKind?:string;region?:unknown;screenshotId?:string};
          return {sequence:row.sequence,at:row.created_at.toISOString(),type:row.type,who:p.reviewerKind==='participant'?p.reviewerName:`${p.reviewerName} · Browser reviewer`,data:{text:p.text,...(p.screenshotId?{screenshotId:p.screenshotId,region:p.region}:{})}} as ReplayEvent;
        }
        return replayEvent(row,id=>id?labels.get(id)??'Former teammate':null);
      }).filter((event):event is ReplayEvent=>event!==null);
      return {status:'admitted' as const,reviewer:{id:reviewer.id,name:reviewer.name,expiresAt:reviewer.expires_at.toISOString()},session:{title:session.title??'Untitled session',working:session.status==='running'},events,next:rows.rows.at(-1)?.sequence??after,done:rows.rows.length<100,acceptance:await readAcceptance(client,session),screenshots:await this.screenshots(client,session.id)};
    });
  }
  async comment(credential:string,input:unknown){
    const body=z.object({requestId:uuid,text:text(4000),screenshotId:uuid.optional(),region:regionSchema.optional()}).strict().refine(value=>Boolean(value.screenshotId)===Boolean(value.region)).parse(input);
    return transaction(this.db,async client=>{
      const {session,reviewer}=await this.guest(client,credential);
      const fingerprint=hash(JSON.stringify(body));
      const previous=await client.query<{fingerprint:string;response:{sequence:number}}>('SELECT fingerprint,response FROM browser_review_receipts WHERE reviewer_id=$1 AND request_id=$2',[reviewer.id,body.requestId]);
      if(previous.rows[0]){
        if(previous.rows[0].fingerprint!==fingerprint)throw new ApiError(409,'idempotency_conflict','This comment retry changed.');
        return previous.rows[0].response;
      }
      if(body.screenshotId){
        const image=await client.query('SELECT 1 FROM browser_review_screenshots WHERE id=$1 AND session_id=$2 AND revoked_at IS NULL',[body.screenshotId,session.id]);
        if(!image.rowCount)throw new ApiError(409,'screenshot_unavailable','That screenshot is no longer shared.');
      }
      const response=await this.appendReview(client,session,'reviewer.comment',{text:redact(body.text),reviewerId:reviewer.id,reviewerName:reviewer.name,...(body.screenshotId?{screenshotId:body.screenshotId,region:body.region}:{})});
      await client.query('INSERT INTO browser_review_receipts(reviewer_id,request_id,fingerprint,response) VALUES($1,$2,$3,$4)',[reviewer.id,body.requestId,fingerprint,JSON.stringify(response)]);
      return response;
    });
  }
  async propose(credential:string,input:unknown){
    return transaction(this.db,async client=>{
      const {session,reviewer}=await this.guest(client,credential);
      return proposeAcceptanceCriterion(client,session,{id:reviewer.id,name:reviewer.name,kind:'browser'},input);
    });
  }
  async decideEvidence(credential:string,input:unknown){
    return transaction(this.db,async client=>{
      const {session,reviewer}=await this.guest(client,credential);
      return reviewAcceptanceEvidence(client,session,{id:reviewer.id,name:reviewer.name,kind:'browser'},input);
    });
  }
  /** Admitted participants see the screenshots the host chose to share, and can mark a region on them. */
  async participantScreenshots(actor:Actor,sessionId:string){
    return transaction(this.db,async client=>{
      await assertActor(client,actor);
      const {session}=await this.authorize(client,actor,uuid.parse(sessionId));
      return {screenshots:await this.screenshots(client,session.id)};
    });
  }
  async participantComment(actor:Actor,sessionId:string,input:unknown){
    const body=z.object({requestId:uuid,text:text(4000),screenshotId:uuid,region:regionSchema}).strict().parse(input);
    return transaction(this.db,async client=>{
      await assertActor(client,actor);
      const {session,role}=await this.authorize(client,actor,uuid.parse(sessionId));
      if(role==='viewer')throw new ApiError(403,'read_only','Viewers cannot comment.');
      const previous=await client.query<{sequence:number;payload:{text:string;screenshotId:string;region:unknown}}>("SELECT sequence,payload FROM shared_events WHERE session_id=$1 AND type='reviewer.comment' AND actor_id=$2 AND payload->>'requestId'=$3",[session.id,actor.userId,body.requestId]);
      if(previous.rows[0]){
        const p=previous.rows[0].payload;
        if(p.text!==redact(body.text)||p.screenshotId!==body.screenshotId||JSON.stringify(p.region)!==JSON.stringify(body.region))throw new ApiError(409,'idempotency_conflict','This comment retry changed.');
        return {sequence:previous.rows[0].sequence};
      }
      const image=await client.query('SELECT 1 FROM browser_review_screenshots WHERE id=$1 AND session_id=$2 AND revoked_at IS NULL',[body.screenshotId,session.id]);
      if(!image.rowCount)throw new ApiError(409,'screenshot_unavailable','That screenshot is no longer shared.');
      // The same generic label everyone else sees; display names stay private.
      const name=actor.userId===session.owner_id?'Host':`Teammate ${actor.userId.replace(/-/gu,'').slice(0,4).toUpperCase()}`;
      const event=await this.append(client,session,actor,'reviewer.comment',{requestId:body.requestId,text:redact(body.text),reviewerName:name,reviewerKind:'participant',screenshotId:body.screenshotId,region:body.region});
      return {sequence:event.sequence};
    });
  }
  private async screenshots(client:PoolClient,sessionId:string){
    const rows=await client.query<{id:string;label:string;image:string;created_at:Date}>('SELECT id,label,image,created_at FROM browser_review_screenshots WHERE session_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC LIMIT 5',[sessionId]);
    return rows.rows.map(row=>({id:row.id,label:row.label,image:row.image,createdAt:row.created_at.toISOString()}));
  }
  async shareScreenshot(actor:Actor,sessionId:string,input:unknown){
    const body=z.object({image:imageSchema,label:text(120)}).strict().parse(input);
    return transaction(this.db,async client=>{
      const session=await this.host(client,actor,sessionId);
      if((await this.screenshots(client,session.id)).length>=5)throw new ApiError(409,'screenshot_capacity','Remove a shared screenshot before adding another.');
      const id=randomUUID();
      await client.query('INSERT INTO browser_review_screenshots(id,session_id,label,image) VALUES($1,$2,$3,$4)',[id,session.id,redact(body.label),body.image]);
      await this.append(client,session,actor,'reviewer.screenshot_shared',{id,label:redact(body.label)});
      return {id};
    });
  }
  async revokeScreenshot(actor:Actor,sessionId:string,id:string){
    return transaction(this.db,async client=>{
      const session=await this.host(client,actor,sessionId);
      const changed=await client.query('UPDATE browser_review_screenshots SET revoked_at=COALESCE(revoked_at,now()) WHERE id=$1 AND session_id=$2',[uuid.parse(id),session.id]);
      if(!changed.rowCount)throw new ApiError(404,'screenshot_not_found','Shared screenshot not found.');
      await this.control(client,session,actor,'reviewer.screenshot_revoked',{id});
      return {revoked:true};
    });
  }
}

const CSP="default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
export async function registerBrowserReviewRoutes(app:FastifyInstance,service:BrowserReviewService,authenticate:(request:FastifyRequest)=>Promise<Actor>,publicOrigin:string,appOrigins:string[]=[],webOrigin=publicOrigin){
  const params=(request:FastifyRequest)=>z.object({sessionId:uuid,id:uuid.optional()}).parse(request.params);
  app.get('/v1/sessions/:sessionId/reviewers',async request=>service.list(await authenticate(request),params(request).sessionId));
  app.post('/v1/sessions/:sessionId/reviewer-invitations',async(request,reply)=>reply.code(201).send(await service.createReviewInvitation(await authenticate(request),params(request).sessionId,request.body)));
  app.delete('/v1/sessions/:sessionId/reviewer-invitations/:id',async request=>{const p=params(request);return service.revokeReviewInvitation(await authenticate(request),p.sessionId,p.id!);});
  app.post('/v1/sessions/:sessionId/reviewers/:id',async request=>{const p=params(request);return service.decideReviewer(await authenticate(request),p.sessionId,p.id!,request.body);});
  app.post('/v1/sessions/:sessionId/reviewer-screenshots',{bodyLimit:120000},async(request,reply)=>reply.code(201).send(await service.shareScreenshot(await authenticate(request),params(request).sessionId,request.body)));
  app.delete('/v1/sessions/:sessionId/reviewer-screenshots/:id',async request=>{const p=params(request);return service.revokeScreenshot(await authenticate(request),p.sessionId,p.id!);});
  app.get('/v1/sessions/:sessionId/shared-screenshots',async request=>service.participantScreenshots(await authenticate(request),params(request).sessionId));
  app.post('/v1/sessions/:sessionId/screenshot-comments',async(request,reply)=>reply.code(201).send(await service.participantComment(await authenticate(request),params(request).sessionId,request.body)));
  const checkOrigin=(request:FastifyRequest)=>{
    // The served page, the browser companion (same origin) or the packaged companion app.
    if([publicOrigin,webOrigin].includes(request.headers.origin??'')){requireBrowserOrigin(request,[webOrigin,publicOrigin],false);return;}
    if(!appOrigins.includes(request.headers.origin??''))throw new ApiError(403,'review_origin_denied','Open the review invitation on this service.');
  };
  const credential=(request:FastifyRequest)=>{
    checkOrigin(request);
    const match=/^Review ([A-Za-z0-9_-]{43})$/u.exec(request.headers.authorization??'');
    if(!match)throw unavailable();
    return match[1]!;
  };
  app.post('/v1/browser-review/join',{config:{rateLimit:{max:15,timeWindow:'1 minute'}}},async request=>{checkOrigin(request);return service.join(request.body);});
  app.post('/v1/browser-review/view',{config:{rateLimit:{max:60,timeWindow:'1 minute'}}},async request=>service.view(credential(request),request.body));
  app.post('/v1/browser-review/comment',async request=>service.comment(credential(request),request.body));
  app.post('/v1/browser-review/criteria',async request=>service.propose(credential(request),request.body));
  app.post('/v1/browser-review/decision',async request=>service.decideEvidence(credential(request),request.body));
  const page=(type:string,body:string)=>async(_request:FastifyRequest,reply:import('fastify').FastifyReply)=>reply.header('Content-Security-Policy',CSP).type(type).send(body);
  app.get('/review',page('text/html; charset=utf-8',REVIEW_HTML));
  app.get('/review.js',page('text/javascript; charset=utf-8',REVIEW_JS));
  app.get('/review.css',page('text/css; charset=utf-8',REVIEW_CSS));
}
