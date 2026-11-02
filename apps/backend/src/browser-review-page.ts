/** Same-origin, dependency-free browser review. Credentials remain in this tab's memory only. */
export const REVIEW_HTML=String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>MultAI · Team review</title><link rel="stylesheet" href="/review.css"><script defer src="/review.js"></script></head>
<body><header><a href="/review" aria-label="MultAI team review">MultAI</a><span>Team review</span><button id="leave" hidden>Leave review</button></header>
<main><h1 id="title">Review a teammate’s work</h1><p id="status" role="status" aria-live="polite">The host admits you before anything is shared.</p><p id="error" role="alert"></p>
<section id="join"><form id="join-form"><label for="name">Your name</label><input id="name" maxlength="60" autocomplete="name" required><button type="submit">Ask to join</button></form><p class="muted">No installation or AI account needed. Your host confirms your identity and admission. Access stays in this tab only; reloading requires a new admission.</p></section>
<section id="pending" hidden><h2>Waiting for the host</h2><p>Your name has been sent to the host. Keep this tab open.</p></section>
<div id="review" hidden><div class="columns"><section><h2>Shared conversation</h2><p class="muted">A limited shared timeline. Private commands and account details are omitted.</p><div id="timeline" role="log" aria-live="polite"></div>
<form id="comment-form"><label for="comment">Comment or request a change</label><textarea id="comment" maxlength="4000" rows="3" required></textarea><p id="annotation-label" class="muted"></p><button type="button" id="clear-region" hidden>Clear mark</button><button type="submit">Send to the team</button></form></section>
<section><h2>Agreed requirements</h2><p class="muted">Checks report actual host-run results. Accepting evidence records your judgment; it never turns a failed check green.</p><p id="revision" class="muted"></p><div id="criteria"></div><form id="criterion-form"><label for="criterion">Propose a requirement</label><textarea id="criterion" maxlength="2000" rows="3" placeholder="For example: double-clicking Pay creates only one order." required></textarea><button type="submit">Propose for host approval</button></form>
<h2>Shared screenshots</h2><p class="muted">Only images explicitly shared by the host appear here. Drag a box over a problem, then send a comment.</p><div id="screenshots"></div></section></div></div></main>
</body></html>`;

export const REVIEW_CSS=String.raw`
:root{color-scheme:light dark;font-family:Inter,ui-sans-serif,system-ui,sans-serif;background:#111;color:#eee;font-size:15px}*{box-sizing:border-box}body{margin:0}header{border-bottom:1px solid #333;padding:20px max(24px,calc((100vw - 1250px)/2));display:flex;align-items:center;gap:20px}header a{color:inherit;font-size:22px;font-weight:750;text-decoration:none}header span{color:#aaa}header button{margin-left:auto}main{max-width:1250px;margin:36px auto;padding:0 24px 60px}h1{font-size:30px;letter-spacing:-.8px}h2{font-size:20px;margin-top:30px}p{line-height:1.6}.muted{color:#aaa;font-size:13px}#error{color:#ffb4a9;white-space:pre-wrap}#status{color:#ccc}.columns{display:grid;grid-template-columns:1fr 1fr;gap:36px}form{display:grid;gap:10px;margin:20px 0}label{font-weight:650}input,textarea{width:100%;background:#1b1b1b;color:inherit;border:1px solid #555;border-radius:8px;padding:12px;font:inherit}textarea{resize:vertical}button{background:#eee;border:1px solid #eee;color:#111;border-radius:7px;padding:9px 13px;font:inherit;cursor:pointer;justify-self:start}button.secondary{background:#222;color:#eee;border-color:#555}button:disabled{opacity:.5;cursor:wait}button:focus-visible,input:focus-visible,textarea:focus-visible{outline:3px solid #83b7ff;outline-offset:2px}[hidden]{display:none!important}.message,.criterion{border:1px solid #333;border-radius:10px;padding:14px;margin:10px 0;overflow-wrap:anywhere}.message b{font-size:13px;color:#bbb}.message p{white-space:pre-wrap;margin-bottom:0}.badge{display:inline-block;border:1px solid #777;border-radius:20px;padding:3px 9px;font-size:12px;margin-bottom:8px}.passed{color:#a3e5ae;border-color:#498559}.failed{color:#ffb4a9;border-color:#9b4a43}.stale{color:#e7c58e}.criterion pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px ui-monospace,monospace;background:#1b1b1b;padding:10px;border-radius:5px;max-height:240px;overflow:auto}.actions{display:flex;gap:8px;margin-top:12px}.review-note{font-size:13px;color:#ccc}.screenshot{position:relative;display:inline-block;max-width:100%;touch-action:none;user-select:none;cursor:crosshair;line-height:0;border:1px solid #555}.screenshot img{max-width:100%;height:auto;display:block;pointer-events:none}.mark{position:absolute;border:2px solid #ff7272;background:#ff727233;pointer-events:none}.image-label{font-weight:650;margin-bottom:8px}#join{max-width:440px}#timeline{max-height:65vh;overflow:auto}@media(max-width:760px){.columns{grid-template-columns:1fr}main{margin-top:24px}header{padding:16px 24px}#timeline{max-height:50vh}}
`;

export const REVIEW_JS=String.raw`
(()=>{'use strict';
const by=id=>document.getElementById(id);
let invitation=location.hash.slice(1),credential=null,cursor=0,stopped=false,polling=false,timer=null,joinBody=null,annotation=null,criteriaKey='',screenshotsKey='';
history.replaceState(null,'',location.pathname);
if(!/^[A-Za-z0-9_-]{43}$/.test(invitation)){by('join').hidden=true;by('status').textContent='Open the complete review invitation from your host. Reloading a review requires a new admission.';}
const token=()=>{const bytes=crypto.getRandomValues(new Uint8Array(32));return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');};
const element=(tag,text,cls)=>{const e=document.createElement(tag);if(text!==undefined)e.textContent=text;if(cls)e.className=cls;return e;};
const error=message=>{by('error').textContent=message||'';};
async function request(path,body,auth=true){
 const response=await fetch('/v1/browser-review/'+path,{method:'POST',headers:{'Content-Type':'application/json',...(auth?{Authorization:'Review '+credential}:{})},body:JSON.stringify(body),credentials:'omit',signal:AbortSignal.timeout(12000)});
 const data=await response.json();
 if(!response.ok){const err=new Error(data.error?.message||'The request failed. Try again.');err.code=data.error?.code;throw err;}return data;
}
function terminate(message){stopped=true;credential=null;invitation=null;joinBody=null;clearTimeout(timer);by('review').hidden=true;by('pending').hidden=true;by('join').hidden=true;by('leave').hidden=true;by('timeline').replaceChildren();by('criteria').replaceChildren();by('screenshots').replaceChildren();annotation=null;criteriaKey='';screenshotsKey='';by('comment').value='';by('criterion').value='';by('title').textContent='Team review';by('status').textContent=message;}
by('leave').onclick=()=>terminate('You left this review. Reopen the invitation to request admission again.');
function failure(err){if(err.code==='review_unavailable'){terminate(err.message);}else error(err.message||'The service is unavailable. Trying again shortly.');}
by('join-form').onsubmit=async event=>{event.preventDefault();const button=event.submitter;button.disabled=true;error('');try{
 const name=by('name').value.trim();if(!name)return;
 if(!joinBody||joinBody.name!==name)joinBody={invitationToken:invitation,credential:token(),requestId:crypto.randomUUID(),name};
 const data=await request('join',joinBody,false);if(stopped)return;credential=joinBody.credential;joinBody=null;invitation=null;by('join').hidden=true;by('pending').hidden=false;by('leave').hidden=false;by('status').textContent='Admission requested. Waiting for the host.';await poll();
 }catch(err){failure(err);}finally{button.disabled=false;}};
function addEvents(events){for(const item of events){const data=item.data||{};let text=data.text||data.summary;
 if(item.type==='plan')text=(data.steps||[]).map(step=>(step.state==='done'?'✓ ':step.state==='active'?'→ ':'○ ')+step.text).join('\n');
 if(!text)continue;const node=element('article',undefined,'message');node.append(element('b',item.who||'Team'),element('p',text));by('timeline').append(node);
 }while(by('timeline').children.length>300)by('timeline').firstElementChild.remove();}
const statusText={proposed:'Awaiting host approval',needs_review:'Needs human review',passed:'Check passed',failed:'Check failed',stale:'Stale — verify current code'};
function showCriteria(snapshot,working){
 const key=JSON.stringify({snapshot,working});if(key===criteriaKey)return;criteriaKey=key;
 by('revision').textContent=snapshot.revision?'Workspace revision '+snapshot.revision.slice(0,12):'The host has not published a workspace revision yet.';
 const list=by('criteria');list.replaceChildren();
 for(const criterion of snapshot.criteria.filter(item=>item.state!=='withdrawn')){
  const node=element('article',undefined,'criterion');node.append(element('span',statusText[criterion.status]||criterion.status,'badge '+criterion.status),element('p',criterion.text),element('p','Proposed by '+criterion.authorName+(criterion.authorKind==='browser'?' (browser reviewer)':'')+' · version '+criterion.version,'muted'));
  if(criterion.checkCommand)node.append(element('pre',criterion.checkCommand));
  const proof=criterion.evidence;
  if(proof){node.append(element('p',proof.kind==='command'?'Host-run check · exit '+String(proof.exitCode)+(proof.timedOut?' · timed out':'')+(proof.canceled?' · canceled':''):'Host-provided observation · needs human judgment','muted'),element('pre',proof.output||'(No output)'));
   for(const review of proof.reviews)node.append(element('p',review.reviewerName+(review.reviewerKind==='browser'?' (browser reviewer)':'')+': '+(review.decision==='accept'?'accepted':'requested changes')+(review.comment?' — '+review.comment:''),'review-note'));
   if(criterion.state==='approved'&&criterion.status!=='stale'&&!working){const actions=element('div',undefined,'actions');for(const decision of ['accept','reject']){const button=element('button',decision==='accept'?'Accept result':'Request changes',decision==='reject'?'secondary':undefined);button.type='button';button.onclick=async()=>{
    const comment=prompt(decision==='accept'?'What did you verify? (Optional)':'What needs to change? (Optional)');if(comment===null)return;button.disabled=true;error('');try{await request('decision',{requestId:crypto.randomUUID(),criterionId:criterion.id,criterionVersion:criterion.version,evidenceId:proof.id,revision:proof.revision,decision,...(comment.trim()?{comment:comment.trim()}: {})});await poll();}catch(err){failure(err);}finally{button.disabled=false;}};actions.append(button);}node.append(actions);}
  }list.append(node);
 }if(!list.children.length)list.append(element('p','No requirements yet. Propose the behavior you need below.','muted'));
}
function clearMark(){annotation=null;document.querySelectorAll('.mark').forEach(node=>node.remove());by('annotation-label').textContent='';by('clear-region').hidden=true;}
by('clear-region').onclick=clearMark;
function showScreenshots(images){const key=JSON.stringify(images);if(key===screenshotsKey)return;screenshotsKey=key;clearMark();const list=by('screenshots');list.replaceChildren();
 for(const image of images){const label=element('p',image.label,'image-label'),box=element('div',undefined,'screenshot'),img=element('img');img.src=image.image;img.alt=image.label;img.draggable=false;box.append(img);list.append(label,box);let start=null,mark=null;
  const point=event=>{const rect=box.getBoundingClientRect();return {x:Math.max(0,Math.min(1,(event.clientX-rect.left)/rect.width)),y:Math.max(0,Math.min(1,(event.clientY-rect.top)/rect.height))};};
  box.onpointerdown=event=>{if(event.button!==0)return;clearMark();start=point(event);mark=element('span',undefined,'mark');box.append(mark);box.setPointerCapture(event.pointerId);};
  box.onpointermove=event=>{if(!start)return;const end=point(event),region={x:Math.min(start.x,end.x),y:Math.min(start.y,end.y),width:Math.abs(end.x-start.x),height:Math.abs(end.y-start.y)};mark.style.left=(region.x*100)+'%';mark.style.top=(region.y*100)+'%';mark.style.width=(region.width*100)+'%';mark.style.height=(region.height*100)+'%';annotation={screenshotId:image.id,region};};
  box.onpointerup=()=>{start=null;if(!annotation||annotation.region.width<.003||annotation.region.height<.003){clearMark();return;}by('annotation-label').textContent='Your comment includes a marked region of “'+image.label+'”.';by('clear-region').hidden=false;by('comment').focus();};
  box.onpointercancel=()=>{start=null;clearMark();};
 }if(!images.length)list.append(element('p','The host has not shared any screenshots.','muted'));
}
async function poll(){if(stopped||!credential||polling)return;clearTimeout(timer);polling=true;try{
 const activeCredential=credential;const data=await request('view',{after:cursor});if(stopped||activeCredential!==credential)return;error('');
 if(data.status==='pending'){by('status').textContent='Waiting for the host to admit you.';}
 else{by('pending').hidden=true;by('review').hidden=false;by('title').textContent=data.session.title;by('status').textContent='Joined as '+data.reviewer.name+(data.session.working?' · Agent working':' · Ready for review');addEvents(data.events);cursor=data.next;showCriteria(data.acceptance,data.session.working);showScreenshots(data.screenshots);}
 timer=setTimeout(()=>void poll(),data.done===false?1100:3000);
 }catch(err){failure(err);if(!stopped)timer=setTimeout(()=>void poll(),5000);}finally{polling=false;}}
function submitForm(id,path,getBody,onSuccess){let pending=null;by(id).onsubmit=async event=>{event.preventDefault();const button=event.submitter;button.disabled=true;error('');try{
 const body=getBody(),fingerprint=JSON.stringify(body);if(!pending||pending.fingerprint!==fingerprint)pending={fingerprint,body:{requestId:crypto.randomUUID(),...body}};
 await request(path,pending.body);pending=null;onSuccess();await poll();}catch(err){failure(err);}finally{button.disabled=false;}};}
submitForm('comment-form','comment',()=>({text:by('comment').value.trim(),...(annotation||{})}),()=>{by('comment').value='';clearMark();});
submitForm('criterion-form','criteria',()=>({text:by('criterion').value.trim()}),()=>{by('criterion').value='';});
window.addEventListener('hashchange',()=>{if(/^[A-Za-z0-9_-]{43}$/.test(location.hash.slice(1)))location.reload();});
window.addEventListener('pagehide',()=>terminate('Reopen your invitation to request admission again.'));
})();
`;
