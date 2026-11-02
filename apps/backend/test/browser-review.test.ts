import assert from 'node:assert/strict';
import {randomBytes,randomUUID,webcrypto} from 'node:crypto';
import {Script,createContext} from 'node:vm';
import {test} from 'node:test';
import {BrowserReviewService} from '../src/browser-review.js';
import {REVIEW_JS} from '../src/browser-review-page.js';
import {AcceptanceService} from '../src/acceptance.js';
import {CollaborationService} from '../src/collaboration.js';
import {createTestContext,seedActor,testConfig} from './helpers.js';

const token=()=>randomBytes(32).toString('base64url');
const png='data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a4V8AAAAASUVORK5CYII=';
const headers=(identity:{token:string})=>({authorization:`Bearer ${identity.token}`});
const browserHeaders=(credential:string)=>({origin:testConfig.publicOrigin,authorization:`Review ${credential}`});
async function setup(){
  const ctx=await createTestContext(),owner=await seedActor(ctx.db,'Host'),outsider=await seedActor(ctx.db,'Other host');
  const collaboration=new CollaborationService(ctx.db),service=new BrowserReviewService(ctx.db),acceptance=new AcceptanceService(ctx.db);
  const created=await collaboration.createSession(owner.actor,{requestId:randomUUID(),title:'Checkout review',message:{kind:'discussion',text:'Private project conversation',image:png}}) as {session:{id:string}};
  const sessionId=created.session.id;
  const {invitation}=await service.createReviewInvitation(owner.actor,sessionId,{});
  const credential=token(),joinBody={invitationToken:invitation.token,credential,requestId:randomUUID(),name:'Guest reviewer'};
  const {reviewer}=await service.join(joinBody);
  const admit=()=>service.decideReviewer(owner.actor,sessionId,reviewer.id,{decision:'admit'});
  return {...ctx,owner,outsider,collaboration,service,acceptance,sessionId,invitation,credential,joinBody,reviewer,admit};
}

test('browser reviewer sees nothing before host admission and cannot become a native actor',async t=>{
  const c=await setup();t.after(()=>c.close());
  assert.deepEqual(await c.service.view(c.credential,{}),{status:'pending'});
  await assert.rejects(c.service.comment(c.credential,{requestId:randomUUID(),text:'Let me in'}),{code:'review_admission_required'});
  await assert.rejects(c.service.propose(c.credential,{requestId:randomUUID(),text:'The checkout works'}),{code:'review_admission_required'});
  const listed=await c.service.list(c.owner.actor,c.sessionId);
  assert.equal(listed.reviewers[0]?.name,'Guest reviewer');
  assert.equal(JSON.stringify(listed).includes(c.credential),false);
  assert.equal(JSON.stringify(listed).includes(c.invitation.token),false);
  await c.admit();
  const view=await c.service.view(c.credential,{});assert.equal(view.status,'admitted');
  assert.ok('events' in view);
  assert.equal(view.events.some(event=>event.data.text==='Private project conversation'),true);
  assert.equal(JSON.stringify(view).includes(png),false,'ordinary conversation screenshots are not shared with browser guests');
  assert.deepEqual(view.screenshots,[]);
  assert.equal((await c.app.inject({method:'GET',url:`/v1/sessions/${c.sessionId}`,headers:{authorization:`Bearer ${c.credential}`}})).statusCode,401);
  assert.equal((await c.app.inject({method:'POST',url:`/v1/sessions/${c.sessionId}/messages`,headers:{authorization:`Bearer ${c.credential}`},payload:{requestId:randomUUID(),kind:'instruction',text:'Run a command'}})).statusCode,401);
  await assert.rejects(c.service.list(c.outsider.actor,c.sessionId),{code:'membership_required'});
  await c.db.query('UPDATE auth_sessions SET revoked_at=now() WHERE id=$1',[c.owner.actor.authSessionId]);
  await assert.rejects(c.service.list(c.owner.actor,c.sessionId),{code:'unauthorized'});
  await assert.rejects(c.service.decideReviewer(c.owner.actor,c.sessionId,c.reviewer.id,{decision:'revoke'}),{code:'unauthorized'});
});

