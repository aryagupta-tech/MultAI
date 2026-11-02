import {beforeEach,expect,it,vi} from 'vitest';
import type {TerminalEvent} from '../bridge/execution';
const fake=vi.hoisted(()=>({api:{} as Record<string,ReturnType<typeof vi.fn>>,toast:vi.fn(),terminal:undefined as undefined|((event:TerminalEvent)=>void),account:undefined as undefined|((state:any,previous:any)=>void)}));
vi.mock('../bridge/client',()=>({getBridge:()=>({inference:fake.api})}));
vi.mock('../model/store',()=>({useApp:{getState:()=>({toast:fake.toast}),subscribe:(callback:typeof fake.account)=>{fake.account=callback;}}}));
vi.mock('./controller',()=>({describe:(error:{message:string})=>error.message}));
vi.mock('./execution',()=>({getSelection:()=>null}));
import {discardWork,keepOnBranch,refreshWork,resetWork,runInTerminal,startWork,stopTerminal,useWork} from './work';
const deferred=<T,>()=>{let resolve!:(value:T)=>void;return {promise:new Promise<T>(yes=>{resolve=yes;}),resolve};};
beforeEach(()=>{
  resetWork();fake.toast.mockClear();
  fake.api.onTerminal=vi.fn(callback=>{fake.terminal=callback;});fake.api.onRunChange=vi.fn();
  fake.api.workSummary=vi.fn(async()=>({ok:true,value:null}));fake.api.workDiff=vi.fn(async()=>({ok:true,value:[]}));
  fake.api.workDiscard=vi.fn(async()=>({ok:false,error:{message:'Disconnected'}}));
});
it('a failed discard is never reported as successful removal without a loaded summary',async()=>{
  expect(await discardWork('session')).toBe(false);
  expect(fake.toast).not.toHaveBeenCalledWith(expect.stringContaining('removed'),'info');
});
it('account switches clear private work and fence an old in-flight refresh',async()=>{
  const old=deferred<any>();fake.api.workSummary!.mockImplementationOnce(()=>old.promise);
  const request=refreshWork('session');fake.account!({account:{id:'new'}},{account:{id:'old'}});
  old.resolve({ok:true,value:{branch:'private-old-branch'}});await request;
  expect(useWork.getState().summary).toEqual({});expect(fake.api.workDiff).not.toHaveBeenCalled();
});
it('an old refresh cannot delete the replacement account refresh slot',async()=>{
  const old=deferred<any>(),replacement=deferred<any>();
  fake.api.workSummary!.mockImplementationOnce(()=>old.promise).mockImplementationOnce(()=>replacement.promise);
  const first=refreshWork('session');resetWork();const second=refreshWork('session');
  old.resolve({ok:true,value:null});await first;
  expect(refreshWork('session')).toBe(second);replacement.resolve({ok:true,value:null});await second;
});
it('failed terminal IPC restores controls and repeated sends cannot duplicate commands',async()=>{
  const result=deferred<any>();fake.api.terminalRun=vi.fn(()=>result.promise);
  const first=runInTerminal('session','first');await runInTerminal('session','duplicate');
  expect(fake.api.terminalRun).toHaveBeenCalledTimes(1);result.resolve({ok:false,error:{message:'No host'}});await first;
  expect(useWork.getState().terminal.session?.running).toBe(false);
  fake.api.terminalRun.mockRejectedValueOnce(new Error('IPC closed'));await runInTerminal('session','retry');
  expect(useWork.getState().terminal.session?.running).toBe(false);
});
it('late previous-account terminal output cannot repopulate private output',async()=>{
  fake.api.terminalRun=vi.fn(async()=>({ok:true,value:{id:'old-command'}}));
  await runInTerminal('session','secret command');resetWork();
  fake.terminal!({sessionId:'session',id:'old-command',kind:'output',text:'private old output'});
  expect(useWork.getState().terminal).toEqual({});
});
it('a terminal exit arriving before the invoke response is preserved',async()=>{
  fake.api.terminalRun=vi.fn(async()=>{
    fake.terminal!({sessionId:'session',id:'quick',kind:'output',text:'done'});
    fake.terminal!({sessionId:'session',id:'quick',kind:'exit',code:0,stopped:false});
    return {ok:true,value:{id:'quick'}};
  });
  await runInTerminal('session','quick');expect(useWork.getState().terminal.session).toMatchObject({running:false,exit:0,output:expect.stringContaining('done')});
});
it('work preparation failures clear the spinner without an unhandled rejection',async()=>{
  fake.api.startWork=vi.fn(async()=>{throw new Error('IPC closed');});
  await startWork('session','project','title');expect(useWork.getState().busy.session).toBe(null);
});
it('a successful discard clears its diff and fences refreshes from before removal',async()=>{
  const old=deferred<any>();fake.api.workSummary!.mockImplementationOnce(()=>old.promise);
  useWork.setState({changes:{session:[{path:'private.txt'} as never]}});
  const previous=refreshWork('session');
  fake.api.workDiscard!.mockResolvedValueOnce({ok:true,value:null});
  expect(await discardWork('session')).toBe(true);
  expect(useWork.getState().summary.session).toBe(null);expect(useWork.getState().changes.session).toEqual([]);
  old.resolve({ok:true,value:{branch:'removed-branch'}});await previous;
  expect(useWork.getState().summary.session).toBe(null);expect(fake.api.workDiff).not.toHaveBeenCalled();
});
it('account switches during post-operation refresh cannot report another account’s success',async()=>{
  const refresh=deferred<any>();fake.api.workSummary!.mockImplementationOnce(()=>refresh.promise);
  fake.api.workKeep=vi.fn(async()=>({ok:true,value:{branch:'private-branch',commit:'abcdef123'}}));
  const pending=keepOnBranch('session','save');
  await vi.waitFor(()=>expect(fake.api.workSummary).toHaveBeenCalledOnce());
  expect(useWork.getState().busy.session).toBe('keep');
  fake.account!({account:{id:'new'}},{account:{id:'old'}});
  refresh.resolve({ok:true,value:{branch:'private-branch'}});
  expect(await pending).toBe(false);expect(fake.toast).not.toHaveBeenCalled();
  expect(useWork.getState().summary).toEqual({});expect(useWork.getState().busy).toEqual({});
});
it('refresh failures remain handled and preserve the last confirmed worktree',async()=>{
  const summary={branch:'saved-branch'} as never;useWork.setState({summary:{session:summary}});
  fake.api.workSummary!.mockRejectedValueOnce(new Error('IPC closed'));
  await expect(refreshWork('session')).resolves.toBeUndefined();
  expect(useWork.getState().summary.session).toBe(summary);expect(fake.toast).toHaveBeenCalledWith(expect.stringContaining('refreshed'),'error');
  fake.api.workSummary!.mockResolvedValueOnce({ok:false,error:{message:'Disconnected'}});
  await refreshWork('session');expect(useWork.getState().summary.session).toBe(summary);
  fake.api.workSummary!.mockImplementationOnce(()=>{throw new Error('IPC unavailable');});
  await expect(refreshWork('session')).resolves.toBeUndefined();
  expect(fake.toast).toHaveBeenLastCalledWith(expect.stringContaining('refreshed'),'error');
});
it('terminal events buffered before the invoke response must match the confirmed command',async()=>{
  const response=deferred<any>();fake.api.terminalRun=vi.fn(()=>response.promise);
  const pending=runInTerminal('session','new command');
  fake.terminal!({sessionId:'session',id:'old-command',kind:'output',text:'private old output'});
  fake.terminal!({sessionId:'session',id:'old-command',kind:'exit',code:1,stopped:false});
  fake.terminal!({sessionId:'session',id:'new-command',kind:'output',text:'new output'});
  fake.terminal!({sessionId:'session',id:'new-command',kind:'exit',code:0,stopped:false});
  expect(useWork.getState().terminal.session?.running).toBe(true);
  response.resolve({ok:true,value:{id:'new-command'}});await pending;
  expect(useWork.getState().terminal.session).toMatchObject({running:false,exit:0,output:expect.stringContaining('new output')});
  expect(useWork.getState().terminal.session?.output).not.toContain('old output');
});
it('late work preparation and stop failures stay with their original account',async()=>{
  const prepared=deferred<any>(),stopped=deferred<any>();
  fake.api.startWork=vi.fn(()=>prepared.promise);fake.api.terminalStop=vi.fn(()=>stopped.promise);
  const start=startWork('session','project','title'),stop=stopTerminal('session');resetWork();
  prepared.resolve({ok:true,value:{branch:'private-branch'}});stopped.resolve({ok:false,error:{message:'private stop error'}});
  await Promise.all([start,stop]);
  expect(useWork.getState().summary).toEqual({});expect(fake.toast).not.toHaveBeenCalled();
});
