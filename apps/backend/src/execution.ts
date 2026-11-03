import {createHash, randomUUID, timingSafeEqual} from 'node:crypto';
import {posix,win32} from 'node:path';
import type {FastifyInstance, FastifyRequest} from 'fastify';
import type {PoolClient} from 'pg';
import {z} from 'zod';
import {CollaborationService, requireOriginalHost, type SessionRow} from './collaboration.js';
import {assertActor, transaction, type Database} from './db.js';
import {ApiError} from './errors.js';
import type {Actor} from './types.js';

const uuid = z.uuid();
const leaseSchema = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
const text = (limit: number) => z.string().trim().min(1).max(limit).refine(s => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(s));
const exactText = (limit:number) => z.string().min(1).max(limit).refine(s=>!/[\u0000-\u001f\u007f]/u.test(s));
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const stable = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stable((value as Record<string,unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
};
const hash = (value: unknown) => digest(stable(value));
const equal = (a: string,b: string) => a.length === b.length && timingSafeEqual(Buffer.from(a),Buffer.from(b));
export function redact(value: string): string {
  return value.replace(/\b(?:sk-(?:ant-)?[A-Za-z0-9_-]{12,}|AKIA[A-Z0-9]{16}|Bearer\s+[A-Za-z0-9._~-]{12,})\b/gu, '[REDACTED]');
}
export interface PendingDirection {id:string;authorId:string;authorName:string;text:string;revision:number}
interface RunRow {
  id: string; session_id: string; request_id: string; fingerprint: string; owner_id: string; device_id: string;
  auth_session_id: string; instruction_id: string; connection_id: string; model: string; generation: number;
  service_epoch: string; lease_hash: string; lease_expires_at: Date; status: string;
}
const operation = z.discriminatedUnion('kind',[
  z.object({kind:z.literal('shell'),executable:exactText(4096),argv:z.array(z.string().max(16384)).max(256),commandText:z.string().max(32768).nullable()}).strict(),
  z.object({kind:z.literal('external'),tool:exactText(512),transport:z.enum(['stdio','https']),arguments:z.json()}).strict(),
  z.object({kind:z.literal('file_write'),relativePath:exactText(4096),expectedContentHash:z.string().regex(/^[a-f0-9]{64}$/).nullable(),contentHash:z.string().regex(/^[a-f0-9]{64}$/)}).strict(),
]);
/** A parallel agent's worktree counts as its run's workspace. */
export const workspaceOf=(cwd:string)=>cwd.replace(/\.lane-[1-4]-[0-9a-f]{8}$/u,'');
const descriptorSchema = z.object({
  version:z.literal(1),requestId:uuid,sessionId:uuid,originalOwnerId:uuid,originalDeviceId:uuid,
  accountGeneration:z.number().int().positive(),sessionGeneration:z.number().int().positive(),runtimeGeneration:z.number().int().positive(),
  connectionId:uuid,payerId:uuid,resourceIdentity:exactText(512),cwd:exactText(4096),expiresAt:z.number().int().positive(),operation,
}).strict();

function pathFlavor(value:string):'posix'|'win32'|undefined {
  if(value.includes('\0')) return undefined;
  if(posix.isAbsolute(value)&&posix.normalize(value)===value&&!value.includes('\\')) return 'posix';
  if(win32.isAbsolute(value)&&win32.normalize(value)===value) return 'win32';
  return undefined;
}

/** Independent lexical checks; only the native host can resolve actual filesystem paths. */
function validateActionDescriptor(descriptor:z.infer<typeof descriptorSchema>,sessionId:string):void {
  const flavor=pathFlavor(descriptor.cwd);
  if(!flavor) throw new ApiError(400,'invalid_action_path','The action working directory must be an absolute normalized native path.');
  if(descriptor.resourceIdentity!==`workspace:${sessionId}`) throw new ApiError(409,'stale_action','The action resource must identify this session workspace.');
  if(descriptor.operation.kind==='shell'){
    if(pathFlavor(descriptor.operation.executable)!==flavor) throw new ApiError(400,'invalid_action_path','The executable must be an absolute normalized path on the same native platform.');
    if(descriptor.operation.argv.some(argument=>argument.includes('\0'))||descriptor.operation.commandText?.includes('\0')) throw new ApiError(400,'invalid_action_arguments','Executable arguments and shell text cannot contain NUL bytes.');
  }
  if(descriptor.operation.kind==='file_write'){
    const relative=descriptor.operation.relativePath;
    if(posix.isAbsolute(relative)||win32.isAbsolute(relative)||relative.includes('\\')||relative.includes(':')||relative.split('/').some(part=>part===''||part==='.'||part==='..')) throw new ApiError(400,'invalid_action_path','A write must use a bounded relative workspace path without traversal.');
  }
}

export async function pendingDirections(client:PoolClient,sessionId:string):Promise<PendingDirection[]>{
  const result=await client.query<{id:string;author_id:string;author_name:string;text:string;revision:number}>(`SELECT q.id,q.author_id,u.display_name AS author_name,e.payload->>'text' AS text,q.revision
    FROM instruction_queue q JOIN shared_events e ON e.id=q.event_id JOIN users u ON u.id=q.author_id
    WHERE q.session_id=$1 AND q.status='pending' ORDER BY q.created_at,q.id`,[sessionId]);
  return result.rows.map(row=>({id:row.id,authorId:row.author_id,authorName:row.author_name,text:row.text,revision:row.revision}));
}
export function directionFingerprint(sessionId:string,pending:PendingDirection[]):string {
  return hash({sessionId,pending:pending.map(({id,authorId,revision})=>({id,authorId,revision}))});
}
export async function priorSteeringConflict(client:PoolClient,sessionId:string){
  const prior=await client.query<{id:string;author_id:string;author_name:string;text:string}>(`SELECT q.id,COALESCE(d.actor_id,q.author_id) AS author_id,u.display_name AS author_name,COALESCE(d.payload->>'text',e.payload->>'text') AS text
    FROM execution_runs r JOIN instruction_queue q ON q.id=r.instruction_id AND q.session_id=r.session_id JOIN shared_events e ON e.id=q.event_id
    LEFT JOIN shared_events d ON d.session_id=r.session_id AND d.type='decision.saved' AND d.payload->>'source'='instruction_resolution' AND d.payload->>'runId'=r.id::text
    JOIN users u ON u.id=COALESCE(d.actor_id,q.author_id)
    WHERE r.session_id=$1 ORDER BY r.created_at DESC,r.id DESC LIMIT 1`,[sessionId]);
  const previous=prior.rows[0];if(!previous)return undefined;
  const different=await client.query("SELECT 1 FROM instruction_queue WHERE session_id=$1 AND status='pending' AND steer AND author_id<>$2 LIMIT 1",[sessionId,previous.author_id]);
  return different.rowCount?{id:previous.id,authorId:previous.author_id,authorName:previous.author_name,text:previous.text}:undefined;
}

/** Holds authority only; provider credentials and all actual effects remain on the original host. */
export class ExecutionService extends CollaborationService {
  private readonly epoch = randomUUID();
  private guard: PoolClient | undefined;
  constructor(db:Database){super(db);}

  async startup():Promise<void> {
    const guard=await this.db.connect();
    try {
      const lock=await guard.query<{acquired:boolean}>("SELECT pg_try_advisory_lock(hashtextextended(current_database()||current_schema()||':multai.service',0)) AS acquired");
      if (!lock.rows[0]?.acquired) throw new Error('A service already owns this database.');
      this.guard=guard;
      guard.on('error',()=>{if(this.guard===guard){this.guard=undefined;guard.release(true);}});
      await transaction(this.db,async client=>{
        await client.query("UPDATE execution_actions SET status=CASE WHEN status='consumed' THEN 'uncertain' ELSE 'canceled' END WHERE status IN ('pending','approved','consumed')");
        await client.query("UPDATE execution_runs SET status='uncertain',finished_at=now() WHERE status='running'");
        await client.query("UPDATE sessions SET status='paused',runtime_generation=runtime_generation+1 WHERE status='running'");
      });
    }catch(error){this.guard=undefined;guard.release();throw error;}
  }
  async close():Promise<void>{
    if(this.guard){await this.guard.query('SELECT pg_advisory_unlock_all()');this.guard.release();this.guard=undefined;}
  }
  private async host(client:PoolClient,actor:Actor,sessionId:string){
    if(!this.guard) throw new ApiError(503,'execution_unavailable','Service authority was interrupted. Restart the service before resuming.');
    await assertActor(client,actor);
    const authorized=await this.authorize(client,actor,uuid.parse(sessionId));
    requireOriginalHost(authorized,actor);
    return authorized.session;
  }
  private async fence(client:PoolClient,session:SessionRow,status:'stopped'|'uncertain'){
    const uncertain=await client.query("SELECT 1 FROM execution_actions a JOIN execution_runs r ON r.id=a.run_id WHERE r.session_id=$1 AND a.status IN ('consumed','uncertain') LIMIT 1",[session.id]);
    await client.query("UPDATE execution_actions SET status=CASE WHEN status='consumed' THEN 'uncertain' ELSE 'canceled' END WHERE run_id IN (SELECT id FROM execution_runs WHERE session_id=$1 AND status='running') AND status IN ('pending','approved','consumed')",[session.id]);
    await client.query("UPDATE execution_runs SET status=$2,finished_at=now() WHERE session_id=$1 AND status='running'",[session.id,status]);
    // Stop invalidates what a paired phone asked for but the host has not acknowledged yet.
    await client.query("UPDATE control_requests SET status='canceled',result_code='run_stopped' WHERE session_id=$1 AND status IN ('pending','delivered')",[session.id]);
    session.runtime_generation++;
    session.status=status==='uncertain'||uncertain.rowCount?'paused':'inactive';
    await client.query('UPDATE sessions SET status=$2,runtime_generation=$3 WHERE id=$1',[session.id,session.status,session.runtime_generation]);
  }
  /** Safety transitions must commit even after retained conversation capacity is exhausted. */
  private async controlAppend(client:PoolClient,session:SessionRow,actor:Actor,type:string,payload:unknown){
    try {await this.append(client,session,actor,type,payload);}
    catch(error){if(!(error instanceof ApiError&&error.code==='session_capacity')) throw error;}
  }
  private async active(client:PoolClient,actor:Actor,sessionId:string,runId:string,leaseToken:string){
    const session=await this.host(client,actor,sessionId);
    const result=await client.query<RunRow>('SELECT * FROM execution_runs WHERE id=$1 AND session_id=$2 FOR UPDATE',[uuid.parse(runId),sessionId]);
    const run=result.rows[0];
    if(!run || run.owner_id!==actor.userId || run.device_id!==actor.deviceId || run.auth_session_id!==actor.authSessionId || !equal(run.lease_hash,digest(leaseSchema.parse(leaseToken)))) throw new ApiError(403,'execution_denied','This host does not own the execution lease.');
    if(run.status!=='running' || session.status!=='running' || run.generation!==session.runtime_generation || run.service_epoch!==this.epoch) throw new ApiError(409,'stale_execution','This execution has stopped or its authority changed.');
    if(run.lease_expires_at.getTime()<=Date.now()) throw new ApiError(409,'lease_expired','The host lease expired. Resume explicitly after reviewing interrupted work.');
    return {session,run};
  }
  /** Read the complete queue under the same authority lock used when the host commits a decision. */
  async conflictContext(actor:Actor,sessionId:string){
    return transaction(this.db,async client=>{
      const session=await this.host(client,actor,sessionId);
      const pending=await pendingDirections(client,session.id);
      if(pending.length>100||pending.reduce((sum,row)=>sum+Buffer.byteLength(row.text),0)>160_000)throw new ApiError(409,'conflict_context_capacity','Review or remove queued directions before comparing them; no direction can be silently omitted.');
      const previousDirection=await priorSteeringConflict(client,session.id);
      return {fingerprint:directionFingerprint(session.id,pending),pending,requiresReview:new Set(pending.map(row=>row.authorId)).size>1||Boolean(previousDirection),...(previousDirection?{previousDirection}:{})};
    });
  }
  async startRun(actor:Actor,sessionId:string,input:unknown){
    const body=z.object({requestId:uuid,connectionId:uuid,model:text(200),instructionId:uuid,leaseToken:leaseSchema,expectedGeneration:z.number().int().positive(),resume:z.boolean().default(false),resolution:text(8000).optional(),resolutionFingerprint:z.string().regex(/^[a-f0-9]{64}$/).optional()}).strict().refine(body=>Boolean(body.resolution)===Boolean(body.resolutionFingerprint),{message:'A resolution and its queue fingerprint are required together.'}).parse(input);
    const fingerprint=hash({...body,leaseToken:digest(body.leaseToken),sessionId,deviceId:actor.deviceId});
    return transaction(this.db,async client=>{
      const session=await this.host(client,actor,sessionId);
      const previous=await client.query<RunRow>('SELECT * FROM execution_runs WHERE owner_id=$1 AND request_id=$2',[actor.userId,body.requestId]);
      if(previous.rows[0]){
        if(previous.rows[0].fingerprint!==fingerprint) throw new ApiError(409,'idempotency_conflict','This run retry belongs to different input.');
        const {run}=await this.active(client,actor,sessionId,previous.rows[0].id,body.leaseToken);
        return this.runContext(client,session,run);
      }
      if(session.runtime_generation!==body.expectedGeneration) throw new ApiError(409,'stale_generation','Refresh the session before starting.');
      if(session.status==='running'){
        const current=await client.query<RunRow>("SELECT * FROM execution_runs WHERE session_id=$1 AND status='running'",[session.id]);
        if(!body.resume || (current.rows[0]?.lease_expires_at.getTime()??0)>Date.now()) throw new ApiError(409,'session_active','One executor already owns this session.');
        await this.fence(client,session,'uncertain');
      }
      if(session.status==='paused'&&!body.resume) throw new ApiError(409,'resume_required','Review interrupted work and explicitly Resume.');
      const pending=await pendingDirections(client,session.id);
      if(!pending.some(row=>row.id===body.instructionId)) throw new ApiError(409,'instruction_unavailable','Choose a pending instruction. Completed instructions are never replayed.');
      const authors=new Set(pending.map(row=>row.authorId));
      if((authors.size>1||await priorSteeringConflict(client,session.id)) && !body.resolution) throw new ApiError(409,'instruction_conflict','Several authors have pending directions. Record an owner decision before continuing.');
      const id=randomUUID();
      if(body.resolution){
        if(body.resolutionFingerprint!==directionFingerprint(session.id,pending))throw new ApiError(409,'stale_resolution','The pending directions changed. Review them again before deciding.');
        await client.query("UPDATE acceptance_criteria SET version=version+1,updated_at=now() WHERE session_id=$1 AND state='approved'",[session.id]);
        const decisionId=randomUUID();
        await client.query('INSERT INTO decisions(id,session_id,author_id,text) VALUES($1,$2,$3,$4)',[decisionId,session.id,actor.userId,redact(body.resolution)]);
        await this.append(client,session,actor,'decision.saved',{id:decisionId,text:redact(body.resolution),authorId:actor.userId,source:'instruction_resolution',runId:id,queueFingerprint:body.resolutionFingerprint,instructionIds:pending.map(row=>row.id),selectedInstructionId:body.instructionId});
        // One host-authored direction replaces the reviewed queue. Unchosen messages must never run later.
        for(const row of pending){
          if(row.id===body.instructionId)continue;
          await client.query("UPDATE instruction_queue SET status='removed',revision=revision+1 WHERE id=$1",[row.id]);
          await this.append(client,session,actor,'instruction.removed',{instructionId:row.id,reason:'host_resolution',decisionId});
        }
      }
      await client.query('UPDATE acceptance_workspaces SET revision=NULL,updated_at=now() WHERE session_id=$1',[session.id]);
      session.runtime_generation++;
      session.status='running';
      await client.query("UPDATE sessions SET status='running',runtime_generation=$2 WHERE id=$1",[session.id,session.runtime_generation]);
      const result=await client.query<RunRow>(`INSERT INTO execution_runs(id,session_id,request_id,fingerprint,owner_id,device_id,auth_session_id,instruction_id,connection_id,model,generation,service_epoch,lease_hash,lease_expires_at,status)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,now()+interval '30 seconds','running') RETURNING *`,
      [id,session.id,body.requestId,fingerprint,actor.userId,actor.deviceId,actor.authSessionId,body.instructionId,body.connectionId,body.model,session.runtime_generation,this.epoch,digest(body.leaseToken)]);
      await client.query("UPDATE instruction_queue SET status='applied',revision=revision+1 WHERE id=$1",[body.instructionId]);
      await this.append(client,session,actor,'run.started',{runId:id,instructionId:body.instructionId,model:body.model,runtimeGeneration:session.runtime_generation});
      return this.runContext(client,session,result.rows[0]!);
    });
  }
  private async runContext(client:PoolClient,session:SessionRow,run:RunRow){
    const selected=await client.query<{id:string;author_id:string;text:string;image:string|null}>("SELECT q.id,q.author_id,e.payload->>'text' AS text,e.payload->>'image' AS image FROM instruction_queue q JOIN shared_events e ON e.id=q.event_id WHERE q.id=$1 AND q.session_id=$2",[run.instruction_id,session.id]);
    if(!selected.rows[0]) throw new ApiError(409,'instruction_unavailable','The selected instruction is no longer available.');
    const resolution=await client.query<{text:string;actor_id:string}>("SELECT payload->>'text' AS text,actor_id FROM shared_events WHERE session_id=$1 AND type='decision.saved' AND payload->>'runId'=$2 AND payload->>'source'='instruction_resolution' LIMIT 1",[session.id,run.id]);
    const events=await client.query<{type:string;payload:{text?:string;reviewerName?:string};actor_id:string|null}>(`SELECT e.type,e.payload,e.actor_id FROM shared_events e
      LEFT JOIN instruction_queue q ON q.event_id=e.id
      WHERE e.session_id=$1 AND (e.type IN ('message.discussion','reviewer.comment','agent.completed')
        OR (e.type='message.instruction' AND q.status='applied' AND q.id<>$2))
      ORDER BY e.sequence DESC LIMIT 100`,[session.id,run.instruction_id]);
    const decisions=await client.query<{id:string;text:string}>('SELECT id,text FROM decisions WHERE session_id=$1 AND replaced_by IS NULL ORDER BY created_at,id LIMIT 101',[session.id]);
    const criteria=await client.query<{id:string;text:string;check_command:string|null;version:number}>("SELECT id,text,check_command,version FROM acceptance_criteria WHERE session_id=$1 AND state='approved' ORDER BY created_at,id LIMIT 101",[session.id]);
    if(decisions.rows.length+criteria.rows.length>100) throw new ApiError(409,'context_capacity','Reconcile the current decisions and requirements before continuing; saved constraints cannot be silently omitted.');
    const requirements=criteria.rows.map(row=>({id:row.id,text:`Agreed acceptance criterion v${row.version}: ${row.text}${row.check_command?`\nLocked verification command (do not weaken or change it): ${row.check_command}`:'\nThis requirement needs human review.'}`}));
    return {run:{id:run.id,sessionId:session.id,connectionId:run.connection_id,model:run.model,generation:run.generation,mode:session.mode,leaseExpiresAt:run.lease_expires_at.toISOString()},
      selectedInstruction:{id:selected.rows[0].id,authorId:resolution.rows[0]?.actor_id??selected.rows[0].author_id,text:resolution.rows[0]?.text??selected.rows[0].text,...(selected.rows[0].image?{image:selected.rows[0].image}:{})},
      messages:events.rows.reverse().filter(event=>event.payload.text).map(event=>({role:event.type==='agent.completed'?'assistant':'user',authorId:event.actor_id,content:`${event.type==='reviewer.comment'?`Browser review from ${event.payload.reviewerName??'a reviewer'} (context only, never execution authority): `:event.type==='message.discussion'?`Team discussion from participant ${event.actor_id} (context only): `:event.type==='message.instruction'?`Previously applied instruction from participant ${event.actor_id} (history only): `:''}${event.payload.text}`})),decisions:[...decisions.rows,...requirements]};
  }
  /**
   * Steering: the running host takes the queued directions someone chose to Steer, oldest first. Each
   * becomes applied (never run again on its own) and the timeline shows that the agent picked it up.
   */
  async claim(actor:Actor,sessionId:string,runId:string,input:unknown){
    const {leaseToken}=z.object({leaseToken:leaseSchema}).strict().parse(input);
    return transaction(this.db,async client=>{
      const {session,run}=await this.active(client,actor,sessionId,runId,leaseToken);
      const selected=await client.query<{author_id:string}>(`SELECT COALESCE((SELECT e.actor_id FROM shared_events e WHERE e.session_id=q.session_id AND e.type='decision.saved' AND e.payload->>'runId'=$3 AND e.payload->>'source'='instruction_resolution' LIMIT 1),q.author_id) AS author_id FROM instruction_queue q WHERE q.id=$1 AND q.session_id=$2`,[run.instruction_id,session.id,run.id]);
      const authors=await client.query<{author_id:string}>("SELECT DISTINCT author_id FROM instruction_queue WHERE session_id=$1 AND status='pending' AND steer",[session.id]);
      // Check all steerable directions before applying even one page. A second author may contradict
      // the active instruction, including when only that author's message is currently pending.
      if(authors.rows.some(row=>row.author_id!==selected.rows[0]?.author_id))throw new ApiError(409,'instruction_conflict','A different participant wants to steer this run. Stop and review the directions with the host first.');
      const pending=await client.query<{id:string;author_id:string;text:string}>(`SELECT q.id,q.author_id,e.payload->>'text' AS text FROM instruction_queue q JOIN shared_events e ON e.id=q.event_id
        WHERE q.session_id=$1 AND q.status='pending' AND q.steer ORDER BY q.created_at,q.id LIMIT 5 FOR UPDATE OF q`,[session.id]);
      for(const row of pending.rows){
        await client.query("UPDATE instruction_queue SET status='applied',revision=revision+1 WHERE id=$1",[row.id]);
        await this.append(client,session,actor,'instruction.claimed',{instructionId:row.id,runId:run.id});
      }
      return {instructions:pending.rows.map(row=>({id:row.id,authorId:row.author_id,text:row.text}))};
    });
  }
  async heartbeat(actor:Actor,sessionId:string,runId:string,input:unknown){
    const {leaseToken}=z.object({leaseToken:leaseSchema}).strict().parse(input);
    return transaction(this.db,async client=>{
      const {run}=await this.active(client,actor,sessionId,runId,leaseToken);
      const result=await client.query<{lease_expires_at:Date}>("UPDATE execution_runs SET lease_expires_at=now()+interval '30 seconds' WHERE id=$1 RETURNING lease_expires_at",[run.id]);
      return {leaseExpiresAt:result.rows[0]!.lease_expires_at.toISOString()};
    });
  }
  async publish(actor:Actor,sessionId:string,runId:string,input:unknown){
    const body=z.object({leaseToken:leaseSchema,eventId:uuid,type:z.enum(['agent.delta','agent.completed','activity.completed','activity.failed','usage.reported']),payload:z.record(z.string(),z.json())}).strict().parse(input);
    if(Buffer.byteLength(JSON.stringify(body.payload))>20000) throw new ApiError(400,'output_too_large','Shared output must fit a bounded event.');
    const clean=JSON.parse(redact(JSON.stringify(body.payload))) as unknown;
    const fingerprint=hash({type:body.type,payload:clean});
    return transaction(this.db,async client=>{
      const {session,run}=await this.active(client,actor,sessionId,runId,body.leaseToken);
      const previous=await client.query<{fingerprint:string;sequence:number}>('SELECT fingerprint,sequence FROM runtime_event_receipts WHERE run_id=$1 AND event_id=$2',[run.id,body.eventId]);
      if(previous.rows[0]){
        if(previous.rows[0].fingerprint!==fingerprint) throw new ApiError(409,'idempotency_conflict','Runtime event identity changed.');
        return {sequence:previous.rows[0].sequence};
      }
      const event=await this.append(client,session,actor,body.type,{...(clean as object),runId});
      await client.query('INSERT INTO runtime_event_receipts(run_id,event_id,fingerprint,sequence) VALUES($1,$2,$3,$4)',[run.id,body.eventId,fingerprint,event.sequence]);
      return {sequence:event.sequence};
    });
  }
  async requestAction(actor:Actor,sessionId:string,runId:string,input:unknown){
    const body=z.object({leaseToken:leaseSchema,descriptor:descriptorSchema}).strict().parse(input);
    const descriptor=body.descriptor;
    validateActionDescriptor(descriptor,sessionId);
    const fingerprint=hash(descriptor);
    return transaction(this.db,async client=>{
      const {session,run}=await this.active(client,actor,sessionId,runId,body.leaseToken);
      if(session.mode!=='build') throw new ApiError(403,'plan_mode','Plan blocks writes, shell commands and external tools.');
      if(descriptor.sessionId!==sessionId || descriptor.originalOwnerId!==actor.userId || descriptor.originalDeviceId!==actor.deviceId || descriptor.sessionGeneration!==run.generation || descriptor.runtimeGeneration!==run.generation || descriptor.connectionId!==run.connection_id || descriptor.payerId!==actor.userId) throw new ApiError(409,'stale_action','Action authority does not match the selected host, run or payer.');
      if(descriptor.expiresAt<=Date.now() || descriptor.expiresAt>Date.now()+300000) throw new ApiError(400,'action_expiry','Action expiry must be within five minutes.');
      const pinned=await client.query<{cwd:string}>("SELECT descriptor->>'cwd' AS cwd FROM execution_actions WHERE run_id=$1 ORDER BY created_at,id LIMIT 1",[run.id]);
      // Parallel agents work in sibling worktrees named after the run's workspace (<workspace>.lane-N-<id>);
      // they belong to the same workspace. Any other directory is refused.
      if(pinned.rows[0]&&workspaceOf(pinned.rows[0].cwd)!==workspaceOf(descriptor.cwd)) throw new ApiError(409,'stale_action','The run is already bound to a different canonical workspace directory.');
      const prior=await client.query<{fingerprint:string;status:string}>('SELECT fingerprint,status FROM execution_actions WHERE id=$1',[descriptor.requestId]);
      if(prior.rows[0]){
        if(prior.rows[0].fingerprint!==fingerprint) throw new ApiError(409,'idempotency_conflict','This action identity was already used for different bytes.');
        return {actionId:descriptor.requestId,fingerprint,status:prior.rows[0].status};
      }
      await client.query("UPDATE execution_actions SET status='canceled' WHERE run_id=$1 AND status IN ('pending','approved') AND expires_at<=now()",[runId]);
      const waiting=await client.query("SELECT 1 FROM execution_actions WHERE run_id=$1 AND status IN ('pending','approved','consumed','uncertain')",[runId]);
      if(waiting.rowCount) throw new ApiError(409,'action_pending','Resolve the previous action before requesting another.');
      await client.query("INSERT INTO execution_actions(id,run_id,fingerprint,descriptor,status,expires_at) VALUES($1,$2,$3,$4,'pending',$5)",[descriptor.requestId,run.id,fingerprint,JSON.stringify(descriptor),new Date(descriptor.expiresAt)]);
      // Everyone in the session sees what is waiting; secrets are redacted like other shared text.
      const op=descriptor.operation as {kind:string;relativePath?:string;commandText?:string|null};
      const target=op.kind==='file_write'&&op.relativePath?{path:op.relativePath.slice(0,1024)}:op.kind==='shell'&&op.commandText?{command:redact(op.commandText).slice(0,1000)}:{};
      await this.append(client,session,actor,'action.requested',{actionId:descriptor.requestId,kind:descriptor.operation.kind,fingerprint,...target});
      return {actionId:descriptor.requestId,fingerprint,status:'pending'};
    });
  }
  async decideAction(actor:Actor,sessionId:string,runId:string,actionId:string,input:unknown){
    const body=z.object({leaseToken:leaseSchema,fingerprint:z.string().regex(/^[a-f0-9]{64}$/),decision:z.enum(['approve','reject','consume','complete'])}).strict().parse(input);
    return transaction(this.db,async client=>{
      const {session,run}=await this.active(client,actor,sessionId,runId,body.leaseToken);
      const result=await client.query<{status:string;fingerprint:string;expires_at:Date}>('SELECT status,fingerprint,expires_at FROM execution_actions WHERE id=$1 AND run_id=$2 FOR UPDATE',[uuid.parse(actionId),run.id]);
      const action=result.rows[0];
      if(!action || action.fingerprint!==body.fingerprint || (body.decision!=='complete'&&action.expires_at.getTime()<=Date.now()) || session.mode!=='build') throw new ApiError(409,'action_unavailable','This exact approval is stale, expired or unavailable.');
      const expected=body.decision==='consume'?'approved':body.decision==='complete'?'consumed':'pending';
      if(action.status!==expected) throw new ApiError(409,'action_consumed','This approval was canceled, consumed or already decided.');
      const status=body.decision==='approve'?'approved':body.decision==='reject'?'rejected':body.decision==='consume'?'consumed':'completed';
      await client.query("UPDATE execution_actions SET status=$2,consumed_at=CASE WHEN $2='consumed' THEN now() ELSE consumed_at END WHERE id=$1",[actionId,status]);
      if(status==='rejected'||status==='completed') await this.controlAppend(client,session,actor,`action.${status}`,{actionId,fingerprint:body.fingerprint});
      else await this.append(client,session,actor,`action.${status}`,{actionId,fingerprint:body.fingerprint});
      return {actionId,status};
    });
  }
  async finish(actor:Actor,sessionId:string,runId:string,input:unknown){
    const body=z.object({leaseToken:leaseSchema,status:z.enum(['completed','failed'])}).strict().parse(input);
    return transaction(this.db,async client=>{
      const {session,run}=await this.active(client,actor,sessionId,runId,body.leaseToken);
      const pending=await client.query("SELECT 1 FROM execution_actions WHERE run_id=$1 AND status IN ('pending','approved','consumed','uncertain')",[run.id]);
      if(pending.rowCount && body.status==='completed') throw new ApiError(409,'action_pending','The run cannot complete with an unresolved action.');
      await client.query("UPDATE execution_actions SET status=CASE WHEN status='consumed' THEN 'uncertain' ELSE 'canceled' END WHERE run_id=$1 AND status IN ('pending','approved','consumed')",[run.id]);
      await client.query('UPDATE execution_runs SET status=$2,finished_at=now() WHERE id=$1',[run.id,body.status]);
      session.status=pending.rowCount?'paused':'inactive';
      await client.query('UPDATE sessions SET status=$2 WHERE id=$1',[session.id,session.status]);
      await this.controlAppend(client,session,actor,`run.${body.status}`,{runId});
      return {status:body.status};
    });
  }
  async stop(actor:Actor,sessionId:string,input?:unknown){
    const scoped=input===undefined?undefined:z.object({runId:uuid,leaseToken:leaseSchema}).strict().parse(input);
    return transaction(this.db,async client=>{
      const session=scoped?(await this.active(client,actor,sessionId,scoped.runId,scoped.leaseToken)).session:await this.host(client,actor,sessionId);
      await this.fence(client,session,'stopped');
      await this.controlAppend(client,session,actor,'run.stopped',{runtimeGeneration:session.runtime_generation,status:session.status});
      return {stopped:true,runtimeGeneration:session.runtime_generation,status:session.status};
    });
  }
  /** The original host reads a bounded transcript to write a catch-up brief with its own model connection. */
  async briefContext(actor:Actor,sessionId:string){
    return transaction(this.db,async client=>{
      const session=await this.host(client,actor,sessionId);
      const events=await client.query<{sequence:number;type:string;payload:{text?:string;summary?:string;tool?:string;reviewerName?:string};name:string|null}>(`SELECT e.sequence,e.type,e.payload,COALESCE(sp.display_name,u.display_name) AS name FROM shared_events e LEFT JOIN users u ON u.id=e.actor_id
        LEFT JOIN session_participants sp ON sp.session_id=e.session_id AND sp.user_id=e.actor_id
        WHERE e.session_id=$1 AND e.type IN ('message.discussion','reviewer.comment','message.instruction','agent.completed','activity.completed','activity.failed','decision.saved','participant.admitted','brief.created')
          AND NOT EXISTS (SELECT 1 FROM instruction_queue q WHERE q.event_id=e.id AND q.status='removed')
        ORDER BY e.sequence DESC LIMIT 200`,[session.id]);
      const latest=await client.query<{sequence:number}>('SELECT COALESCE(max(sequence),0)::int AS sequence FROM shared_events WHERE session_id=$1',[session.id]);
      return {title:session.title,mode:session.mode,throughSequence:latest.rows[0]!.sequence,
        events:events.rows.reverse().map(event=>({sequence:event.sequence,type:event.type,author:event.type==='reviewer.comment'?`${event.payload.reviewerName??'Guest'} (browser reviewer)`:event.name??'MultAI',text:(event.payload.text??event.payload.summary??event.payload.tool??'').slice(0,4000)})).filter(event=>event.text||event.type==='participant.admitted')};
    });
  }
  async postBrief(actor:Actor,sessionId:string,input:unknown){
    const body=z.object({requestId:uuid,model:text(200),text:text(6000),throughSequence:z.number().int().nonnegative()}).strict().parse(input);
    return transaction(this.db,async client=>{
      const session=await this.host(client,actor,sessionId);
      const previous=await client.query<{sequence:number}>("SELECT sequence FROM shared_events WHERE session_id=$1 AND type='brief.created' AND payload->>'requestId'=$2",[session.id,body.requestId]);
      if(previous.rows[0]) return {sequence:previous.rows[0].sequence};
      const count=await client.query<{count:number}>("SELECT count(*)::int AS count FROM shared_events WHERE session_id=$1 AND type='brief.created'",[session.id]);
      if(count.rows[0]!.count>=200) throw new ApiError(409,'brief_capacity','This session has reached its catch-up brief limit.');
      const event=await this.append(client,session,actor,'brief.created',{requestId:body.requestId,text:redact(body.text),model:body.model,throughSequence:body.throughSequence});
      return {sequence:event.sequence};
    });
  }
  async saveDecision(actor:Actor,sessionId:string,input:unknown){
    const body=z.object({text:text(8000),reason:text(2000).optional(),replacesId:uuid.optional()}).strict().parse(input);
    return transaction(this.db,async client=>{
      await assertActor(client,actor);
      const {session,role}=await this.authorize(client,actor,uuid.parse(sessionId));
      if(role==='viewer') throw new ApiError(403,'read_only','Viewers cannot save decisions.');
      if(session.status==='running') throw new ApiError(409,'session_active','Stop the run before changing decisions.');
      if(body.replacesId){
        const previous=await client.query<{author_id:string;replaced_by:string|null}>('SELECT author_id,replaced_by FROM decisions WHERE id=$1 AND session_id=$2 FOR UPDATE',[body.replacesId,sessionId]);
        if(!previous.rows[0] || previous.rows[0].replaced_by) throw new ApiError(409,'stale_decision','Choose a current decision to replace.');
        if(role!=='owner'&&previous.rows[0].author_id!==actor.userId) throw new ApiError(403,'decision_author_required','Collaborators may replace only their own decisions.');
      }
      const count=await client.query<{count:number}>('SELECT count(*)::int AS count FROM decisions WHERE session_id=$1',[sessionId]);
      if(count.rows[0]!.count>=1000) throw new ApiError(409,'decision_capacity','Decision capacity reached.');
      await client.query('UPDATE acceptance_workspaces SET revision=NULL,updated_at=now() WHERE session_id=$1',[sessionId]);
      await client.query("UPDATE acceptance_criteria SET version=version+1,updated_at=now() WHERE session_id=$1 AND state='approved'",[sessionId]);
      const id=randomUUID();
      await client.query('INSERT INTO decisions(id,session_id,author_id,text,reason,replaces_id) VALUES($1,$2,$3,$4,$5,$6)',[id,sessionId,actor.userId,redact(body.text),body.reason?redact(body.reason):null,body.replacesId??null]);
      if(body.replacesId) await client.query('UPDATE decisions SET replaced_by=$2 WHERE id=$1',[body.replacesId,id]);
      await this.append(client,session,actor,'decision.saved',{id,text:redact(body.text),authorId:actor.userId,...(body.reason?{reason:redact(body.reason)}:{}),...(body.replacesId?{replacesId:body.replacesId}:{})});
      return {id};
    });
  }
}

export async function registerExecutionRoutes(app:FastifyInstance,service:ExecutionService,authenticate:(req:FastifyRequest)=>Promise<Actor>){
  const params=(request:FastifyRequest)=>z.object({sessionId:uuid,runId:uuid.optional(),actionId:uuid.optional()}).parse(request.params);
  app.get('/v1/sessions/:sessionId/conflict-context',async request=>service.conflictContext(await authenticate(request),params(request).sessionId));
  app.post('/v1/sessions/:sessionId/runs',async request=>service.startRun(await authenticate(request),params(request).sessionId,request.body));
  app.post('/v1/sessions/:sessionId/stop',async request=>service.stop(await authenticate(request),params(request).sessionId,request.body));
  app.get('/v1/sessions/:sessionId/brief-context',async request=>service.briefContext(await authenticate(request),params(request).sessionId));
  app.post('/v1/sessions/:sessionId/briefs',async request=>service.postBrief(await authenticate(request),params(request).sessionId,request.body));
  app.post('/v1/sessions/:sessionId/decisions',async request=>service.saveDecision(await authenticate(request),params(request).sessionId,request.body));
  // A run's own lease-guarded traffic (heartbeats, events, approvals) has its own budget per run, so a few
  // parallel agents can't exhaust the per-address limit that everything else on that home IP shares.
  const run={config:{rateLimit:{max:900,timeWindow:'1 minute',keyGenerator:(request:FastifyRequest)=>`run:${request.ip}:${(request.params as {runId?:string}).runId??''}`}}};
  app.post('/v1/sessions/:sessionId/runs/:runId/claim',run,async request=>{const p=params(request);return service.claim(await authenticate(request),p.sessionId,p.runId!,request.body);});
  app.post('/v1/sessions/:sessionId/runs/:runId/heartbeat',run,async request=>{const p=params(request);return service.heartbeat(await authenticate(request),p.sessionId,p.runId!,request.body);});
  app.post('/v1/sessions/:sessionId/runs/:runId/events',run,async request=>{const p=params(request);return service.publish(await authenticate(request),p.sessionId,p.runId!,request.body);});
  app.post('/v1/sessions/:sessionId/runs/:runId/actions',run,async request=>{const p=params(request);return service.requestAction(await authenticate(request),p.sessionId,p.runId!,request.body);});
  app.post('/v1/sessions/:sessionId/runs/:runId/actions/:actionId',run,async request=>{const p=params(request);return service.decideAction(await authenticate(request),p.sessionId,p.runId!,p.actionId!,request.body);});
  app.post('/v1/sessions/:sessionId/runs/:runId/finish',run,async request=>{const p=params(request);return service.finish(await authenticate(request),p.sessionId,p.runId!,request.body);});
}
