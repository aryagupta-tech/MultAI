// Live presence: who is online in a session, who is typing and what they're looking at. It comes over
// each session's live connection and is never stored. This device reports its own the same way:
// typing at most every 2 seconds (stopping after 4 idle), and the file or panel in view when it changes.
import {create} from 'zustand';
import {getBridge} from '../bridge/client';
import type {LivePresence,PresenceEntry} from '../bridge/contract';
import type {SessionDetail} from '../model/types';
import {useApp} from '../model/store';

export const usePresence=create<{bySession:Record<string,PresenceEntry[]|undefined>}>()(()=>({bySession:{}}));
const service=()=>getBridge()?.service??null;

/** Overlays the latest presence on a projected session: online, offline, typing, viewing. */
export function withPresence(detail:SessionDetail):SessionDetail {
  const entries=usePresence.getState().bySession[detail.id];
  if(!entries)return detail;
  const me=useApp.getState().account?.id;
  return {...detail,participants:detail.participants.map(participant=>{
    const entry=entries.find(item=>item.userId===participant.id);
    if(participant.id===me)return {...participant,presence:'online',typing:false,viewing:null};
    return entry?{...participant,presence:'online',typing:entry.typing,viewing:entry.viewing}:{...participant,presence:'offline',typing:false,viewing:null};
  })};
}

export function onLivePresence(presence:LivePresence):void {
  usePresence.setState(state=>({bySession:{...state.bySession,[presence.sessionId]:presence.participants}}));
  const detail=useApp.getState().details[presence.sessionId];
  if(detail)useApp.setState(state=>({details:{...state.details,[presence.sessionId]:withPresence(detail)}}));
}

interface Mine {typing:boolean;viewing:string|null;sentAt:number;idle:ReturnType<typeof setTimeout>|null}
const mine=new Map<string,Mine>();
function send(sessionId:string,state:Mine):void {
  state.sentAt=Date.now();
  void service()?.sendPresence(sessionId,{typing:state.typing,viewing:state.viewing}).catch(()=>undefined);
}
const stateFor=(sessionId:string)=>{let state=mine.get(sessionId);if(!state)mine.set(sessionId,state={typing:false,viewing:null,sentAt:0,idle:null});return state;};

/** Called on each keystroke in a session's composer. */
export function reportTyping(sessionId:string):void {
  if(useApp.getState().details[sessionId]?.source!=='live')return;
  const state=stateFor(sessionId);
  if(state.idle)clearTimeout(state.idle);
  state.idle=setTimeout(()=>{state.idle=null;if(state.typing){state.typing=false;send(sessionId,state);}},4000);
  if(!state.typing||Date.now()-state.sentAt>2000){state.typing=true;send(sessionId,state);}
}
/** Stops typing right away (after sending a message). */
export function stopTyping(sessionId:string):void {
  const state=mine.get(sessionId);
  if(!state?.typing)return;
  if(state.idle)clearTimeout(state.idle);
  state.idle=null;state.typing=false;send(sessionId,state);
}
/** The file or panel this device shows for a session; null when nothing in particular. */
export function reportViewing(sessionId:string,viewing:string|null):void {
  if(useApp.getState().details[sessionId]?.source!=='live')return;
  const state=stateFor(sessionId);
  const value=viewing?.slice(0,200)??null;
  if(state.viewing===value)return;
  state.viewing=value;send(sessionId,state);
}
