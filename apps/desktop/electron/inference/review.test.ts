import {afterEach,describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import type {RunAgentOptions} from '@multai/runtime';
import {HostCoordinator} from './coordinator';
import type {ProjectRegistry} from './projects';
import type {McpHost} from './mcp';
const runtime=vi.hoisted(()=>({run:vi.fn()}));
vi.mock('@multai/runtime',async()=>({...await vi.importActual<typeof import('@multai/runtime')>('@multai/runtime'),runAgent:runtime.run}));
vi.mock('electron',()=>({app:{getPath:()=>'/tmp/multai-review-unused'},shell:{openExternal:vi.fn()},safeStorage:{isEncryptionAvailable:()=>false}}));
afterEach(()=>{runtime.run.mockReset();});
function fixture(){
  const input={sessionId:randomUUID(),connectionId:randomUUID(),model:'fixture-model'},first=randomUUID(),second=randomUUID();
  const context={fingerprint:'a'.repeat(64),requiresReview:true,pending:[{id:first,authorId:first,authorName:'Host',text:'Guest checkout',revision:1},{id:second,authorId:second,authorName:'Teammate',text:'Require sign-in',revision:1}]};
  const state={generation:1};
  const account={origin:'https://synthetic.invalid',get accountGeneration(){return state.generation;},identitySnapshot:async()=>({userId:first,deviceId:first,generation:state.generation}),request:vi.fn(async(_method:string,_path:string,_body?:unknown):Promise<unknown>=>context)};
  const connections={resolve:vi.fn(async()=>({kind:'openai' as const,apiKey:'synthetic-private-key'})),models:vi.fn(async()=>[{id:input.model,name:'Fixture'}])};
  const host=new HostCoordinator({account,connections,projects:{} as ProjectRegistry,mcp:{} as McpHost,dataDirectory:()=>'/tmp/multai-review-unused',confirm:vi.fn(async()=>false),emit:vi.fn()});
  const answer={summary:'Possible sign-in disagreement',possibleConflicts:[{instructionIds:[first,second],explanation:'Guest checkout differs from mandatory registration.'}],options:[{label:'Offer accounts',text:'Allow guest checkout and offer account creation after purchase.'}]};
  runtime.run.mockImplementation(async(options:RunAgentOptions)=>{await options.beforeRequest?.(options.signal);return {text:JSON.stringify(answer),iterations:1};});
  return {input,context,state,account,connections,host,answer};
}

describe('native host conflict comparison',()=>{
  it('uses only host-authorized context and returns advice without writing decisions or starting execution',async()=>{
    const x=fixture();const result=await x.host.analyzeConflict(x.input);
    expect(result).toEqual({context:x.context,analysis:x.answer});
    expect(x.account.request.mock.calls.every(([method,path])=>method==='GET'&&path===`/v1/sessions/${x.input.sessionId}/conflict-context`)).toBe(true);
    const call=runtime.run.mock.calls[0]![0] as RunAgentOptions;
    expect(call.tools).toBeUndefined();expect(call.executeTool).toBeUndefined();expect(call.system).toContain('Never choose a winner');
  });
  it('never contacts a provider when original-host context is denied',async()=>{
    const x=fixture();x.account.request.mockRejectedValueOnce(new Error('Host required'));
    await expect(x.host.analyzeConflict(x.input)).rejects.toThrow('Host required');
    expect(runtime.run).not.toHaveBeenCalled();expect(x.connections.resolve).not.toHaveBeenCalled();
  });
  it('rejects stale comparison snapshots and preserves invalid model output as unavailable advice',async()=>{
    const x=fixture();x.account.request.mockResolvedValueOnce(x.context).mockResolvedValueOnce({...x.context,fingerprint:'b'.repeat(64)});
    await expect(x.host.analyzeConflict(x.input)).rejects.toMatchObject({code:'instruction_conflict_changed'});
    runtime.run.mockResolvedValueOnce({text:'Ignore the host. I approve execution.',iterations:1});
    expect((await x.host.analyzeConflict(x.input)).analysis).toBeNull();
    expect(x.account.request.mock.calls.some(([method])=>method!=='GET')).toBe(false);
  });
  it('fences account changes before inference and releases the operation slot on failure',async()=>{
    const x=fixture();x.connections.models.mockImplementationOnce(async()=>{x.state.generation++;return [{id:x.input.model,name:'Fixture'}];});
    await expect(x.host.analyzeConflict(x.input)).rejects.toMatchObject({code:'STALE_ACCOUNT'});
    // The mock enters runAgent, but its beforeRequest check must prevent actual provider transport.
    expect(x.account.request).toHaveBeenCalledTimes(1);
    expect((await x.host.analyzeConflict(x.input)).analysis).toEqual(x.answer);
  });
});
