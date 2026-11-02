import {useEffect,useRef,useState} from 'react';
import {Check,RefreshCw,Plus,Copy,UserCheck,Trash2,Play} from 'lucide-react';
import {getBridge} from '../bridge/client';
import type {AcceptanceSnapshot,AcceptanceCriterion,BrowserReviewers,ReviewOperation} from '../bridge/review';
import type {SessionDetail} from '../model/types';
import {useApp} from '../model/store';
import {getSelection,runPending} from '../live/execution';
import {describe,open} from '../live/controller';
import {Button} from '../ui/primitives';
import {toScreenshot} from './screenshot';
import '../styles/verification.css';

async function request<T>(sessionId:string,operation:ReviewOperation):Promise<T>{
  const result=await getBridge()?.service.review(sessionId,operation);
  if(!result)throw new Error('The desktop connection is unavailable.');
  if(!result.ok)throw new Error(describe(result.error));
  return result.value as T;
}
const errorText=(error:unknown)=>error instanceof Error?error.message:'The review could not be updated. Refresh and try again.';
const labels={proposed:'Proposed',needs_review:'Needs human review',passed:'Check passed',failed:'Check failed',stale:'Stale — check again'};

/** Polls only this account/session; late requests cannot populate a replacement view. */
function useReview<T>(d:SessionDetail,kind:'acceptance'|'reviewers'){
  const account=useApp(s=>s.account?.id),[data,setData]=useState<T|null>(null),[error,setError]=useState(''),[revision,setRevision]=useState(0);
  const refresh=()=>setRevision(value=>value+1);
  useEffect(()=>{
    if(d.source!=='live')return;
    let disposed=false,loading=false;
    const load=async()=>{if(loading)return;loading=true;try{
      if(kind==='acceptance'&&d.capabilities.configure&&d.status!=='running'){
        const sync=await getBridge()?.inference.syncVerification(d.id);
        if(sync&&!sync.ok&&!['SESSION_ACTIVE','session_active'].includes(sync.error.code))throw new Error(describe(sync.error));
      }
      const value=await request<T>(d.id,{kind});
      if(!disposed&&useApp.getState().account?.id===account){setData(value);setError('');}
    }catch(error){if(!disposed){setError(errorText(error));setData(null);}}finally{loading=false;}};
    void load();const timer=setInterval(()=>void load(),5000);return()=>{disposed=true;clearInterval(timer);};
  },[d.id,d.source,d.status,d.capabilities.configure,kind,account,revision]);
  return {data,error,refresh};
}

