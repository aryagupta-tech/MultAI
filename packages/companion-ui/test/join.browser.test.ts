import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {chromium,type Browser,type Page} from 'playwright';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it} from 'vitest';

const ORIGIN='https://api.multai.test',TOKEN='A'.repeat(43),FLOW='11111111-1111-4111-8111-111111111111';
const ID='22222222-2222-4222-8222-222222222222';
const session={accessToken:'B'.repeat(43),expiresIn:3600,deviceId:ID};

// Real UI/navigation and WebCrypto, with a synthetic identity transport (never Google or a real account).
describe.skipIf(!existsSync(chromium.executablePath()))('browser invitations',()=>{
  let browser:Browser,page:Page,bundle:string,signedIn:boolean,exchangeCount:number,joinCount:number,errors:string[];
  beforeAll(async()=>{
    const result=await build({stdin:{resolveDir:fileURLToPath(new URL('../../',import.meta.url)),loader:'tsx',contents:`
      import {StrictMode} from 'react';
      import {createRoot} from 'react-dom/client';
      import {safePlainStore,MemoryKeyStore} from '@multai/companion-core';
      import {CompanionApp} from './companion-ui/src/App';
      import {parseLinks} from './companion-ui/src/platform';
      const opened=parseLinks(location.hash);history.replaceState(null,'',location.pathname);
      const platform={kind:'web',origin:location.origin,version:'test',
        account:{secure:null,flows:safePlainStore(()=>sessionStorage),deviceName:()=> 'Browser fixture',openSignIn:async url=>{window.__signInOpened=url;}},
        controller:{secure:null,plain:safePlainStore(()=>localStorage),keys:new MemoryKeyStore(),platform:'web',deviceName:()=> 'Browser fixture'},
        initialLinks:()=>opened,clearLinks:()=>{},onLink:()=>()=>{},onResume:()=>()=>{}};
      createRoot(document.getElementById('root')).render(<StrictMode><CompanionApp platform={platform}/></StrictMode>);
    `},bundle:true,write:false,format:'iife',jsx:'automatic',platform:'browser',define:{'process.env.NODE_ENV':'"development"'},logLevel:'silent'});
    bundle=result.outputFiles[0]!.text;browser=await chromium.launch({headless:true});
  },30000);
  afterAll(async()=>{await browser?.close();});
  beforeEach(async()=>{
    const context=await browser.newContext();page=await context.newPage();signedIn=false;exchangeCount=0;joinCount=0;errors=[];
    page.setDefaultTimeout(5000);
    page.on('pageerror',error=>errors.push(error.message));
    await page.route('https://accounts.example.test/**',route=>route.fulfill({contentType:'text/html',body:'Synthetic sign-in provider'}));
    await page.route(`${ORIGIN}/**`,async route=>{
      const request=route.request(),path=new URL(request.url()).pathname;
      const json=(data:unknown,status=200)=>route.fulfill({status,contentType:'application/json',body:JSON.stringify(data)});
      if(path==='/app/'||path==='/app/auth')return route.fulfill({contentType:'text/html',body:`<!doctype html><div id="root"></div><script>${bundle}</script>`});
      if(path==='/v1/web/auth/refresh')return signedIn?json(session):json({error:{code:'unauthorized',message:'Sign in first.'}},401);
      if(path==='/v1/web/auth/start')return json({flowId:FLOW,authorizationUrl:'https://accounts.example.test/fixture',expiresAt:new Date(Date.now()+300000).toISOString()});
      if(path==='/v1/web/auth/exchange'){exchangeCount++;signedIn=true;return json(session);}
      if(path==='/v1/me')return json({id:ID,displayName:'Synthetic teammate',workspaceId:ID,deviceId:ID});
      if(path==='/v1/invitations/join'){joinCount++;expect(request.postDataJSON()).toEqual({token:TOKEN,name:'Synthetic teammate'});return json({status:'pending',sessionId:ID});}
      return json({error:{code:'unexpected_fixture_call',message:path}},404);
    });
  });
  afterEach(async()=>{expect(errors).toEqual([]);await page.context().close();});
  it('keeps the invitation through a sign-in redirect and reload, with one exchange and explicit join confirmation',async()=>{
    await page.goto(`${ORIGIN}/app/#join=${TOKEN}`);
    await page.getByRole('button',{name:'Sign in with Google',exact:true}).waitFor();
    expect(await page.getByText('Join this session in your browser.',{exact:false}).isVisible()).toBe(true);
    expect(page.url()).toBe(`${ORIGIN}/app/`);expect(joinCount).toBe(0);
    await page.getByRole('button',{name:'Sign in with Google',exact:true}).click();
    await page.waitForFunction(()=>Boolean((window as any).__signInOpened));
    await page.goto('https://accounts.example.test/fixture');
    await page.goto(`${ORIGIN}/app/auth#signin=${FLOW}.${'C'.repeat(43)}`);
    await page.getByRole('button',{name:'Ask to join',exact:true}).waitFor();
    expect(page.url()).toBe(`${ORIGIN}/app/auth`);expect(exchangeCount).toBe(1);expect(joinCount).toBe(0);
    await page.reload();await page.getByRole('button',{name:'Ask to join',exact:true}).waitFor();
    expect(joinCount).toBe(0);
    await page.getByRole('button',{name:'Ask to join',exact:true}).evaluate((button:HTMLButtonElement)=>{button.click();button.click();});
    await page.getByText('Request sent',{exact:true}).waitFor();expect(joinCount).toBe(1);
    expect(await page.getByRole('button',{name:'View sessions',exact:true}).isVisible()).toBe(true);
  },20000);
  it('abandoning an invitation clears the retained destination and a fresh home sign-in stays ordinary',async()=>{
    await page.goto(`${ORIGIN}/app/#join=${TOKEN}`);await page.getByRole('button',{name:'Sign in with Google',exact:true}).waitFor();
    await page.getByRole('button',{name:'Back',exact:true}).click();
    expect(await page.evaluate(()=>sessionStorage.getItem('companion.joinIntent.v1:'+location.origin))).toBeNull();
    await page.reload();await page.getByRole('heading',{name:'Companion',exact:true}).waitFor();
    expect(await page.getByRole('heading',{name:'Join a session',exact:true}).count()).toBe(0);expect(joinCount).toBe(0);
  },15000);
  it('browser Back abandons a pasted invitation before a reload or a new sign-in',async()=>{
    await page.goto(`${ORIGIN}/app/`);
    await page.getByLabel('Invitation or review link',{exact:true}).fill(`${ORIGIN}/app/#join=${TOKEN}`);
    await page.getByRole('button',{name:'Open link',exact:true}).click();
    await page.getByRole('heading',{name:'Join a session',exact:true}).waitFor();
    expect(await page.evaluate(()=>sessionStorage.getItem('companion.joinIntent.v1:'+location.origin))).not.toBeNull();
    await page.goBack();await page.getByRole('heading',{name:'Companion',exact:true}).waitFor();
    expect(await page.evaluate(()=>sessionStorage.getItem('companion.joinIntent.v1:'+location.origin))).toBeNull();
    await page.reload();await page.getByRole('heading',{name:'Companion',exact:true}).waitFor();
    expect(joinCount).toBe(0);
  },15000);
});
