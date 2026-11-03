import {describe,expect,it} from 'vitest';
import {MemoryStore} from '@multai/companion-core';
import {JoinIntent} from '../src/join-intent';
const TOKEN='A'.repeat(43),OTHER='B'.repeat(43),FLOW='11111111-1111-4111-8111-111111111111';
const fragment=(flow=FLOW)=>`signin=${flow}.${'C'.repeat(43)}`;
function fixture(){const store=new MemoryStore();let now=1_000;const intent=new JoinIntent(store,'https://api.multai.si',()=>now);return {store,intent,advance:(ms:number)=>{now+=ms;}};}
describe('browser invitation return intent',()=>{
  it('survives a new app instance but requires the verified matching sign-in flow',()=>{
    const x=fixture();expect(x.intent.remember(TOKEN)).toBe(true);
    x.store.set('account.pendingFlow',JSON.stringify({flowId:FLOW,expiresAt:30_000,verifier:'never copied into the invitation intent'}));x.intent.bindFlow();
    const reopened=new JoinIntent(x.store,'https://api.multai.si',()=>2_000);
    expect(reopened.resume()).toBe(TOKEN);expect(reopened.afterSignIn(fragment())).toBe(TOKEN);expect(reopened.resume()).toBeNull();
  });
  it('never transfers an invitation from another origin or an unrelated OAuth flow',()=>{
    const x=fixture();x.intent.remember(TOKEN);x.store.set('account.pendingFlow',JSON.stringify({flowId:FLOW,expiresAt:30_000}));x.intent.bindFlow();
    expect(new JoinIntent(x.store,'https://other.example',()=>2_000).resume()).toBeNull();
    expect(x.intent.afterSignIn(fragment('22222222-2222-4222-8222-222222222222'))).toBeNull();expect(x.intent.resume()).toBe(TOKEN);
    expect(x.intent.afterSignIn('signin=invalid')).toBeNull();
  });
  it('keeps legacy API and new app invitation intents separate in both directions',()=>{
    const store=new MemoryStore(),api=new JoinIntent(store,'https://api.multai.si',()=>1_000),app=new JoinIntent(store,'https://app.multai.si',()=>1_000);
    api.remember(TOKEN);expect(app.resume()).toBeNull();
    app.remember(OTHER);expect(api.resume()).toBe(TOKEN);expect(app.resume()).toBe(OTHER);
    app.clear();expect(api.resume()).toBe(TOKEN);expect(app.resume()).toBeNull();
  });
  it('expires old links, validates input, and does not retain a PKCE verifier',()=>{
    const x=fixture();expect(x.intent.remember('malformed')).toBe(false);x.intent.remember(TOKEN);
    const key='companion.joinIntent.v1:https://api.multai.si';expect(x.store.get(key)).not.toContain('verifier');
    x.advance(15*60_000);expect(x.intent.resume()).toBeNull();expect(x.store.get(key)).toBeNull();
    x.store.set(key,JSON.stringify({token:TOKEN,expiresAt:Infinity,flowId:null}));expect(x.intent.resume()).toBeNull();
  });
  it('only the latest invitation can return and clearing abandons it explicitly',()=>{
    const x=fixture();x.intent.remember(TOKEN);x.store.set('account.pendingFlow',JSON.stringify({flowId:FLOW,expiresAt:30_000}));x.intent.bindFlow();
    x.intent.remember(OTHER);expect(x.intent.afterSignIn(fragment())).toBeNull();expect(x.intent.resume()).toBe(OTHER);x.intent.clear();expect(x.intent.resume()).toBeNull();
  });
  it('caps the invitation to the OAuth expiry and fails safely when storage is blocked',()=>{
    const x=fixture();x.intent.remember(TOKEN);x.store.set('account.pendingFlow',JSON.stringify({flowId:FLOW,expiresAt:2_000}));x.intent.bindFlow();x.advance(1_001);expect(x.intent.afterSignIn(fragment())).toBeNull();
    const blocked={get(){throw Error('blocked');},set(){throw Error('blocked');},remove(){throw Error('blocked');}};
    const noStore=new JoinIntent(blocked,'https://api.multai.si');expect(noStore.resume()).toBeNull();expect(noStore.remember(TOKEN)).toBe(false);expect(()=>noStore.clear()).not.toThrow();
  });
});