test('browser joins and comments have stable concurrent retry identities and revocation fences old retries',async t=>{
  const c=await setup();t.after(()=>c.close());
  const joins=await Promise.all([c.service.join(c.joinBody),c.service.join(c.joinBody)]);
  assert.equal(joins[0].reviewer.id,joins[1].reviewer.id);
  await assert.rejects(c.service.join({...c.joinBody,name:'Changed guest'}),{code:'idempotency_conflict'});
  await assert.rejects(c.service.join({...c.joinBody,requestId:randomUUID()}),{code:'review_credential_used'});
  await c.admit();
  const input={requestId:randomUUID(),text:'Checkout should allow keyboard users.'};
  const comments=await Promise.all([c.service.comment(c.credential,input),c.service.comment(c.credential,input)]);
  assert.equal(comments[0].sequence,comments[1].sequence);
  await assert.rejects(c.service.comment(c.credential,{...input,text:'Changed content'}),{code:'idempotency_conflict'});
  const count=await c.db.query("SELECT count(*)::int AS count FROM shared_events WHERE session_id=$1 AND type='reviewer.comment'",[c.sessionId]);
  assert.equal(count.rows[0].count,1);
  await c.service.decideReviewer(c.owner.actor,c.sessionId,c.reviewer.id,{decision:'revoke'});
  await assert.rejects(c.service.comment(c.credential,input),{code:'review_unavailable'});
  await assert.rejects(c.service.join(c.joinBody),{code:'review_unavailable'});
  await assert.rejects(c.service.view(c.credential,{}),{code:'review_unavailable'});
  await assert.rejects(c.admit(),{code:'review_unavailable'});
});

test('review invitation expiry, reviewer expiry, invitation revocation and session deletion close existing access',async t=>{
  const c=await setup();t.after(()=>c.close());await c.admit();
  await c.db.query("UPDATE browser_reviewers SET expires_at=now()-interval '1 second' WHERE id=$1",[c.reviewer.id]);
  await assert.rejects(c.service.view(c.credential,{}),{code:'review_unavailable'});
  await c.db.query("UPDATE browser_reviewers SET expires_at=now()+interval '1 hour' WHERE id=$1",[c.reviewer.id]);
  await c.db.query("UPDATE browser_review_invitations SET expires_at=now()-interval '1 second' WHERE id=$1",[c.invitation.id]);
  await assert.rejects(c.service.view(c.credential,{}),{code:'review_unavailable'});
  await assert.rejects(c.service.join(c.joinBody),{code:'review_unavailable'});
  await c.db.query("UPDATE browser_review_invitations SET expires_at=now()+interval '1 hour' WHERE id=$1",[c.invitation.id]);
  await c.db.query('UPDATE sessions SET deleted_at=now() WHERE id=$1',[c.sessionId]);
  await assert.rejects(c.service.view(c.credential,{}),{code:'review_unavailable'});
  await assert.rejects(c.service.join(c.joinBody),{code:'review_unavailable'});
  await c.db.query('UPDATE sessions SET deleted_at=NULL WHERE id=$1',[c.sessionId]);
  await c.service.revokeReviewInvitation(c.owner.actor,c.sessionId,c.invitation.id);
  await assert.rejects(c.service.view(c.credential,{}),{code:'review_unavailable'});
  await assert.rejects(c.service.join(c.joinBody),{code:'review_unavailable'});
});

