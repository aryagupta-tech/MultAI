import assert from 'node:assert/strict';
import {randomBytes, randomUUID} from 'node:crypto';
import {test} from 'node:test';
import {AuthService} from '../src/auth.js';
import {CollaborationService} from '../src/collaboration.js';
import {BrowserReviewService} from '../src/browser-review.js';
import {OwnerControlService} from '../src/owner-control.js';
import {pkceChallenge, type OidcClient} from '../src/oidc.js';
import type {Config} from '../src/config.js';
import {createTestContext, seedActor, testConfig} from './helpers.js';

const API='https://api.multai.test', WEB='https://app.multai.test';
const config:Config={...testConfig,environment:'production',publicOrigin:API,companionWebOrigin:WEB,companionOrigins:['https://localhost'],desktopClientId:'multai-desktop',desktopCallbackUri:'multai://auth/callback',googleClientId:'synthetic-client',googleClientSecret:'synthetic-secret',googleRedirectUri:`${API}/v1/auth/google/callback`};
const secret=()=>randomBytes(32).toString('base64url');
const browser=(origin=WEB)=>({host:new URL(origin).host,origin,'x-multai-client':'web','sec-fetch-site':'same-origin'});
const oidc:OidcClient={authorizationUrl(input){assert.equal(input.redirectUri,`${API}/v1/auth/google/callback`);const url=new URL('https://synthetic.invalid/authorize');url.searchParams.set('state',input.state);return url.href;},async exchange(input){assert.equal(input.redirectUri,`${API}/v1/auth/google/callback`);return{subject:'synthetic-dedicated-companion',displayName:'Synthetic companion'};}};
const code=(url:string)=>{const parsed=new URL(url);return {flowId:parsed.hash.slice(8).split('.')[0]!,completionCode:parsed.hash.slice(8).split('.')[1]!};};
const cookie=(reply:{headers:Record<string,unknown>})=>String(reply.headers['set-cookie']).split(';')[0]!;

async function begin(ctx:Awaited<ReturnType<typeof createTestContext>>){
  const verifier=secret()+secret();
  const start=await ctx.app.inject({method:'POST',url:'/v1/web/auth/start',headers:browser(),payload:{codeChallenge:pkceChallenge(verifier)}});
  assert.equal(start.statusCode,200,start.body);
  const state=new URL(start.json().authorizationUrl).searchParams.get('state')!;
  const done=await ctx.app.inject({method:'GET',url:`/v1/auth/google/callback?state=${state}&code=synthetic`,headers:{host:new URL(API).host}});
  assert.equal(done.statusCode,303,done.body);
  assert.equal(new URL(String(done.headers.location)).origin,WEB);
  return {verifier,start,done,input:{...code(String(done.headers.location)),codeVerifier:verifier,deviceName:'Synthetic app browser'}};
}

