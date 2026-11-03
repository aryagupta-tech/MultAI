// Browser-host migration regression: real built app, service worker, backend and PostgreSQL schema;
// separate app/API cookie and storage hosts; synthetic OIDC only (no Google or model provider calls).
// TEST_DATABASE_URL=postgresql://… npm run test:origins --workspace @multai/web
import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';
import {cp,mkdir,mkdtemp,readFile,rm,writeFile} from 'node:fs/promises';
import {createServer,type IncomingMessage,type ServerResponse} from 'node:http';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium,type Browser,type Page} from 'playwright';
import {createTestContext,seedActor} from '../../backend/test/helpers.ts';
import {readConfig} from '../../backend/src/config.ts';

const here=path.dirname(fileURLToPath(import.meta.url));
const directory=await mkdtemp(path.join(tmpdir(),'multai-web-origins-'));
const apkName='multai-companion-0.0.1.apk',apk=Buffer.from('Synthetic APK download fixture; never install.');
await cp(path.join(here,'../dist'),directory,{recursive:true});
await mkdir(path.join(directory,'downloads'));
await writeFile(path.join(directory,'downloads',apkName),apk);
await writeFile(path.join(directory,'downloads/latest.json'),JSON.stringify({file:apkName,url:`/app/downloads/${apkName}`}));

type Context=Awaited<ReturnType<typeof createTestContext>>;
type Observation={origin:string;path:string;method:string;authorization:boolean;cookieNames:string[];status?:number;location?:string};
let context:Context|undefined,browser:Browser|undefined,canonical=false,apiOrigin='',webOrigin='';
const requests:Observation[]=[],errors:string[]=[];
let passed=0;
const sha=(value:string)=>createHash('sha256').update(value).digest('base64url');
const cookieNames=(value:string|undefined)=>(value??'').split(';').map(entry=>entry.trim().split('=')[0]!).filter(Boolean);

async function forward(request:IncomingMessage,reply:ServerResponse,origin:string){
  const chunks:Buffer[]=[];for await(const chunk of request)chunks.push(Buffer.from(chunk));
  const body=Buffer.concat(chunks);
  const observation:Observation={origin,path:request.url!,method:request.method!,authorization:Boolean(request.headers.authorization),cookieNames:cookieNames(request.headers.cookie)};
  requests.push(observation);
  const response=await context!.app.inject({
    method:request.method as 'GET'|'POST'|'PUT'|'PATCH'|'DELETE'|'HEAD'|'OPTIONS',
    url:request.url!,headers:request.headers,...(body.length?{payload:body}:{}),
  });
  observation.status=response.statusCode;if(typeof response.headers.location==='string')observation.location=response.headers.location;
  reply.writeHead(response.statusCode,response.headers);reply.end(response.rawPayload);
}
const server=(host:'api'|'app')=>createServer((request,reply)=>{
  void(async()=>{
    const pathname=new URL(request.url!,'http://fixture.invalid').pathname;
    if(pathname==='/probe'){reply.setHeader('content-type','text/html');reply.end('<!doctype html><title>Origin probe</title>');return;}
    if(host==='app'&&pathname==='/'){reply.writeHead(302,{location:'/app/'});reply.end();return;}
    // Mirrors the deployment redirect. /app/auth is deliberately kept on the legacy API host so an
    // already-started flow can still use that tab's original PKCE verifier and host-only cookie.
    if(host==='api'&&canonical&&(pathname==='/app'||pathname.startsWith('/app/'))&&pathname!=='/app/auth'){
      reply.writeHead(302,{location:`${webOrigin}${request.url!}`,'cache-control':'no-store'});reply.end();return;
    }
    await forward(request,reply,host==='app'?webOrigin:apiOrigin);
  })().catch(()=>{reply.writeHead(500);reply.end('Browser test proxy failed.');});
});
const api=server('api'),web=server('app');
const listen=(server:ReturnType<typeof createServer>)=>new Promise<number>((resolve,reject)=>{
  server.once('error',reject);server.listen(0,'127.0.0.1',()=>resolve((server.address() as {port:number}).port));
});
async function step(name:string,work:()=>Promise<void>){
  let timer:ReturnType<typeof setTimeout>|undefined;
  try{await Promise.race([work(),new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error(`Timed out: ${name}`)),30_000);})]);}
  finally{clearTimeout(timer);}
  passed++;process.stdout.write(`✔ ${name}\n`);
}
const stays=(page:Page)=>assert.equal(new URL(page.url()).origin,webOrigin,'browser address stays on the app host');