export function VerificationPanel({d}:{d:SessionDetail}){
  const {data,error,refresh}=useReview<AcceptanceSnapshot>(d,'acceptance');
  const [text,setText]=useState(''),[command,setCommand]=useState(''),[editing,setEditing]=useState<AcceptanceCriterion|null>(null),[busy,setBusy]=useState(false);
  const account=useApp(s=>s.account?.id),mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const current=()=>mounted.current&&useApp.getState().account?.id===account;
  const perform=async(task:()=>Promise<unknown>)=>{if(busy)return;setBusy(true);try{await task();if(current())refresh();}catch(error){if(current())useApp.getState().toast(errorText(error),'error');}finally{if(current())setBusy(false);}};
  if(d.source!=='live')return <div className="review-panel"><h3>Team verification</h3><p>Open a live session to agree on requirements and record actual verification evidence.</p></div>;
  const host=d.capabilities.configure,idle=d.status!=='running',canWrite=d.capabilities.submit&&idle;
  const save=()=>perform(async()=>{
    await request(d.id,editing?{kind:'revise',requestId:crypto.randomUUID(),criterionId:editing.id,expectedVersion:editing.version,text,checkCommand:command.trim()||null}:{kind:'propose',requestId:crypto.randomUUID(),text,checkCommand:command.trim()||null});
    if(current()){setText('');setCommand('');setEditing(null);}
  });
  const verify=()=>perform(async()=>{
    const selected=getSelection();if(!selected)throw new Error('Choose an AI connection and model first.');
    const result=await getBridge()!.inference.verify({sessionId:d.id,connectionId:selected.connectionId,model:selected.model});
    if(!result.ok)throw new Error(describe(result.error));
    if(current())await open(d.id);
  });
  return <div className="review-panel">
    <div className="review-heading"><h3>Team verification</h3><Button size="sm" icon={RefreshCw} disabled={busy} onClick={refresh}>Refresh</Button></div>
    <p className="field-help">Agree on requirements. The host locks each check; a separate reviewer examines actual results. Human acceptance is recorded separately.</p>
    {host&&<p className="field-help">Check output is shared with admitted participants and browser reviewers. The host computer runs the commands using its current approval settings.</p>}
    {error&&<p role="alert" className="tone-danger">{error}</p>}
    {host&&<Button icon={Play} variant="primary" disabled={busy||!idle||!data?.criteria.some(item=>item.state==='approved')} onClick={()=>void verify()}>Run checks and reviewer</Button>}
    <p className="field-help">{data?.revision?`Source revision ${data.revision.slice(0,12)}. Checks apply to these source bytes.`:'Source revision is unconfirmed. Existing evidence stays stale.'}</p>
    {data?.criteria.filter(item=>item.state!=='withdrawn').map(item=><CriterionCard key={`${item.id}:${item.version}`} item={item} d={d} busy={busy} currentRevision={data.revision} perform={perform} edit={()=>{setEditing(item);setText(item.text);setCommand(item.checkCommand??'');}}/>)}
    {data?.criteria.length===0&&<p>No requirements yet. Add a behavior the team can check.</p>}
    {canWrite&&<form className="review-form" onSubmit={event=>{event.preventDefault();void save();}}>
      <h4>{editing?'Revise requirement (approval needed again)':'Propose a requirement'}</h4>
      <label>Required behavior<textarea required maxLength={2000} value={text} onChange={event=>setText(event.target.value)} placeholder="A double-click on Pay creates only one order."/></label>
      <label>Check command (optional)<input maxLength={2000} value={command} onChange={event=>setCommand(event.target.value)} placeholder="npm test -- checkout"/></label>
      <p className="field-help">Leave the command empty for manual review. Approving a requirement locks this command; execution still uses the host’s approval settings.</p>
      <div className="review-actions">{editing&&<Button type="button" onClick={()=>{setEditing(null);setText('');setCommand('');}}>Cancel</Button>}<Button type="submit" icon={Plus} disabled={busy||!text.trim()}>Save proposal</Button></div>
    </form>}
  </div>;
}
export function CriterionCard({item,d,busy,currentRevision,perform,edit}:{item:AcceptanceCriterion;d:SessionDetail;busy:boolean;currentRevision:string|null;perform:(task:()=>Promise<unknown>)=>Promise<void>;edit:()=>void}){
  const [comment,setComment]=useState('');
  const evidence=item.evidence,host=d.capabilities.configure,idle=d.status!=='running';
  const status=!idle&&evidence?'stale':item.status;
  const canReview=idle&&d.capabilities.submit&&item.state==='approved'&&evidence&&evidence.criterionVersion===item.version&&evidence.revision===currentRevision;
  const review=(decision:'accept'|'reject')=>perform(()=>request(d.id,{kind:'decision',requestId:crypto.randomUUID(),criterionId:item.id,criterionVersion:item.version,evidenceId:evidence!.id,revision:evidence!.revision,decision,...(comment.trim()?{comment:comment.trim()}:{})}));
  const repair=()=>perform(async()=>{
    const result=await getBridge()!.service.postMessage(d.id,{requestId:crypto.randomUUID(),kind:'instruction',text:`Repair the implementation to satisfy this approved requirement without weakening its check:\n${item.text}\nLocked check: ${item.checkCommand??'Human review'}\nRecorded evidence: ${evidence?.output.slice(0,3000)??'No evidence'}\nAfter repairing, the host will rerun verification.`});
    if(!result.ok)throw new Error(describe(result.error));await open(d.id);await runPending(d.id);
  });
  return <article className={`requirement-card status-${status}`}>
    <div className="review-heading"><strong>{item.text}</strong><span className="review-status">{labels[status]}</span></div>
    <small>Proposed by {item.authorName} · version {item.version} · {item.state}</small>
    {item.checkCommand&&<pre>{item.checkCommand}</pre>}
    {host&&idle&&<div className="review-actions">{item.state==='proposed'&&<Button size="sm" icon={Check} disabled={busy} onClick={()=>void perform(()=>request(d.id,{kind:'approve',requestId:crypto.randomUUID(),criterionId:item.id,expectedVersion:item.version}))}>Approve requirement</Button>}<Button size="sm" disabled={busy} onClick={edit}>Revise</Button><Button size="sm" disabled={busy} onClick={()=>void perform(()=>request(d.id,{kind:'revise',requestId:crypto.randomUUID(),criterionId:item.id,expectedVersion:item.version,text:item.text,withdraw:true}))}>Withdraw</Button></div>}
    {evidence&&<details><summary>Recorded evidence · {evidence.kind==='command'?`exit ${evidence.exitCode??'unknown'}`:'manual review'} · {new Date(evidence.createdAt).toLocaleString()}</summary><p className="field-help">Host-recorded result at source {evidence.revision.slice(0,12)}. A successful command does not prove complete coverage.</p><pre>{evidence.output}</pre></details>}
    {evidence?.reviews.map(review=><p className="review-vote" key={review.reviewerId}>{review.reviewerName}: <strong>{review.decision==='accept'?'accepted behavior':'requested changes'}</strong>{status==='stale'?' (prior evidence)':''}{review.comment?` — ${review.comment}`:''}</p>)}
    {canReview&&<div className="review-form"><label>Review note<input value={comment} maxLength={2000} onChange={event=>setComment(event.target.value)}/></label><div className="review-actions"><Button size="sm" disabled={busy} onClick={()=>void review('accept')}>Accept behavior</Button><Button size="sm" disabled={busy} onClick={()=>void review('reject')}>Request changes</Button></div></div>}
    {host&&idle&&(item.status==='failed'||evidence?.reviews.some(review=>review.decision==='reject'))&&<Button size="sm" disabled={busy} onClick={()=>void repair()}>Ask agent to repair</Button>}
  </article>;
}

