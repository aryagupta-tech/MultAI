import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {chromium,type Browser,type Page} from 'playwright';
import {afterAll,afterEach,beforeAll,beforeEach,describe,expect,it} from 'vitest';

// These interaction checks run when the workspace's optional Chromium browser is installed.
// No server, network access, or real account is used; the actual components receive a fake preload.
describe.skipIf(!existsSync(chromium.executablePath()))('desktop dialog interactions',()=>{
  let browser:Browser,page:Page,bundle:string;
  let errors:string[];
  beforeAll(async()=>{
    const result=await build({
      stdin:{resolveDir:fileURLToPath(new URL('../../',import.meta.url)),loader:'tsx',contents:`
        import {StrictMode} from 'react';
        import {createRoot} from 'react-dom/client';
        import {ReplayDialog} from './src/features/ReplayDialog';
        import {PairedPhones} from './src/features/PairedPhones';
        import {McpSettings} from './src/features/McpSettings';
        import {VerificationPanel,BrowserReviewPanel} from './src/features/VerificationPanel';
        import {useApp} from './src/model/store';
        const ok=value=>({ok:true,value});
        const account={id:'account-a',name:'Host',email:'host@example.test',initials:'H',hue:0,workspace:'Test'};
        const session={id:'session-a',source:'live',title:'Checkout',objective:'One order',mode:'build',status:'inactive',role:'owner',capabilities:{submit:true,approve:true,configure:true,decide:true,delete:true},hostName:'Host',hostOnline:true,baseline:'main',worktree:'private',model:{id:'fixture',label:'Fixture',engine:'fixture',reasoning:[]},reasoning:'medium',participants:[],timeline:[],decisions:[],changes:[]};
        useApp.setState({account,activeId:session.id,sessions:[{...session,archived:false}],details:{[session.id]:session},toasts:[]});
        window.multai={
          writeClipboard:async()=>ok(null),
          service:{listReplays:async()=>ok({replays:[]}),review:async(id,op)=>ok(op.kind==='acceptance'?{revision:null,criteria:[]}:{invitations:[],reviewers:[],screenshots:[]})},
          inference:{syncVerification:async()=>ok({revision:null}),mcpServers:async()=>ok([]),mcpTest:async()=>ok(['search'])},
          controller:{listPhones:async()=>ok([]),onChange:()=>()=>{},declinePairing:async()=>ok(null)}
        };
        const root=createRoot(document.getElementById('root'));
        window.fixture={store:useApp,session,ok,render(kind,id='session-a',open=true){
          const d={...session,id};
          root.render(<StrictMode>{kind==='replay'?<ReplayDialog sessionId={id} open={open} onClose={()=>window.fixture.render('replay',id,false)}/>:kind==='phones'?<PairedPhones/>:kind==='mcp'?<McpSettings/>:kind==='browser'?<BrowserReviewPanel d={d}/>:<VerificationPanel d={d}/>}</StrictMode>);
        }};
      `},
      bundle:true,write:false,format:'iife',jsx:'automatic',platform:'browser',
      define:{'import.meta.env':'{"MODE":"test"}','process.env.NODE_ENV':'"development"'},
      plugins:[{name:'omit-styles',setup(builder){builder.onLoad({filter:/\.css$/},()=>({contents:'',loader:'css'}));}}],
      outdir:'browser-check',logLevel:'silent',
    });
    bundle=result.outputFiles.find(file=>file.path.endsWith('.js'))!.text;
    browser=await chromium.launch({headless:true});
  },30_000);
  beforeEach(async()=>{
    errors=[];page=await browser.newPage();page.setDefaultTimeout(3000);page.on('pageerror',error=>errors.push(error.message));
    await page.route('https://multai.test/',route=>route.fulfill({contentType:'text/html',body:'<!doctype html><html><body><div id="root"></div></body></html>'}));
    await page.goto('https://multai.test/');await page.addScriptTag({content:bundle});
  });
  afterEach(async()=>{await page.close();expect(errors).toEqual([]);});
  afterAll(async()=>{await browser?.close();});

  it('shows replay loading failures with retry instead of a false empty list',async()=>{
    await page.evaluate(`window.multai.service.listReplays=async()=>({ok:false,error:{code:'network',message:'Watch links unavailable'}});fixture.render('replay')`);
    await page.getByRole('alert').waitFor();
    expect(await page.getByRole('alert').textContent()).toContain('Watch links unavailable');
    expect(await page.getByText('No active links.',{exact:true}).count()).toBe(0);
    expect(await page.getByRole('status').count()).toBe(0);
    await page.evaluate(`window.multai.service.listReplays=async()=>fixture.ok({replays:[]})`);
    await page.getByRole('button',{name:'Retry',exact:true}).click();
    await page.getByText('No active links.',{exact:true}).waitFor();
    expect(await page.getByRole('alert').count()).toBe(0);
  });

  it('deduplicates replay creation, reports real copy status, and removes a revoked share field',async()=>{
    await page.evaluate(`
      window.creates=0;window.rows=[];
      multai.service.listReplays=async()=>fixture.ok({replays:window.rows});
      multai.service.createReplay=()=>{window.creates++;return new Promise(resolve=>window.finishCreate=resolve)};
      multai.writeClipboard=async()=>({ok:false,error:{message:'Clipboard unavailable'}});
      multai.service.revokeReplay=async()=>{window.rows=[];return fixture.ok(null)};
      fixture.render('replay');
    `);
    const create=page.getByRole('button',{name:'Create link',exact:true});
    await create.waitFor();await create.evaluate((button:HTMLButtonElement)=>{button.click();button.click();});
    expect(await page.evaluate('window.creates')).toBe(1);
    await page.evaluate(`window.rows=[{id:'replay-a',createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+86400000).toISOString()}];window.finishCreate(fixture.ok({...window.rows[0],link:'https://watch.test/a'}))`);
    await page.getByRole('textbox',{name:'Replay link',exact:true}).waitFor();
    await page.getByRole('button',{name:'Revoke',exact:true}).waitFor({state:'visible'});
    expect(await page.locator('.replay-link + p').textContent()).not.toContain('Copied.');
    await page.evaluate(`multai.writeClipboard=async()=>fixture.ok(null)`);
    await page.getByRole('button',{name:'Copy link',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('.replay-link + p')?.textContent?.startsWith('Copied.'));
    await page.getByRole('button',{name:'Revoke',exact:true}).click();
    await page.getByRole('textbox',{name:'Replay link',exact:true}).waitFor({state:'detached'});
    await page.getByText('No active links.',{exact:true}).waitFor();
  });

  it('ignores old replay lists and creations after switching sessions or closing',async()=>{
    await page.evaluate(`
      window.oldLists=[];
      multai.service.listReplays=id=>id==='session-a'?new Promise(resolve=>window.oldLists.push(resolve)):Promise.resolve(fixture.ok({replays:[]}));
      multai.service.createReplay=()=>new Promise(resolve=>window.oldCreate=resolve);
      fixture.render('replay');
    `);
    await page.getByRole('button',{name:'Create link',exact:true}).click();
    await page.evaluate(`fixture.render('replay','session-b')`);
    await page.getByText('No active links.',{exact:true}).waitFor();
    await page.evaluate(`
      for(const resolve of window.oldLists)resolve(fixture.ok({replays:[{id:'old',createdAt:new Date().toISOString(),expiresAt:new Date().toISOString()}]}));
      window.oldCreate(fixture.ok({id:'old',link:'https://watch.test/old',expiresAt:new Date().toISOString()}));
    `);
    expect(await page.getByRole('textbox',{name:'Replay link',exact:true}).count()).toBe(0);
    expect(await page.getByRole('button',{name:'Revoke',exact:true}).count()).toBe(0);
    await page.getByRole('button',{name:'Done',exact:true}).click();
    await page.getByRole('dialog').waitFor({state:'detached'});
    expect(await page.evaluate('fixture.store.getState().toasts.length')).toBe(0);
  });

  it('deduplicates verification proposals and accepts refreshed account snapshots',async()=>{
    await page.evaluate(`
      window.proposals=0;
      const read=multai.service.review;
      multai.service.review=(id,op)=>op.kind==='propose'?(window.proposals++,new Promise(resolve=>window.finishProposal=resolve)):read(id,op);
      fixture.render('verification');
    `);
    await page.getByLabel('Required behavior').fill('One order per click');
    await page.locator('form.review-form').evaluate((form:HTMLFormElement)=>{form.requestSubmit();form.requestSubmit();});
    expect(await page.evaluate('window.proposals')).toBe(1);
    await page.evaluate(`fixture.store.setState({account:{...fixture.store.getState().account,name:'Updated host'}});window.finishProposal(fixture.ok({}))`);
    await page.waitForFunction(()=>document.querySelector('textarea')?.value==='');
    await page.getByLabel('Required behavior').fill('Another check');
    expect(await page.getByRole('button',{name:'Save proposal',exact:true}).isEnabled()).toBe(true);
  });

  it('resets review forms and ignores invitations from a previous account',async()=>{
    await page.evaluate(`multai.service.review=(id,op)=>op.kind==='invite'?new Promise(resolve=>window.finishInvite=resolve):Promise.resolve(fixture.ok({invitations:[],reviewers:[],screenshots:[]}));fixture.render('browser')`);
    await page.getByRole('button',{name:'Create one-day invitation',exact:true}).click();
    await page.evaluate(`fixture.store.setState({account:{...fixture.store.getState().account,id:'account-b'}})`);
    await page.waitForFunction(()=>!document.querySelector('button[disabled]'));
    await page.evaluate(`window.finishInvite(fixture.ok({link:'https://watch.test/old-account'}))`);
    expect(await page.getByRole('textbox',{name:'Browser invitation',exact:true}).count()).toBe(0);
    await page.evaluate(`multai.service.review=async(id,op)=>fixture.ok(op.kind==='acceptance'?{revision:null,criteria:[]}:{invitations:[],reviewers:[],screenshots:[]});fixture.render('verification')`);
    await page.getByLabel('Required behavior').fill('Private draft');
    await page.evaluate(`fixture.render('verification','session-b')`);
    await page.waitForFunction(()=>document.querySelector('textarea')?.value==='');
  });

  it('keeps phone polling sequential, advances expiry, and preserves an offer when cancellation fails',async()=>{
    await page.clock.install();
    await page.evaluate(`
      window.reviews=0;
      multai.controller.createPairing=async()=>fixture.ok({id:'offer-a',code:'123456',codeExpiresAt:new Date(Date.now()+2000).toISOString(),sessionIds:['session-a'],qr:[[true]]});
      multai.controller.reviewPairing=()=>{window.reviews++;return new Promise(resolve=>window.finishReview=resolve)};
      multai.controller.declinePairing=async()=>({ok:false,error:{code:'network',message:'Cancel failed'}});
      fixture.render('phones');
    `);
    await page.getByRole('button',{name:'Pair a phone',exact:true}).click();
    await page.getByLabel('Pairing code 1 2 3 4 5 6',{exact:true}).waitFor();
    await page.clock.runFor(6000);
    expect(await page.evaluate('window.reviews')).toBe(1);
    await page.getByText('This code expired. Start again.',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Cancel',exact:true}).click();
    await page.getByRole('alert').waitFor();
    expect(await page.getByRole('alert').textContent()).toContain('Cancel failed');
    expect(await page.getByLabel('Pairing code 1 2 3 4 5 6',{exact:true}).count()).toBe(1);
    await page.evaluate(`multai.controller.declinePairing=async()=>fixture.ok(null)`);
    await page.getByRole('button',{name:'Cancel',exact:true}).click();
    await page.getByRole('button',{name:'Pair a phone',exact:true}).waitFor();
    await page.evaluate(`window.finishReview(fixture.ok({id:'offer-a',status:'awaiting_confirmation',sessionIds:['session-a'],grantSeconds:86400,deviceName:'Old phone',platform:'web',verificationCode:'987654'}))`);
    expect(await page.getByRole('button',{name:'Confirm phone',exact:true}).count()).toBe(0);
  });

  it('refreshes a phone awaiting confirmation and exposes a failed phone list with retry',async()=>{
    await page.clock.install();
    await page.evaluate(`
      multai.controller.listPhones=async()=>({ok:false,error:{code:'network',message:'Phone list unavailable'}});
      multai.controller.createPairing=async()=>fixture.ok({id:'offer-a',code:'123456',codeExpiresAt:new Date(Date.now()+60000).toISOString(),sessionIds:['session-a'],qr:[[true]]});
      window.reviews=0;
      multai.controller.reviewPairing=async()=>fixture.ok({id:'offer-a',status:++window.reviews===1?'awaiting_confirmation':'revoked',sessionIds:['session-a'],grantSeconds:86400,deviceName:'Phone',platform:'web',verificationCode:'987654'});
      fixture.render('phones');
    `);
    await page.getByRole('alert').waitFor();
    expect(await page.getByRole('status').count()).toBe(0);
    await page.evaluate(`multai.controller.listPhones=async()=>fixture.ok([])`);
    await page.getByRole('button',{name:'Retry',exact:true}).click();
    await page.getByText('No phones are paired.',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Pair a phone',exact:true}).click();
    await page.getByRole('button',{name:'Confirm phone',exact:true}).waitFor();
    await page.clock.runFor(1600);
    await page.getByText('This pairing ended. Start again if you meant to pair.',{exact:true}).waitFor();
  });

  it('keeps MCP setup concise, preserves argument and secret bytes, and deduplicates saves',async()=>{
    await page.evaluate(`
      window.saves=0;window.saved=null;
      multai.inference.mcpServers=async()=>fixture.ok(window.saved?[{...window.saved,env:{TOKEN:''}}]:[]);
      multai.inference.mcpSave=value=>{window.saves++;window.saved={...value,id:'mcp-a'};return new Promise(resolve=>window.finishSave=resolve)};
      fixture.render('mcp');
    `);
    await page.getByRole('button',{name:'Add server',exact:true}).click();
    const args=page.getByLabel('Arguments, one per line',{exact:true});
    expect(await args.isVisible()).toBe(false);
    await page.getByLabel('Name',{exact:true}).fill('sample');
    await page.getByLabel('Command',{exact:true}).fill('npx');
    await page.getByText('Arguments and environment',{exact:true}).click();
    await args.fill('-y\npath with spaces\n padded ');
    await page.getByLabel('Environment, NAME=value per line').fill('TOKEN= secret with spaces ');
    await page.locator('form.dialog-body').evaluate((form:HTMLFormElement)=>{form.requestSubmit();form.requestSubmit();});
    expect(await page.evaluate('window.saves')).toBe(1);
    expect(await page.evaluate('window.saved.args')).toEqual(['-y','path with spaces',' padded ']);
    expect(await page.evaluate('window.saved.env')).toEqual({TOKEN:' secret with spaces '});
    await page.evaluate(`window.finishSave(fixture.ok({...window.saved,env:{TOKEN:''}}))`);
    await page.getByRole('dialog').waitFor({state:'detached'});
    await page.getByText('1 tool: search',{exact:true}).waitFor();
    await page.getByRole('button',{name:'Edit sample',exact:true}).click();
    await page.getByText('Arguments and environment',{exact:true}).click();
    expect(await page.getByLabel('Environment, NAME=value per line').inputValue()).toBe('TOKEN=');
    expect(await page.locator('body').textContent()).not.toContain('secret with spaces');
  });

  it('reports MCP delete and test failures without erasing the saved server',async()=>{
    await page.evaluate(`
      multai.inference.mcpServers=async()=>fixture.ok([{id:'mcp-a',name:'sample',command:'npx',args:[],env:{},enabled:true}]);
      multai.inference.mcpDelete=async()=>({ok:false,error:{code:'network',message:'Delete failed'}});
      multai.inference.mcpTest=async()=>{throw new Error('Test failed')};
      fixture.render('mcp');
    `);
    await page.getByRole('button',{name:'Remove sample',exact:true}).click();
    await page.getByRole('alert').waitFor();
    expect(await page.getByRole('alert').textContent()).toContain('Delete failed');
    expect(await page.getByRole('button',{name:'Edit sample',exact:true}).count()).toBe(1);
    await page.getByRole('button',{name:'Test',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('[role="alert"]')?.textContent?.includes('Test failed'));
    expect(await page.getByText('Starting the server…',{exact:true}).count()).toBe(0);
    expect(await page.getByRole('button',{name:'Test',exact:true}).isEnabled()).toBe(true);
  });
});