try{
  apiOrigin=`http://127.0.0.1:${await listen(api)}`;
  webOrigin=`http://localhost:${await listen(web)}`;
  context=await createTestContext({
    config:readConfig({NODE_ENV:'test',DATABASE_URL:process.env.TEST_DATABASE_URL!,PUBLIC_ORIGIN:apiOrigin,COMPANION_WEB_ORIGIN:webOrigin,COMPANION_DIR:directory,GOOGLE_CLIENT_ID:'synthetic-browser-origin-client',GOOGLE_CLIENT_SECRET:'synthetic-browser-origin-secret'}),
    oidc:{
      authorizationUrl(input){
        assert.equal(input.redirectUri,`${apiOrigin}/v1/auth/google/callback`);
        const url=new URL('https://identity.example.invalid/authorize');
        url.searchParams.set('state',input.state);url.searchParams.set('redirect_uri',input.redirectUri);return url.toString();
      },
      async exchange(input){assert.equal(input.redirectUri,`${apiOrigin}/v1/auth/google/callback`);return {subject:'synthetic-origin-teammate',displayName:'Origin teammate'};},
    },
  });
  const host=await seedActor(context.db,'Origin host');
  async function hostCall(route:string,body?:unknown,method:'GET'|'POST'='POST'){
    const response=await context!.app.inject({method,url:route,headers:{host:new URL(apiOrigin).host,authorization:`Bearer ${host.token}`},...(body===undefined?{}:{payload:body as Record<string,unknown>})});
    assert.ok(response.statusCode<400,`host fixture ${route}: ${response.statusCode}`);return response.json();
  }
  const created=await hostCall('/v1/sessions',{requestId:randomUUID(),title:'Two-host browser session',message:{kind:'instruction',text:'Keep every browser API call on the app host.'}});
  const sessionId=created.session.id as string;
  const invitation=await hostCall(`/v1/sessions/${sessionId}/invitations`,{expiresInSeconds:3600});
  const token=invitation.invitation.token as string;

  browser=await chromium.launch({headless:true});
  const browsing=await browser.newContext({acceptDownloads:true});
  const page=await browsing.newPage();page.setDefaultTimeout(10_000);
  page.on('pageerror',error=>errors.push(error.message));
  const snapshots:{origin:string;flow:string|null;intent:string|null;keys:string[]}[]=[];
  await page.exposeFunction('__captureOriginStorage',(snapshot:typeof snapshots[number])=>{snapshots.push(snapshot);});
  await page.addInitScript(()=>{
    const original=Storage.prototype.setItem;
    Storage.prototype.setItem=function(key,value){
      original.call(this,key,value);
      if(this===sessionStorage&&(key==='account.pendingFlow'||key.startsWith('companion.joinIntent.v1:'))){
        const capture=(window as unknown as {__captureOriginStorage:(value:unknown)=>Promise<void>}).__captureOriginStorage;
        void capture({origin:location.origin,flow:sessionStorage.getItem('account.pendingFlow'),intent:sessionStorage.getItem('companion.joinIntent.v1:'+location.origin),keys:Object.keys(sessionStorage)});
      }
    };
  });
  let releaseProvider=()=>{},providerSeen=()=>{};
  const providerReady=new Promise<void>(resolve=>{providerSeen=resolve;});
  const providerGate=new Promise<void>(resolve=>{releaseProvider=resolve;});
  await page.route('https://identity.example.invalid/**',async route=>{
    const url=new URL(route.request().url());providerSeen();await providerGate;
    const callback=new URL(url.searchParams.get('redirect_uri')!);callback.searchParams.set('state',url.searchParams.get('state')!);callback.searchParams.set('code','synthetic-authorization-code');
    await route.fulfill({status:302,headers:{location:callback.toString()}});
  });

  await step('a previously installed API-origin service worker follows the app redirect and preserves invitation fragments',async()=>{
    await page.goto(`${apiOrigin}/app/`);await page.getByRole('heading',{name:'Companion',exact:true}).waitFor();
    await page.evaluate(async()=>{await navigator.serviceWorker.ready;});
    await page.waitForFunction(()=>Boolean(navigator.serviceWorker.controller));
    await page.evaluate(()=>sessionStorage.setItem('account.pendingFlow','legacy-api-storage'));
    await browsing.addCookies([{name:'multai_web_refresh',value:'L'.repeat(43),url:`${apiOrigin}/v1/web/auth`,httpOnly:true,sameSite:'Strict'}]);
    // A hash-only change in an already open old tab makes no request at all; simulate a reopened
    // invitation so the old worker and the canonical HTTP redirect both participate.
    await page.goto(`${apiOrigin}/probe`);
    canonical=true;
    await page.goto(`${apiOrigin}/app/#join=${token}`);
    await page.getByRole('heading',{name:'Join a session',exact:true}).waitFor();
    stays(page);assert.equal(new URL(page.url()).hash,'');
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('account.pendingFlow')),null);
  });

  await step('new PKCE and invitation state stay on the app host through the API Google callback and reload',async()=>{
    await page.getByRole('button',{name:'Sign in with Google',exact:true}).evaluate((button:HTMLButtonElement)=>button.click());
    await providerReady;
    const stored=snapshots.findLast(value=>value.origin===webOrigin&&value.flow&&value.intent)!;
    const flow=JSON.parse(stored.flow!) as {flowId:string;verifier:string};
    const intent=JSON.parse(stored.intent!) as {token:string;flowId:string};
    assert.equal(intent.token,token);assert.equal(intent.flowId,flow.flowId);
    assert.ok(!stored.keys.some(key=>key.includes(apiOrigin)));
    const saved=(await context!.db.query('SELECT desktop_challenge,desktop_callback_uri,provider_redirect_uri FROM oauth_flows WHERE id=$1',[flow.flowId])).rows[0]!;
    assert.equal(saved.desktop_challenge,sha(flow.verifier));
    assert.equal(saved.desktop_callback_uri,`${webOrigin}/app/auth`);assert.equal(saved.provider_redirect_uri,`${apiOrigin}/v1/auth/google/callback`);
    const callbackResponse=page.waitForResponse(response=>response.url().startsWith(`${apiOrigin}/v1/auth/google/callback?`));
    releaseProvider();
    await callbackResponse;
    // The installed worker can expose a followed navigation response to Playwright; check the actual
    // backend redirect and then the committed page address, rather than an intermediate browser event.
    const handoff=requests.findLast(request=>request.path.startsWith('/v1/auth/google/callback?'))!;
    assert.equal(handoff.status,303);assert.ok(handoff.location?.startsWith(`${webOrigin}/app/auth#signin=`));
    await page.getByRole('button',{name:'Ask to join',exact:true}).waitFor();stays(page);assert.equal(new URL(page.url()).pathname,'/app/auth');assert.equal(new URL(page.url()).hash,'');
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('account.pendingFlow')),null);
    await page.reload();await page.getByRole('button',{name:'Ask to join',exact:true}).waitFor();stays(page);
    const cookies=await browsing.cookies([`${webOrigin}/v1/web/auth`,`${apiOrigin}/v1/web/auth`]);
    const own=cookies.find(cookie=>cookie.name==='multai_web_refresh'&&cookie.domain==='localhost');
    assert.ok(own?.httpOnly);assert.equal(own.sameSite,'Strict');assert.equal(own.path,'/v1/web/auth');
    assert.equal(cookies.find(cookie=>cookie.name==='multai_web_refresh'&&cookie.domain==='127.0.0.1')?.value,'L'.repeat(43));
    assert.ok(!await page.evaluate(()=>document.cookie.includes('multai_web_refresh')));
  });

  await step('explicit joining and live event fetches use the app host without API-host cookies or navigation',async()=>{
    const before=requests.length;
    await page.getByRole('button',{name:'Ask to join',exact:true}).click();await page.getByText('Request sent',{exact:true}).waitFor();stays(page);
    const pending=await hostCall(`/v1/sessions/${sessionId}/join-requests`,undefined,'GET');
    await hostCall(`/v1/sessions/${sessionId}/join-requests/${pending.requests[0].id}/admit`,{role:'collaborator'});
    await page.getByRole('button',{name:'View sessions',exact:true}).click();
    await page.getByRole('button',{name:'Two-host browser session',exact:false}).click();
    await page.getByText('Keep every browser API call on the app host.',{exact:true}).waitFor();stays(page);
    await hostCall(`/v1/sessions/${sessionId}/messages`,{requestId:randomUUID(),kind:'discussion',text:'A fresh event reached the app-origin browser.'});
    await page.getByText('A fresh event reached the app-origin browser.',{exact:true}).waitFor();
    const eventCalls=requests.slice(before).filter(request=>request.path.startsWith(`/v1/sessions/${sessionId}/events?`));
    assert.ok(eventCalls.length>=2,'initial events and subsequent events were fetched');assert.ok(eventCalls.every(request=>request.origin===webOrigin&&request.authorization));
    assert.ok(requests.slice(before).filter(request=>request.path.startsWith('/v1/')).every(request=>request.origin===webOrigin));
    assert.ok(requests.slice(before).filter(request=>request.path.startsWith('/v1/sessions/')).every(request=>!request.cookieNames.includes('multai_web_refresh')));
  });

  await step('pairing links retain the API Android path while browser pairing and its cookie stay on the app host',async()=>{
    const offered=await hostCall('/v1/controller-pairings',{sessionIds:[sessionId],grantSeconds:86400});
    assert.ok(offered.pairing.link.startsWith(`${apiOrigin}/app/#pair=`));
    await page.goto(offered.pairing.link);await page.getByRole('button',{name:'Pair this phone',exact:true}).click();
    await page.locator('.c-sas').waitFor();stays(page);assert.equal(new URL(page.url()).hash,'');
    const reviewed=await hostCall(`/v1/controller-pairings/${offered.pairing.id}`,undefined,'GET');
    await hostCall(`/v1/controller-pairings/${offered.pairing.id}/confirm`,{keyThumbprint:reviewed.pairing.keyThumbprint,sessionIds:[sessionId]});
    await page.getByRole('heading',{name:'Owner control',exact:true}).waitFor();
    const cookie=(await browsing.cookies(`${webOrigin}/v1/controller`)).find(value=>value.name==='multai_controller');
    assert.ok(cookie?.httpOnly);assert.equal(cookie.domain,'localhost');assert.equal(cookie.path,'/v1/controller');assert.equal(cookie.sameSite,'Strict');
    assert.equal((await browsing.cookies(`${apiOrigin}/v1/controller`)).some(value=>value.name==='multai_controller'),false);
    await page.reload();stays(page);await page.getByRole('button',{name:'Open owner control',exact:true}).waitFor();
  });

  await step('guest review links and admission remain on the app host without storing review credentials',async()=>{
    const review=await hostCall(`/v1/sessions/${sessionId}/reviewer-invitations`,{});
    await page.goto(`${apiOrigin}/app/#review=${review.invitation.token}`);
    await page.getByLabel('Your name',{exact:true}).fill('Origin guest');await page.getByRole('button',{name:'Ask to join',exact:true}).click();
    await page.getByText('Waiting for the host to admit you',{exact:true}).waitFor();stays(page);
    const listed=await hostCall(`/v1/sessions/${sessionId}/reviewers`,undefined,'GET');
    await hostCall(`/v1/sessions/${sessionId}/reviewers/${listed.reviewers[0].id}`,{decision:'admit'});
    await page.getByText('Browser reviewer · Origin guest',{exact:true}).waitFor();stays(page);
    await page.getByLabel('Feedback for the team',{exact:true}).fill('Guest feedback reached the app proxy.');await page.getByRole('button',{name:'Send',exact:true}).click();
    await page.getByText('Guest feedback reached the app proxy.',{exact:true}).waitFor();
    assert.equal(await page.evaluate(value=>[...Object.values(localStorage),...Object.values(sessionStorage)].some(entry=>String(entry).includes(value)),review.invitation.token),false);
    assert.ok(requests.filter(request=>request.path.startsWith('/v1/browser-review/')).every(request=>request.origin===webOrigin));
    await page.reload();stays(page);await page.getByRole('heading',{name:'Companion',exact:true}).waitFor();
  });

  await step('PWA assets, manifest and worker are app-scoped, and downloads never replace or enter the offline cache',async()=>{
    await page.goto(webOrigin);await page.getByRole('heading',{name:'Companion',exact:true}).waitFor();stays(page);
    assert.equal(new URL(page.url()).pathname,'/app/');
    const pwa=await page.evaluate(async()=>{
      const registration=await navigator.serviceWorker.ready;
      const manifest=await(await fetch('/app/manifest.webmanifest')).json();
      return {scope:registration.scope,script:registration.active?.scriptURL,manifest,assets:[...document.querySelectorAll<HTMLScriptElement|HTMLLinkElement>('script[src],link[href]')].map(element=>element instanceof HTMLScriptElement?element.src:element.href)};
    });
    assert.equal(pwa.scope,`${webOrigin}/app/`);assert.equal(pwa.script,`${webOrigin}/app/sw.js`);
    assert.equal(pwa.manifest.start_url,'/app/');assert.equal(pwa.manifest.scope,'/app/');assert.equal(pwa.manifest.id,'/app/');
    assert.ok(pwa.assets.every(asset=>new URL(asset).origin===webOrigin&&new URL(asset).pathname.startsWith('/app/')));
    assert.ok(pwa.manifest.icons.every((icon:{src:string})=>new URL(icon.src,webOrigin).origin===webOrigin));
    await page.waitForFunction(()=>Boolean(navigator.serviceWorker.controller));
    const download=page.waitForEvent('download');
    await page.evaluate(origin=>{const link=document.createElement('a');link.href=`${origin}/app/android`;document.body.append(link);link.click();link.remove();},apiOrigin);
    const attachment=await download;assert.equal(attachment.suggestedFilename(),apkName);assert.ok(attachment.url().startsWith(`${webOrigin}/app/downloads/`));
    assert.deepEqual(await readFile((await attachment.path())!),apk);stays(page);
    await page.evaluate(async()=>{await fetch('/app/android');await fetch('/app/downloads/latest.json');});
    const cache=await page.evaluate(async()=>{
      const urls:string[]=[];for(const name of await caches.keys())for(const request of await(await caches.open(name)).keys())urls.push(request.url);
      const shell=await caches.match('/app/');return {urls,shellType:shell?.headers.get('content-type'),shell:await shell?.text()};
    });
    assert.ok(cache.urls.every(url=>new URL(url).origin===webOrigin&&new URL(url).pathname.startsWith('/app/')));
    assert.ok(!cache.urls.some(url=>url.includes('/v1/')||url.includes('/app/android')||url.includes('/app/downloads/')));
    assert.match(cache.shellType??'',/text\/html/u);assert.match(cache.shell??'',/<div id="root"><\/div>/u);
    await browsing.setOffline(true);await page.reload();await page.getByRole('heading',{name:'Companion',exact:true}).waitFor();stays(page);
    await browsing.setOffline(false);
  });

  await step('API and app storage remain separate, with no secret-bearing URLs, API fallback, or browser script errors',async()=>{
    await page.goto(`${apiOrigin}/probe`);
    assert.equal(await page.evaluate(()=>sessionStorage.getItem('account.pendingFlow')),'legacy-api-storage');
    assert.equal(await page.evaluate(origin=>sessionStorage.getItem('companion.joinIntent.v1:'+origin),webOrigin),null);
    await page.goto(`${webOrigin}/app/`);await page.getByRole('heading',{name:'Companion',exact:true}).waitFor();stays(page);
    assert.ok(requests.filter(request=>request.path.startsWith('/v1/web/auth/start')||request.path.startsWith('/v1/web/auth/exchange')).every(request=>request.origin===webOrigin));
    assert.ok(requests.every(request=>!request.path.includes(token)&&!request.path.includes('#')&&!/[?&](access_token|refresh_token|credential|codeVerifier|completionCode)=/u.test(request.path)));
    assert.deepEqual(errors,[]);
  });
  process.stdout.write(`\n${passed}/${passed} two-origin browser checks passed (synthetic identity provider).\n`);
}finally{
  await browser?.close();await context?.close();
  for(const server of [api,web]){server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));}
  await rm(directory,{recursive:true,force:true});
}
