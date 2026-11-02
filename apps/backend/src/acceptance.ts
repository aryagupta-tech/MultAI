import {createHash, randomUUID} from 'node:crypto';
import type {FastifyInstance, FastifyRequest} from 'fastify';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {CollaborationService, requireOriginalHost, type SessionRow} from './collaboration.js';
import {assertActor, transaction} from './db.js';
import {ApiError} from './errors.js';
import {redact} from './execution.js';
import type {Actor} from './types.js';

export interface AcceptanceAuthor {id:string;name:string;kind:'participant'|'browser'}
export interface AcceptanceReview {reviewerId:string;reviewerName:string;reviewerKind:'participant'|'browser';decision:'accept'|'reject';comment:string|null;createdAt:string}
export interface AcceptanceEvidence {id:string;criterionVersion:number;revision:string;kind:'command'|'manual';command:string|null;exitCode:number|null;output:string;timedOut:boolean;canceled:boolean;durationMs:number|null;createdAt:string;reviews:AcceptanceReview[]}
export interface AcceptanceCriterion {id:string;text:string;checkCommand:string|null;version:number;state:'proposed'|'approved'|'withdrawn';authorId:string;authorName:string;authorKind:'participant'|'browser';status:'proposed'|'needs_review'|'passed'|'failed'|'stale';evidence:AcceptanceEvidence|null}
export interface AcceptanceSnapshot {revision:string|null;criteria:AcceptanceCriterion[]}
interface CriterionRow {id:string;session_id:string;author_id:string;author_name:string;author_kind:'participant'|'browser';text:string;check_command:string|null;version:number;state:'proposed'|'approved'|'withdrawn'}
interface EvidenceRow {id:string;criterion_id:string;criterion_version:number;revision:string;kind:'command'|'manual';command:string|null;exit_code:number|null;output:string;timed_out:boolean;canceled:boolean;duration_ms:number|null;created_at:Date}
interface ReviewRow {evidence_id:string;reviewer_id:string;reviewer_name:string;reviewer_kind:'participant'|'browser';decision:'accept'|'reject';comment:string|null;created_at:Date}
const uuid=z.uuid();
const revisionSchema=z.string().regex(/^[a-f0-9]{64}$/u);
const text=(max:number)=>z.string().trim().min(1).max(max).refine(s=>!/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(s));
// Preserve command bytes. The host approves this exact command before any verification execution.
const commandSchema=z.string().min(1).max(2000).refine(s=>Boolean(s.trim())&&!/[\u0000\u000b\u000c]/u.test(s));
const proposeSchema=z.object({requestId:uuid,text:text(2000),checkCommand:commandSchema.nullable().optional()}).strict();
const reviewSchema=z.object({requestId:uuid,criterionId:uuid,criterionVersion:z.number().int().positive(),evidenceId:uuid,revision:revisionSchema,decision:z.enum(['accept','reject']),comment:text(2000).optional()}).strict();
const hash=(value:unknown)=>createHash('sha256').update(JSON.stringify(value)).digest('hex');

function inactive(session:SessionRow){if(session.status==='running')throw new ApiError(409,'session_active','Stop the run before changing requirements or reviewing evidence.');}
/** These helpers are internal service functions. Callers must hold the session row lock and have
 * revalidated an admitted native participant or browser guest in the SAME transaction. */