test('new browser sign-in is bound to the app Host, Origin and flow while Google stays on the API',async t=>{
  const ctx=await createTestContext({config,oidc});t.after(()=>ctx.close());
  for(const headers of [browser(API),{...browser(),host:new URL(API).host},{...browser(),origin:'https://evil.invalid'},{...browser(),host:'evil.invalid','x-forwarded-host':new URL(WEB).host,'x-forwarded-origin':WEB},{...browser(),host:new URL(API).host,'x-forwarded-host':new URL(WEB).host,'x-forwarded-origin':WEB},{...browser(),'sec-fetch-site':'same-site'},{...browser(),'x-multai-client':'native'}]){
    const response=await ctx.app.inject({method:'POST',url:'/v1/web/auth/start',headers,payload:{codeChallenge:pkceChallenge(secret()+secret())}});
    assert.equal(response.statusCode,403,response.body);
  }
  const oldTab=await ctx.app.inject({method:'POST',url:'/v1/web/auth/start',headers:browser(API),payload:{codeChallenge:pkceChallenge(secret()+secret())}});
  assert.equal(oldTab.json().error.code,'companion_origin_required');
  assert.equal(oldTab.json().error.message,`Open ${WEB}/app/ to sign in.`);
  assert.equal((await ctx.db.query('SELECT count(*)::int AS n FROM oauth_flows')).rows[0].n,0);
  const {start,done,input}=await begin(ctx);
  const row=(await ctx.db.query('SELECT desktop_callback_uri,provider_redirect_uri FROM oauth_flows WHERE id=$1',[start.json().flowId])).rows[0];
  assert.equal(row.desktop_callback_uri,`${WEB}/app/auth`);
  assert.equal(row.provider_redirect_uri,`${API}/v1/auth/google/callback`);
  assert.equal(new URL(String(done.headers.location)).pathname,'/app/auth');
  const cross=await ctx.app.inject({method:'POST',url:'/v1/web/auth/exchange',headers:browser(API),payload:input});
  assert.equal(cross.statusCode,401,'a proof cannot enroll a cookie on another trusted host');
  const forged=await ctx.app.inject({method:'POST',url:'/v1/web/auth/exchange',headers:{...browser(),host:new URL(API).host,'x-forwarded-host':new URL(WEB).host},payload:input});
  assert.equal(forged.statusCode,403);
  const exchanged=await ctx.app.inject({method:'POST',url:'/v1/web/auth/exchange',headers:browser(),payload:input});
  assert.equal(exchanged.statusCode,200,exchanged.body);
  assert.equal(exchanged.json().refreshToken,undefined);
  assert.match(String(exchanged.headers['set-cookie']),/HttpOnly; SameSite=Strict; Secure$/u);
  assert.doesNotMatch(String(exchanged.headers['set-cookie']),/Domain=/iu);
  assert.equal((await ctx.app.inject({method:'POST',url:'/v1/web/auth/exchange',headers:browser(),payload:input})).statusCode,401);
  const refresh=await ctx.app.inject({method:'POST',url:'/v1/web/auth/refresh',headers:{...browser(),cookie:cookie(exchanged)},payload:{}});
  assert.equal(refresh.statusCode,200,refresh.body);
  const denied=await ctx.app.inject({method:'POST',url:'/v1/web/auth/refresh',headers:{...browser(),host:new URL(API).host,cookie:cookie(refresh)},payload:{}});
  assert.equal(denied.statusCode,403);
  assert.equal(denied.headers['access-control-allow-origin'],undefined);
  assert.equal((await ctx.app.inject({method:'POST',url:'/v1/web/auth/logout',headers:{...browser(),cookie:cookie(refresh)},payload:{}})).statusCode,204);
  assert.equal((await ctx.app.inject({method:'GET',url:'/v1/me',headers:{authorization:`Bearer ${refresh.json().accessToken}`}})).statusCode,401,'logout revoked the browser access token');
  assert.equal((await ctx.app.inject({method:'POST',url:'/v1/web/auth/refresh',headers:{...browser(),cookie:cookie(refresh)},payload:{}})).statusCode,401);
});

test('in-flight API flows finish on their original origin, remain one-use and cannot migrate cookies to app',async t=>{
  const ctx=await createTestContext({config,oidc});t.after(()=>ctx.close());
  const auth=new AuthService(ctx.db,config,oidc);
  for(const path of ['/app/','/app/auth']){
    const verifier=secret()+secret(),started=await auth.start(pkceChallenge(verifier),'web');
    await ctx.db.query('UPDATE oauth_flows SET desktop_callback_uri=$1 WHERE id=$2',[`${API}${path}`,started.flowId]);
    const completion=await auth.callback(new URL(started.authorizationUrl).searchParams.get('state')!,'synthetic');
    assert.equal(new URL(completion).origin,API,'the legacy verifier remains in API-origin storage');
    assert.equal(new URL(completion).pathname,'/app/auth');
    const input={...code(completion),codeVerifier:verifier,deviceName:'Synthetic legacy browser'};
    assert.equal((await ctx.app.inject({method:'POST',url:'/v1/web/auth/exchange',headers:browser(),payload:input})).statusCode,401);
    const exchanged=await ctx.app.inject({method:'POST',url:'/v1/web/auth/exchange',headers:browser(API),payload:input});
    assert.equal(exchanged.statusCode,200,exchanged.body);
    assert.doesNotMatch(String(exchanged.headers['set-cookie']),/Domain=/iu);
    const refreshed=await ctx.app.inject({method:'POST',url:'/v1/web/auth/refresh',headers:{...browser(API),cookie:cookie(exchanged)},payload:{}});
    assert.equal(refreshed.statusCode,200,refreshed.body);
    assert.equal((await ctx.app.inject({method:'POST',url:'/v1/web/auth/logout',headers:{...browser(API),cookie:cookie(refreshed)},payload:{}})).statusCode,204);
  }
});

