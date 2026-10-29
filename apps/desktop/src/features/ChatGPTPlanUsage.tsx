import {useEffect,useId,useRef,useState} from 'react';
import type {ConnectionSummary,InferenceConnectionsApi} from '../bridge/inference';
import {Button} from '../ui/primitives';

/** This exact documented code is a plan/app usage limit, not a balance or reset time. */
export const CHATGPT_USAGE_LIMIT_CODES=['subscription_sharing_usage_limit_exceeded'] as const;
export const isChatGPTUsageLimit=(code:string)=>CHATGPT_USAGE_LIMIT_CODES.some(value=>value===code);

export function ChatGPTPlanUsage({api,limited=false,active=true}:{api:Pick<InferenceConnectionsApi,'manageChatGPTUsage'>;limited?:boolean;active?:boolean}){
  const [error,setError]=useState('');
  const open=async()=>{
    setError('');
    try{const result=await api.manageChatGPTUsage();if(!result.ok)setError(result.error.message);}
    catch{setError('Open ChatGPT Settings → Usage in your browser to manage this app’s access and limits.');}
  };
  return <div role={limited?'alert':undefined} style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
    <span>{limited?'ChatGPT usage limit reached':active?'Using ChatGPT plan':'ChatGPT plan connected'}</span>
    {limited&&<span className="muted">Review your plan or this app’s limit in ChatGPT settings.</span>}
    <Button size="sm" variant={limited?'primary':'ghost'} onClick={()=>void open()}>Manage usage</Button>
    {error&&<span role="alert">{error}</span>}
  </div>;
}

/** Native HTML dialog remains inside a parent settings focus trap while using top-layer modal focus. */
export function ChatGPTPlanWelcome({api,connections}:{api:Pick<InferenceConnectionsApi,'acknowledgeChatGPTPlan'|'manageChatGPTUsage'>;connections:readonly ConnectionSummary[]}){
  const pending=connections.find(connection=>connection.provider==='chatgpt'&&connection.needsPlanWelcome&&connection.status==='ready');
  const dialog=useRef<HTMLDialogElement>(null),restore=useRef<HTMLElement|null>(null);
  const [busy,setBusy]=useState(false),[error,setError]=useState('');
  const id=useId();
  useEffect(()=>{
    const node=dialog.current;if(!node)return;
    setError('');
    if(pending){restore.current=document.activeElement instanceof HTMLElement?document.activeElement:null;if(!node.open)node.showModal();}
    else if(node.open){node.close();restore.current?.focus();}
    return()=>{if(node.open)node.close();};
  },[pending?.id]);
  const acknowledge=async()=>{
    if(!pending||busy)return;setBusy(true);setError('');
    try{const result=await api.acknowledgeChatGPTPlan(pending.id);if(!result.ok)setError(result.error.message);}
    catch{setError('The app could not save this acknowledgement. Try again.');}
    finally{setBusy(false);}
  };
  return <dialog ref={dialog} aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} style={{background:'var(--surface-1)',color:'var(--text)',border:'1px solid var(--border-strong)',borderRadius:14,padding:24,width:'min(460px, 90vw)'}} onCancel={event=>{event.preventDefault();void acknowledge();}} onKeyDown={event=>{event.stopPropagation();if(event.key==='Escape'){event.preventDefault();void acknowledge();}}}>
    <div style={{display:'grid',gap:14}}>
      <h2 id={`${id}-title`}>You’re using your ChatGPT plan</h2>
      <p id={`${id}-description`}>Eligible AI requests in MultAI use your ChatGPT plan or available credits. You can review usage and manage limits in ChatGPT settings.</p>
      <ChatGPTPlanUsage api={api} active={false}/>
      {error&&<p role="alert">{error}</p>}
      <Button variant="primary" onClick={()=>void acknowledge()} disabled={busy}>{busy?'Saving…':'Got it'}</Button>
    </div>
  </dialog>;
}