async function event(client:PoolClient,session:SessionRow,author:AcceptanceAuthor,type:string,payload:unknown){
  if(session.event_sequence>=99744)throw new ApiError(409,'session_capacity','This session has reached its event capacity.');
  const sequence=++session.event_sequence;
  await client.query('INSERT INTO shared_events(id,session_id,sequence,type,actor_id,payload) VALUES($1,$2,$3,$4,$5,$6)',[randomUUID(),session.id,sequence,type,author.kind==='participant'?author.id:null,JSON.stringify({...payload as object,authorId:author.id,authorName:redact(author.name).slice(0,120),authorKind:author.kind})]);
  await client.query('UPDATE sessions SET event_sequence=$2,updated_at=now() WHERE id=$1',[session.id,sequence]);
}
async function retry<T>(client:PoolClient,session:SessionRow,author:AcceptanceAuthor,requestId:string,operation:string,body:unknown,perform:()=>Promise<T>):Promise<T>{
  const key=`${author.kind}:${author.id}`,fingerprint=hash({sessionId:session.id,operation,body});
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',[`acceptance:${key}:${requestId}`]);
  const prior=await client.query<{fingerprint:string;response:T}>('SELECT fingerprint,response FROM acceptance_requests WHERE actor_key=$1 AND request_id=$2',[key,requestId]);
  if(prior.rows[0]){
    if(prior.rows[0].fingerprint!==fingerprint)throw new ApiError(409,'idempotency_conflict','This retry identity was already used for different content.');
    return prior.rows[0].response;
  }
  const result=await perform();
  await client.query('INSERT INTO acceptance_requests(actor_key,request_id,session_id,fingerprint,response) VALUES($1,$2,$3,$4,$5)',[key,requestId,session.id,fingerprint,JSON.stringify(result)]);
  return result;
}
async function criterion(client:PoolClient,session:SessionRow,id:string,version:number){
  const found=await client.query<CriterionRow>('SELECT * FROM acceptance_criteria WHERE id=$1 AND session_id=$2',[id,session.id]);
  const row=found.rows[0];
  if(!row)throw new ApiError(404,'criterion_not_found','This requirement is not available.');
  if(row.version!==version)throw new ApiError(409,'stale_criterion','The requirement changed. Refresh before continuing.');
  return row;
}
async function currentRevision(client:PoolClient,sessionId:string){
  const found=await client.query<{revision:string|null}>('SELECT revision FROM acceptance_workspaces WHERE session_id=$1',[sessionId]);
  return found.rows[0]?.revision??null;
}
/** Requires an already locked, authorized session. No commands or private host paths are read here. */
export async function readAcceptance(client:PoolClient,session:SessionRow):Promise<AcceptanceSnapshot>{
  const revision=await currentRevision(client,session.id);
  const criteria=await client.query<CriterionRow>('SELECT * FROM acceptance_criteria WHERE session_id=$1 ORDER BY created_at,id',[session.id]);
  const evidence=await client.query<EvidenceRow>(`SELECT DISTINCT ON (criterion_id) * FROM acceptance_evidence WHERE session_id=$1 ORDER BY criterion_id,sequence DESC`,[session.id]);
  const reviews=evidence.rows.length?await client.query<ReviewRow>('SELECT * FROM acceptance_reviews WHERE evidence_id=ANY($1::uuid[]) ORDER BY created_at,reviewer_id',[evidence.rows.map(row=>row.id)]):{rows:[]};
  return {revision,criteria:criteria.rows.map(row=>{
    const found=evidence.rows.find(item=>item.criterion_id===row.id);
    const proof:AcceptanceEvidence|null=found?{id:found.id,criterionVersion:found.criterion_version,revision:found.revision,kind:found.kind,command:found.command,exitCode:found.exit_code,output:found.output,timedOut:found.timed_out,canceled:found.canceled,durationMs:found.duration_ms,createdAt:found.created_at.toISOString(),reviews:reviews.rows.filter(item=>item.evidence_id===found.id).map(item=>({reviewerId:item.reviewer_id,reviewerName:item.reviewer_name,reviewerKind:item.reviewer_kind,decision:item.decision,comment:item.comment,createdAt:item.created_at.toISOString()}))}:null;
    let status:AcceptanceCriterion['status']=row.state==='approved'?'needs_review':'proposed';
    if(proof){
      if(session.status==='running'||row.state!=='approved'||proof.criterionVersion!==row.version||proof.revision!==revision)status='stale';
      else if(proof.kind==='command')status=proof.exitCode===0&&!proof.timedOut&&!proof.canceled?'passed':'failed';
      else status='needs_review';
    }
    return {id:row.id,text:row.text,checkCommand:row.check_command,version:row.version,state:row.state,authorId:row.author_id,authorName:row.author_name,authorKind:row.author_kind,status,evidence:proof};
  })};
}
/** Caller validates guest/native authority and locks the session before calling. */
export async function proposeAcceptanceCriterion(client:PoolClient,session:SessionRow,author:AcceptanceAuthor,input:unknown){
  const body=proposeSchema.parse(input);
  return retry(client,session,author,body.requestId,'propose',body,async()=>{
    const count=await client.query<{count:number}>('SELECT count(*)::int AS count FROM acceptance_criteria WHERE session_id=$1',[session.id]);
    if(count.rows[0]!.count>=100)throw new ApiError(409,'criteria_capacity','This session has reached its requirement limit.');
    const id=randomUUID(),cleanText=redact(body.text);
    // Never silently rewrite a command: a redaction would change the thing the host approved.
    if(body.checkCommand&&redact(body.checkCommand)!==body.checkCommand)throw new ApiError(400,'secret_in_command','Remove credentials from the verification command.');
    await client.query('INSERT INTO acceptance_criteria(id,session_id,author_id,author_kind,author_name,text,check_command) VALUES($1,$2,$3,$4,$5,$6,$7)',[id,session.id,author.id,author.kind,redact(author.name).slice(0,120),cleanText,body.checkCommand??null]);
    await event(client,session,author,'acceptance.proposed',{criterionId:id,text:cleanText,version:1});
    return {id,version:1};
  });
}
/** Accept/reject is human judgment, never a replacement for a process exit status. */
export async function reviewAcceptanceEvidence(client:PoolClient,session:SessionRow,author:AcceptanceAuthor,input:unknown){
  const body=reviewSchema.parse(input);
  inactive(session);
  return retry(client,session,author,body.requestId,'review',body,async()=>{
    const row=await criterion(client,session,body.criterionId,body.criterionVersion);
    if(row.state!=='approved'||await currentRevision(client,session.id)!==body.revision)throw new ApiError(409,'stale_evidence','The code or requirement changed. Verify the current version before reviewing.');
    const proof=await client.query<EvidenceRow>('SELECT * FROM acceptance_evidence WHERE criterion_id=$1 AND session_id=$2 ORDER BY sequence DESC LIMIT 1',[row.id,session.id]);
    const found=proof.rows[0];
    if(!found||found.id!==body.evidenceId||found.criterion_version!==row.version||found.revision!==body.revision)throw new ApiError(409,'stale_evidence','New evidence is available. Refresh before reviewing.');
    await client.query(`INSERT INTO acceptance_reviews(evidence_id,reviewer_id,reviewer_kind,reviewer_name,decision,comment) VALUES($1,$2,$3,$4,$5,$6)
      ON CONFLICT(evidence_id,reviewer_kind,reviewer_id) DO UPDATE SET decision=EXCLUDED.decision,comment=EXCLUDED.comment,created_at=now()`,[found.id,author.id,author.kind,redact(author.name).slice(0,120),body.decision,body.comment?redact(body.comment):null]);
    await event(client,session,author,'acceptance.reviewed',{criterionId:row.id,criterionVersion:row.version,evidenceId:found.id,revision:body.revision,decision:body.decision,...(body.comment?{comment:redact(body.comment)}:{})});
    return {reviewed:true};
  });
}