test('browser requirements need host approval and reviews stay bound to exact evidence and revision',async t=>{
  const c=await setup();t.after(()=>c.close());await c.admit();
  const proposed=await c.service.propose(c.credential,{requestId:randomUUID(),text:'Double-click Pay creates one order',checkCommand:'npm test'});
  let snapshot=await c.acceptance.list(c.owner.actor,c.sessionId);
  assert.equal(snapshot.criteria[0]?.state,'proposed');assert.equal(snapshot.criteria[0]?.authorKind,'browser');
  const revision='a'.repeat(64);
  await c.acceptance.revision(c.owner.actor,c.sessionId,{requestId:randomUUID(),revision});
  await assert.rejects(c.acceptance.evidence(c.owner.actor,c.sessionId,{requestId:randomUUID(),criterionId:proposed.id,criterionVersion:1,revision,kind:'command',command:'npm test',exitCode:0,output:'Passed'}),{code:'criterion_not_approved'});
  await c.acceptance.approve(c.owner.actor,c.sessionId,proposed.id,{requestId:randomUUID(),expectedVersion:1});
  const evidence=await c.acceptance.evidence(c.owner.actor,c.sessionId,{requestId:randomUUID(),criterionId:proposed.id,criterionVersion:1,revision,kind:'command',command:'npm test',exitCode:1,output:'Created two orders'});
  const review={requestId:randomUUID(),criterionId:proposed.id,criterionVersion:1,evidenceId:evidence.id,revision,decision:'reject',comment:'Still creates two orders'};
  await c.service.decideEvidence(c.credential,review);
  snapshot=await c.acceptance.list(c.owner.actor,c.sessionId);
  assert.equal(snapshot.criteria[0]?.status,'failed');assert.equal(snapshot.criteria[0]?.evidence?.reviews[0]?.decision,'reject');
  await c.service.decideEvidence(c.credential,{...review,requestId:randomUUID(),decision:'accept'});
  assert.equal((await c.acceptance.list(c.owner.actor,c.sessionId)).criteria[0]?.status,'failed','human acceptance cannot overwrite failed command status');
  await assert.rejects(c.service.decideEvidence(c.credential,{...review,requestId:randomUUID(),evidenceId:randomUUID()}),{code:'stale_evidence'});
  await c.acceptance.revision(c.owner.actor,c.sessionId,{requestId:randomUUID(),revision:'b'.repeat(64)});
  await assert.rejects(c.service.decideEvidence(c.credential,{...review,requestId:randomUUID()}),{code:'stale_evidence'});
  await c.service.decideReviewer(c.owner.actor,c.sessionId,c.reviewer.id,{decision:'revoke'});
  await assert.rejects(c.service.decideEvidence(c.credential,review),{code:'review_unavailable'});
});

test('only explicitly shared screenshots can be annotated, with bounded regions and session confinement',async t=>{
  const c=await setup();t.after(()=>c.close());await c.admit();
  await assert.rejects(c.service.shareScreenshot(c.owner.actor,c.sessionId,{label:'Fake image',image:'data:image/png;base64,PHNjcmlwdD4='}));
  const image=await c.service.shareScreenshot(c.owner.actor,c.sessionId,{label:'Checkout form',image:png});
  const view=await c.service.view(c.credential,{});assert.ok('screenshots' in view);assert.equal(view.screenshots[0]?.image,png);
  const body={requestId:randomUUID(),text:'The payment button is clipped',screenshotId:image.id,region:{x:.1,y:.2,width:.3,height:.4}};
  await c.service.comment(c.credential,body);
  await assert.rejects(c.service.comment(c.credential,{...body,requestId:randomUUID(),region:{x:.9,y:0,width:.2,height:.1}}));
  await assert.rejects(c.service.comment(c.credential,{...body,requestId:randomUUID(),region:{x:0,y:0,width:0,height:1}}));
  await assert.rejects(c.service.comment(c.credential,{requestId:randomUUID(),text:'Missing region',screenshotId:image.id}));
  await assert.rejects(c.service.comment(c.credential,{...body,requestId:randomUUID(),screenshotId:randomUUID()}),{code:'screenshot_unavailable'});
  const other=await c.collaboration.createSession(c.outsider.actor,{requestId:randomUUID(),message:{kind:'discussion',text:'Other project'}}) as {session:{id:string}};
  const otherImage=await c.service.shareScreenshot(c.outsider.actor,other.session.id,{label:'Other project',image:png});
  await assert.rejects(c.service.comment(c.credential,{...body,requestId:randomUUID(),screenshotId:otherImage.id}),{code:'screenshot_unavailable'});
  await c.service.revokeScreenshot(c.owner.actor,c.sessionId,image.id);
  await assert.rejects(c.service.comment(c.credential,{...body,requestId:randomUUID()}),{code:'screenshot_unavailable'});
  const after=await c.service.view(c.credential,{});assert.ok('screenshots' in after);assert.deepEqual(after.screenshots,[]);
});