test('CORS grants explicit native headers or same-host browser calls without cross-host cookie permission',async t=>{
  const ctx=await createTestContext({config,oidc});t.after(()=>ctx.close());
  const preflight=async(host:string,origin:string,path='/v1/controller/status')=>ctx.app.inject({method:'OPTIONS',url:path,headers:{host,origin,'access-control-request-method':'GET'}});
  const same=await preflight(new URL(WEB).host,WEB);
  assert.equal(same.statusCode,204);assert.equal(same.headers['access-control-allow-origin'],WEB);assert.equal(same.headers['access-control-allow-credentials'],undefined);
  const cross=await preflight(new URL(API).host,WEB);
  assert.equal(cross.headers['access-control-allow-origin'],undefined);
  const native=await preflight(new URL(API).host,'https://localhost');
  assert.equal(native.statusCode,204);assert.equal(native.headers['access-control-allow-origin'],'https://localhost');assert.equal(native.headers['access-control-allow-credentials'],undefined);
  const cookieRoute=await preflight(new URL(WEB).host,WEB,'/v1/web/auth/refresh');
  assert.equal(cookieRoute.headers['access-control-allow-origin'],undefined);
  assert.equal((await preflight(new URL(WEB).host,'https://evil.invalid')).headers['access-control-allow-origin'],undefined);
});

async function project(ctx:Awaited<ReturnType<typeof createTestContext>>){
  const owner=await seedActor(ctx.db,'Synthetic original host');
  const session=await new CollaborationService(ctx.db).createSession(owner.actor,{requestId:randomUUID(),message:{kind:'discussion',text:'Synthetic private session'}}) as {session:{id:string}};
  return{owner,sessionId:session.session.id};
}
async function publicKey(usage:'sign'|'deriveKey'){
  const keys=await crypto.subtle.generateKey({name:usage==='sign'?'ECDSA':'ECDH',namedCurve:'P-256'},true,usage==='sign'?['sign','verify']:['deriveKey','deriveBits']);
  const jwk=await crypto.subtle.exportKey('jwk',keys.publicKey);
  return{kty:'EC',crv:'P-256',x:jwk.x!,y:jwk.y!};
}