export class AcceptanceService extends CollaborationService {
  private async authorized(client:PoolClient,actor:Actor,sessionId:string,write=false,host=false){
    await assertActor(client,actor);
    const authorized=await this.authorize(client,actor,uuid.parse(sessionId));
    if(write&&authorized.role==='viewer')throw new ApiError(403,'read_only','Viewers cannot change requirements or reviews.');
    if(host)requireOriginalHost(authorized,actor);
    const user=await client.query<{display_name:string}>('SELECT display_name FROM users WHERE id=$1',[actor.userId]);
    return {...authorized,author:{id:actor.userId,name:user.rows[0]?.display_name??'Participant',kind:'participant' as const}};
  }
  async list(actor:Actor,sessionId:string){return transaction(this.db,async client=>{const {session}=await this.authorized(client,actor,sessionId);return readAcceptance(client,session);});}
  async propose(actor:Actor,sessionId:string,input:unknown){return transaction(this.db,async client=>{const {session,author}=await this.authorized(client,actor,sessionId,true);return proposeAcceptanceCriterion(client,session,author,input);});}
  async approve(actor:Actor,sessionId:string,criterionId:string,input:unknown){
    const body=z.object({requestId:uuid,expectedVersion:z.number().int().positive()}).strict().parse(input);uuid.parse(criterionId);
    return transaction(this.db,async client=>{
      const {session,author}=await this.authorized(client,actor,sessionId,true,true);inactive(session);
      return retry(client,session,author,body.requestId,'approve',{criterionId,...body},async()=>{
        const row=await criterion(client,session,criterionId,body.expectedVersion);
        if(row.state!=='proposed')throw new ApiError(409,'criterion_state','Only proposed requirements can be approved.');
        await client.query("UPDATE acceptance_criteria SET state='approved',updated_at=now() WHERE id=$1",[row.id]);
        await event(client,session,author,'acceptance.approved',{criterionId:row.id,version:row.version,text:row.text});
        return {id:row.id,version:row.version};
      });
    });
  }
  async revise(actor:Actor,sessionId:string,criterionId:string,input:unknown){
    const body=z.object({requestId:uuid,expectedVersion:z.number().int().positive(),text:text(2000),checkCommand:commandSchema.nullable().optional(),withdraw:z.boolean().optional()}).strict().parse(input);uuid.parse(criterionId);
    return transaction(this.db,async client=>{
      const {session,author}=await this.authorized(client,actor,sessionId,true,true);inactive(session);
      return retry(client,session,author,body.requestId,'revise',{criterionId,...body},async()=>{
        const row=await criterion(client,session,criterionId,body.expectedVersion);
        if(body.checkCommand&&redact(body.checkCommand)!==body.checkCommand)throw new ApiError(400,'secret_in_command','Remove credentials from the verification command.');
        const version=row.version+1,state=body.withdraw?'withdrawn':'proposed';
        await client.query('UPDATE acceptance_criteria SET text=$2,check_command=$3,version=$4,state=$5,updated_at=now() WHERE id=$1',[row.id,redact(body.text),body.checkCommand===undefined?row.check_command:body.checkCommand,version,state]);
        await event(client,session,author,'acceptance.revised',{criterionId:row.id,text:redact(body.text),version,state});
        return {id:row.id,version};
      });
    });
  }
  async revision(actor:Actor,sessionId:string,input:unknown){
    const body=z.object({requestId:uuid,revision:revisionSchema.nullable()}).strict().parse(input);
    return transaction(this.db,async client=>{
      const {session,author}=await this.authorized(client,actor,sessionId,true,true);
      return retry(client,session,author,body.requestId,'revision',body,async()=>{
        const previous=await currentRevision(client,session.id);
        await client.query('INSERT INTO acceptance_workspaces(session_id,revision) VALUES($1,$2) ON CONFLICT(session_id) DO UPDATE SET revision=EXCLUDED.revision,updated_at=now()',[session.id,body.revision]);
        if(previous!==body.revision)await event(client,session,author,'acceptance.revision',{revision:body.revision});
        return {revision:body.revision};
      });
    });
  }
  async evidence(actor:Actor,sessionId:string,input:unknown){
    const body=z.object({requestId:uuid,criterionId:uuid,criterionVersion:z.number().int().positive(),revision:revisionSchema,kind:z.enum(['command','manual']),command:commandSchema.optional(),exitCode:z.number().int().min(-2147483648).max(2147483647).nullable().optional(),output:z.string().max(6000).refine(value=>!value.includes('\0')),timedOut:z.boolean().default(false),canceled:z.boolean().default(false),durationMs:z.number().int().nonnegative().max(2147483647).optional()}).strict().superRefine((v,ctx)=>{
      if(v.kind==='command'&&(!v.command||v.exitCode===undefined))ctx.addIssue({code:'custom',message:'Command evidence needs exact command and actual exit code.'});
      if(v.kind==='manual'&&(v.command!==undefined||v.exitCode!==undefined||v.timedOut||v.canceled))ctx.addIssue({code:'custom',message:'Manual evidence cannot claim a process result.'});
    }).parse(input);
    return transaction(this.db,async client=>{
      const {session,author}=await this.authorized(client,actor,sessionId,true,true);inactive(session);
      return retry(client,session,author,body.requestId,'evidence',body,async()=>{
        const row=await criterion(client,session,body.criterionId,body.criterionVersion);
        if(row.state!=='approved')throw new ApiError(409,'criterion_not_approved','The host must approve this requirement before verification.');
        if(await currentRevision(client,session.id)!==body.revision)throw new ApiError(409,'stale_evidence','The workspace revision changed. Run the check again.');
        if(body.kind==='command'&&(!row.check_command||body.command!==row.check_command))throw new ApiError(409,'check_command_mismatch','Run the exact command approved for this requirement.');
        const count=await client.query<{count:number}>('SELECT count(*)::int AS count FROM acceptance_evidence WHERE session_id=$1',[session.id]);
        if(count.rows[0]!.count>=2000)throw new ApiError(409,'evidence_capacity','This session has reached its evidence limit.');
        const id=randomUUID();
        await client.query('INSERT INTO acceptance_evidence(id,session_id,criterion_id,criterion_version,revision,kind,command,exit_code,output,timed_out,canceled,duration_ms,host_id,sequence) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)',[id,session.id,row.id,row.version,body.revision,body.kind,body.command??null,body.exitCode??null,redact(body.output),body.timedOut,body.canceled,body.durationMs??null,actor.userId,session.event_sequence+1]);
        const status=body.kind==='manual'?'needs_review':body.exitCode===0&&!body.timedOut&&!body.canceled?'passed':'failed';
        await event(client,session,author,'acceptance.evidence',{criterionId:row.id,criterionVersion:row.version,evidenceId:id,revision:body.revision,status,kind:body.kind,exitCode:body.exitCode??null});
        return {id,status};
      });
    });
  }
  async review(actor:Actor,sessionId:string,input:unknown){return transaction(this.db,async client=>{const {session,author}=await this.authorized(client,actor,sessionId,true);return reviewAcceptanceEvidence(client,session,author,input);});}
}
export async function registerAcceptanceRoutes(app:FastifyInstance,service:AcceptanceService,authenticate:(request:FastifyRequest)=>Promise<Actor>){
  const params=(request:FastifyRequest)=>z.object({sessionId:uuid,criterionId:uuid.optional()}).parse(request.params);
  const base='/v1/sessions/:sessionId/acceptance';
  app.get(base,async request=>service.list(await authenticate(request),params(request).sessionId));
  app.post(`${base}/criteria`,async request=>service.propose(await authenticate(request),params(request).sessionId,request.body));
  app.post(`${base}/criteria/:criterionId/approve`,async request=>{const p=params(request);return service.approve(await authenticate(request),p.sessionId,p.criterionId!,request.body);});
  app.post(`${base}/criteria/:criterionId/revise`,async request=>{const p=params(request);return service.revise(await authenticate(request),p.sessionId,p.criterionId!,request.body);});
  app.post(`${base}/revision`,async request=>service.revision(await authenticate(request),params(request).sessionId,request.body));
  app.post(`${base}/evidence`,async request=>service.evidence(await authenticate(request),params(request).sessionId,request.body));
  app.post(`${base}/reviews`,async request=>service.review(await authenticate(request),params(request).sessionId,request.body));
}
