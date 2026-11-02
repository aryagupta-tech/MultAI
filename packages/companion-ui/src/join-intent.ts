import type {PlainStore} from '@multai/companion-core';

const TOKEN=/^[A-Za-z0-9_-]{43}$/u;
const FLOW=/^[0-9a-f-]{36}$/u;
const TTL=15*60_000;
interface Intent {token:string;expiresAt:number;flowId:string|null}

/** One invitation per service and browser tab, retained only long enough for sign-in.
 * It grants no membership; both the user and session host still confirm joining.
 */
export class JoinIntent {
  private readonly key:string;
  constructor(private readonly storage:PlainStore,origin:string,private readonly now:()=>number=Date.now){
    this.key=`companion.joinIntent.v1:${new URL(origin).origin}`;
  }
  private read():Intent|null {
    try{
      const raw=this.storage.get(this.key);if(!raw)return null;
      const value=JSON.parse(raw) as Partial<Intent>;
      if(typeof value.token!=='string'||!TOKEN.test(value.token)||typeof value.expiresAt!=='number'||!Number.isFinite(value.expiresAt)||value.expiresAt<=this.now()||value.expiresAt>this.now()+TTL||!(value.flowId===null||typeof value.flowId==='string'&&FLOW.test(value.flowId))){this.clear();return null;}
      return value as Intent;
    }catch{this.clear();return null;}
  }
  resume():string|null {return this.read()?.token??null;}
  remember(token:string):boolean {
    if(!TOKEN.test(token))return false;
    try{this.storage.set(this.key,JSON.stringify({token,expiresAt:this.now()+TTL,flowId:null} satisfies Intent));return this.resume()===token;}
    catch{return false;}
  }
  /** Account stores its generated flow before asking the platform to open the browser. */
  bindFlow():void {
    const intent=this.read();if(!intent)return;
    try{
      const raw=this.storage.get('account.pendingFlow');
      const flow=raw?JSON.parse(raw) as {flowId?:unknown;expiresAt?:unknown}:null;
      if(!flow||typeof flow.flowId!=='string'||!FLOW.test(flow.flowId)||typeof flow.expiresAt!=='number'||!Number.isFinite(flow.expiresAt)||flow.expiresAt<=this.now())throw new Error('Invalid sign-in flow');
      this.storage.set(this.key,JSON.stringify({...intent,flowId:flow.flowId,expiresAt:Math.min(intent.expiresAt,flow.expiresAt)}));
    }catch{throw new Error('Couldn’t keep this invitation for sign-in. Allow browser session storage and try again.');}
  }
  /** Called only after Account has successfully verified this exact callback. */
  afterSignIn(fragment:string):string|null {
    const flowId=/(?:^|[#&])signin=([0-9a-f-]{36})\.[A-Za-z0-9_-]{43}(?:&|$)/u.exec(fragment)?.[1];
    const intent=this.read();
    if(!intent||!flowId||intent.flowId!==flowId)return null;
    this.clear();return intent.token;
  }
  clear():void {try{this.storage.remove(this.key);}catch{/* blocked storage cannot grant access */}}
}