test('app-host controller cookies preserve confirmation, same-host CSRF and original-host revocation',async t=>{
  const ctx=await createTestContext({config,oidc});t.after(()=>ctx.close());
  const {owner,sessionId}=await project(ctx),service=new OwnerControlService(ctx.db,API);
  const {pairing}=await service.createPairing(owner.actor,{sessionIds:[sessionId]});
  const credential=secret(),body={code:pairing.code,requestId:randomUUID(),credential,deviceName:'Synthetic browser phone',platform:'web',signingKey:await publicKey('sign'),encryptionKey:await publicKey('deriveKey')};
  const bad=await ctx.app.inject({method:'POST',url:'/v1/controller/claim',headers:{...browser(),host:new URL(API).host},payload:body});assert.equal(bad.statusCode,403);
  const claim=await ctx.app.inject({method:'POST',url:'/v1/controller/claim',headers:browser(),payload:body});assert.equal(claim.statusCode,200,claim.body);
  assert.match(String(claim.headers['set-cookie']),/HttpOnly; SameSite=Strict; Secure$/u);assert.doesNotMatch(String(claim.headers['set-cookie']),/Domain=/iu);
  const jar={...browser(),cookie:cookie(claim)};
  assert.equal((await ctx.app.inject({method:'GET',url:'/v1/controller/status',headers:jar})).json().pairing.status,'awaiting_confirmation');
  const view=await service.getPairing(owner.actor,pairing.id);
  await service.confirmPairing(owner.actor,pairing.id,{keyThumbprint:view.pairing.keyThumbprint,sessionIds:[sessionId]});
  assert.equal((await ctx.app.inject({method:'GET',url:'/v1/controller/status',headers:jar})).json().pairing.status,'active');
  const getWithoutOrigin={host:new URL(WEB).host,'x-multai-client':'web','sec-fetch-site':'same-origin',cookie:cookie(claim)};
  assert.equal((await ctx.app.inject({method:'GET',url:'/v1/controller/status',headers:getWithoutOrigin})).statusCode,200);
  for(const headers of [{...jar,host:new URL(API).host},{...jar,origin:API},{...jar,'sec-fetch-site':'same-site'},{...getWithoutOrigin,host:'evil.invalid','x-forwarded-host':new URL(WEB).host}])assert.equal((await ctx.app.inject({method:'GET',url:'/v1/controller/status',headers})).statusCode,403);
  assert.equal((await ctx.app.inject({method:'POST',url:'/v1/controller/unpair',headers:{...jar,host:new URL(API).host},payload:{}})).statusCode,403,'rejected origin cannot revoke a valid pairing');
  assert.equal((await ctx.app.inject({method:'GET',url:'/v1/controller/status',headers:jar})).statusCode,200);
  await service.revokePairing(owner.actor,pairing.id);
  assert.equal((await ctx.app.inject({method:'GET',url:'/v1/controller/status',headers:jar})).statusCode,403);
  const forget=await ctx.app.inject({method:'POST',url:'/v1/controller/forget',headers:browser(),payload:{}});
  assert.match(String(forget.headers['set-cookie']),/Max-Age=0; HttpOnly; SameSite=Strict; Secure$/u);
});

test('browser review on app remains pending until admission, rejects cross-host origins and loses access on revocation',async t=>{
  const ctx=await createTestContext({config,oidc});t.after(()=>ctx.close());
  const {owner,sessionId}=await project(ctx),service=new BrowserReviewService(ctx.db);
  const {invitation}=await service.createReviewInvitation(owner.actor,sessionId,{});
  const credential=secret(),body={invitationToken:invitation.token,credential,requestId:randomUUID(),name:'Synthetic app guest'};
  const bad=await ctx.app.inject({method:'POST',url:'/v1/browser-review/join',headers:{...browser(),host:new URL(API).host},payload:body});assert.equal(bad.statusCode,403);
  const joined=await ctx.app.inject({method:'POST',url:'/v1/browser-review/join',headers:browser(),payload:body});assert.equal(joined.statusCode,200,joined.body);
  const headers={...browser(),authorization:`Review ${credential}`};
  assert.equal((await ctx.app.inject({method:'POST',url:'/v1/browser-review/view',headers,payload:{}})).json().status,'pending');
  await service.decideReviewer(owner.actor,sessionId,joined.json().reviewer.id,{decision:'admit'});
  assert.equal((await ctx.app.inject({method:'POST',url:'/v1/browser-review/view',headers,payload:{}})).json().status,'admitted');
  const cross=await ctx.app.inject({method:'POST',url:'/v1/browser-review/view',headers:{...headers,host:new URL(API).host,'x-forwarded-host':new URL(WEB).host},payload:{}});assert.equal(cross.statusCode,403);
  const native=await ctx.app.inject({method:'POST',url:'/v1/browser-review/view',headers:{host:new URL(API).host,origin:'https://localhost',authorization:`Review ${credential}`},payload:{}});assert.equal(native.statusCode,200,'native header authentication remains supported');
  await service.decideReviewer(owner.actor,sessionId,joined.json().reviewer.id,{decision:'revoke'});
  assert.equal((await ctx.app.inject({method:'POST',url:'/v1/browser-review/view',headers,payload:{}})).statusCode,403);
});