test('reviewer invitations and screenshots can be revoked even at shared event capacity',async t=>{
  const c=await setup();t.after(()=>c.close());await c.admit();
  const image=await c.service.shareScreenshot(c.owner.actor,c.sessionId,{image:png,label:'Before'});
  await c.db.query('UPDATE sessions SET event_sequence=100000 WHERE id=$1',[c.sessionId]);
  await c.service.revokeScreenshot(c.owner.actor,c.sessionId,image.id);
  await c.service.decideReviewer(c.owner.actor,c.sessionId,c.reviewer.id,{decision:'revoke'});
  await c.service.revokeReviewInvitation(c.owner.actor,c.sessionId,c.invitation.id);
  await assert.rejects(c.service.view(c.credential,{}),{code:'review_unavailable'});
  assert.deepEqual((await c.service.list(c.owner.actor,c.sessionId)).invitations,[]);
});

test('browser HTTP routes reject cross-origin and ambient credentials, accept scoped same-origin participation',async t=>{
  const c=await setup();t.after(()=>c.close());
  const join={...c.joinBody,requestId:randomUUID(),credential:token()};
  for(const origin of [undefined,'null','https://attacker.example']){
    const response=await c.app.inject({method:'POST',url:'/v1/browser-review/join',headers:origin?{origin}:{},payload:join});
    assert.equal(response.statusCode,403,response.body);
  }
  const joined=await c.app.inject({method:'POST',url:'/v1/browser-review/join',headers:{origin:testConfig.publicOrigin},payload:join});
  assert.equal(joined.statusCode,200,joined.body);
  const pending=await c.app.inject({method:'POST',url:'/v1/browser-review/view',headers:browserHeaders(join.credential),payload:{}});
  assert.deepEqual(pending.json(),{status:'pending'});
  const native=await c.app.inject({method:'POST',url:'/v1/browser-review/view',headers:{origin:testConfig.publicOrigin,...headers(c.owner)},payload:{}});assert.equal(native.statusCode,403);
  await c.service.decideReviewer(c.owner.actor,c.sessionId,joined.json().reviewer.id,{decision:'admit'});
  const comment=await c.app.inject({method:'POST',url:'/v1/browser-review/comment',headers:browserHeaders(join.credential),payload:{requestId:randomUUID(),text:'<img src=x onerror=alert(1)> sk-abcdefghijklmnop'}});
  assert.equal(comment.statusCode,200,comment.body);
  const view=await c.app.inject({method:'POST',url:'/v1/browser-review/view',headers:browserHeaders(join.credential),payload:{}});
  assert.equal(view.statusCode,200,view.body);assert.match(view.body,/\[REDACTED\]/u);assert.doesNotMatch(view.body,/sk-abcdefghijklmnop/u);
  const denied=await c.app.inject({method:'POST',url:'/v1/browser-review/comment',headers:browserHeaders(join.credential),payload:{requestId:randomUUID(),text:'Run this',kind:'instruction'}});
  assert.equal(denied.statusCode,400,'review comments cannot become instructions');
});