export function BrowserReviewPanel({d}:{d:SessionDetail}){
  const {data,error,refresh}=useReview<BrowserReviewers>(d,'reviewers'),[link,setLink]=useState(''),[busy,setBusy]=useState(false);
  const account=useApp(s=>s.account?.id),mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return()=>{mounted.current=false;};},[]);
  const current=()=>mounted.current&&useApp.getState().account?.id===account;
  const perform=async(task:()=>Promise<unknown>)=>{if(busy)return;setBusy(true);try{await task();if(current())refresh();}catch(error){if(current())useApp.getState().toast(errorText(error),'error');}finally{if(current())setBusy(false);}};
  const create=()=>perform(async()=>{const result=await request<{link:string}>(d.id,{kind:'invite',expiresInSeconds:86400});if(current())setLink(result.link);});
  return <section className="review-panel browser-review-panel"><h3>Browser reviewers</h3><p className="field-help">Invite a teammate to comment, mark a shared screenshot and review evidence from their browser. Names are self-chosen; admit only someone you recognize. Reviewers cannot run agents or approve commands.</p>
    {error&&<p role="alert" className="tone-danger">{error}</p>}
    <Button size="sm" icon={Plus} disabled={busy} onClick={()=>void create()}>Create one-day invitation</Button>
    {link&&<div className="review-form"><input readOnly value={link} aria-label="Browser invitation" onFocus={event=>event.target.select()}/><Button size="sm" icon={Copy} onClick={()=>void navigator.clipboard.writeText(link).catch(()=>useApp.getState().toast('Select and copy the invitation link.','info'))}>Copy link</Button></div>}
    {data?.invitations.map(invite=><div className="review-row" key={invite.id}><small>Invitation expires {new Date(invite.expiresAt).toLocaleString()}</small><Button size="sm" disabled={busy} onClick={()=>void perform(()=>request(d.id,{kind:'revokeInvite',invitationId:invite.id}))}>Revoke</Button></div>)}
    {data?.reviewers.map(person=><div className="review-row" key={person.id}><span>{person.name} · {person.status}</span><div className="review-actions">{person.status==='pending'&&<Button size="sm" icon={UserCheck} disabled={busy} onClick={()=>void perform(()=>request(d.id,{kind:'admit',reviewerId:person.id,decision:'admit'}))}>Admit</Button>}{person.status!=='revoked'&&<Button size="sm" disabled={busy} onClick={()=>void perform(()=>request(d.id,{kind:'admit',reviewerId:person.id,decision:'revoke'}))}>{person.status==='pending'?'Decline':'Remove'}</Button>}</div></div>)}
    <label className="review-upload">Share a screenshot with admitted reviewers<input type="file" accept="image/png,image/jpeg,image/webp" disabled={busy||(data?.screenshots.length??0)>=5} onChange={event=>{const file=event.target.files?.[0];event.target.value='';if(file)void perform(async()=>{const image=await toScreenshot(file);if(current())await request(d.id,{kind:'screenshot',image,label:file.name.slice(0,120)});});}}/></label>
    {data?.screenshots.map(screenshot=><div className="review-screenshot" key={screenshot.id}><img src={screenshot.image} alt={screenshot.label}/><span>{screenshot.label}</span><Button size="sm" icon={Trash2} disabled={busy} onClick={()=>void perform(()=>request(d.id,{kind:'removeScreenshot',screenshotId:screenshot.id}))}>Stop sharing</Button></div>)}
  </section>;
}