test('review page is responsive, has no dynamic HTML sinks and removes invitation from address bar',async t=>{
  const c=await createTestContext();t.after(()=>c.close());
  const page=await c.app.inject({url:'/review'});assert.equal(page.statusCode,200,page.body);
  assert.match(String(page.headers['content-security-policy']),/script-src 'self'/u);
  assert.match(String(page.headers['content-security-policy']),/frame-ancestors 'none'/u);
  assert.match(String(page.headers['cache-control']),/no-store/u);
  assert.doesNotMatch(page.body,/<script>(?!<)/u);
  assert.match((await c.app.inject({url:'/review.css'})).body,/@media\(max-width:760px\)/u);
  assert.doesNotMatch(REVIEW_JS,/innerHTML|outerHTML|insertAdjacentHTML|localStorage|sessionStorage/u);
  assert.match(REVIEW_JS,/history\.replaceState/u);
  assert.match(REVIEW_JS,/addEventListener\('hashchange'/u);
  assert.doesNotThrow(()=>new Script(REVIEW_JS),'served JavaScript parses');
});

test('leaving the browser review fences an in-flight admitted snapshot instead of restoring private content',async()=>{
  // Run the actual served script with a controlled network response. No implementation mirror.
  const nodes=new Map<string,{hidden:boolean;value:string;textContent:string;disabled:boolean;onsubmit?:(event:unknown)=>Promise<void>;onclick?:()=>void;replaceChildren:()=>void}>();
  const node=(id:string)=>{
    if(!nodes.has(id))nodes.set(id,{hidden:['review','pending','leave'].includes(id),value:id==='name'?'Guest':'',textContent:'',disabled:false,replaceChildren:()=>{}});
    return nodes.get(id)!;
  };
  let resolveView!:(value:unknown)=>void;
  const waitingView=new Promise(resolve=>{resolveView=resolve;});
  let requestCount=0;
  const context=createContext({
    document:{getElementById:node,querySelectorAll:()=>[]},
    location:{hash:`#${token()}`,pathname:'/review'},history:{replaceState:()=>{}},
    crypto:webcrypto,Uint8Array,btoa:(s:string)=>Buffer.from(s,'binary').toString('base64'),
    AbortSignal,JSON,String,Promise,setTimeout:()=>1,clearTimeout:()=>{},
    window:{addEventListener:()=>{}},
    fetch:async(path:string,options:{credentials:string;headers:Record<string,string>})=>{
      assert.equal(options.credentials,'omit');requestCount++;
      if(path.endsWith('/join'))return {ok:true,json:async()=>({reviewer:{status:'pending'}})};
      assert.match(options.headers.Authorization!,/^Review /u);
      return waitingView;
    },
  });
  new Script(REVIEW_JS).runInContext(context);
  const submitted=node('join-form').onsubmit!({preventDefault(){},submitter:node('submit')});
  // Wait for the join response's promise chain to begin the separate polling request.
  for(let i=0;i<10&&requestCount<2;i++)await Promise.resolve();
  assert.equal(requestCount,2);
  node('leave').onclick!();
  resolveView({ok:true,json:async()=>({status:'admitted',session:{title:'Private project'},reviewer:{name:'Guest'},events:[],acceptance:{revision:null,criteria:[]},screenshots:[],next:0,done:true})});
  await submitted;
  assert.equal(node('review').hidden,true);
  assert.equal(node('title').textContent,'Team review');
  assert.match(node('status').textContent,/left this review/u);
});

test('browser management requires the original device even for the same signed-in owner',async t=>{
  const c=await setup();t.after(()=>c.close());
  const deviceId=randomUUID(),authSessionId=randomUUID();
  await c.db.query('INSERT INTO devices(id,user_id,name) VALUES($1,$2,$3)',[deviceId,c.owner.actor.userId,'Other device']);
  await c.db.query("INSERT INTO auth_sessions(id,user_id,device_id,expires_at) VALUES($1,$2,$3,now()+interval '1 day')",[authSessionId,c.owner.actor.userId,deviceId]);
  const wrongDevice={...c.owner.actor,deviceId,authSessionId};
  await assert.rejects(c.service.list(wrongDevice,c.sessionId),{code:'original_host_required'});
  await assert.rejects(c.service.createReviewInvitation(wrongDevice,c.sessionId,{}),{code:'original_host_required'});
  await assert.rejects(c.service.decideReviewer(wrongDevice,c.sessionId,c.reviewer.id,{decision:'admit'}),{code:'original_host_required'});
  await assert.rejects(c.service.shareScreenshot(wrongDevice,c.sessionId,{image:png,label:'Private'}),{code:'original_host_required'});
});
