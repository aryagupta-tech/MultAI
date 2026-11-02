import {ApprovalBroker} from './approvals';
import {describe,expect,it,vi} from 'vitest';
import {randomUUID} from 'node:crypto';
import {routeInference} from './router';
import {ConnectionError} from './network';
import type {ConnectionManager} from './connections';
import type {HostCoordinator} from './coordinator';
import {TerminalHost} from './terminal';

vi.mock('electron',()=>({app:{getPath:()=>'/tmp/multai-router-unused'},shell:{openExternal:vi.fn()},safeStorage:{isEncryptionAvailable:()=>false}}));

function fixture(){
  const calls:string[]=[];
  const manager={
    manageChatGPTUsage:vi.fn(async()=>{calls.push('usage');return null;}),
    acknowledgeChatGPTPlan:vi.fn(async(_id:string)=>{calls.push('acknowledge');return null;}),
    remove:vi.fn(async(_id:string)=>{calls.push('remove');return null;}),
  };
  const coordinator={invalidate:vi.fn(async()=>{calls.push('invalidate');})};
  return {manager,coordinator,calls,route:(op:unknown,args:unknown)=>routeInference(manager as unknown as ConnectionManager,coordinator as unknown as HostCoordinator,new ApprovalBroker(()=>undefined),op,args,{projects:{} as never,terminal:{} as never,editors:async()=>[],openIn:async()=>undefined,mcp:{} as never})};
}

describe('inference IPC validation boundaries',()=>{
  it('rejects arbitrary usage URLs, extra fields and malformed acknowledgement identities before dispatch',async()=>{
    const x=fixture();
    for(const [op,args] of [
      ['manageChatGPTUsage',['https://attacker.example']],
      ['manageChatGPTUsage',{url:'https://attacker.example'}],
      ['acknowledgeChatGPTPlan',['not-a-uuid']],
      ['acknowledgeChatGPTPlan',[randomUUID(),'extra']],
      ['__proto__',[]],['constructor',[]],[null,[]],
    ])expect(await x.route(op,args)).toMatchObject({ok:false,error:{code:'invalid_request'}});
    expect(x.calls).toEqual([]);
  });
  it('opens only the native fixed usage action without canceling an active run',async()=>{
    const x=fixture();
    expect(await x.route('manageChatGPTUsage',[])).toEqual({ok:true,value:null});
    expect(x.calls).toEqual(['usage']);
  });
  it('preserves account authorization failures without accepting the welcome acknowledgement',async()=>{
    const x=fixture(),id=randomUUID();
    x.manager.acknowledgeChatGPTPlan.mockRejectedValueOnce(new ConnectionError('stale_account','The account changed.'));
    expect(await x.route('acknowledgeChatGPTPlan',[id])).toEqual({ok:false,error:{code:'stale_account',message:'The account changed.'}});
    expect(x.manager.acknowledgeChatGPTPlan).toHaveBeenCalledWith(id);
    expect(x.calls).toEqual([]);
  });
  it('fences execution before removing a connection and refuses removal if fencing fails',async()=>{
    const x=fixture(),id=randomUUID();
    expect(await x.route('remove',[id])).toEqual({ok:true,value:null});
    expect(x.calls).toEqual(['invalidate','remove']);
    x.calls.length=0;x.manager.remove.mockClear();
    x.coordinator.invalidate.mockRejectedValueOnce(new Error('Synthetic cancellation failure'));
    expect(await x.route('remove',[id])).toMatchObject({ok:false});
    expect(x.manager.remove).not.toHaveBeenCalled();
  });
  it('does not start a terminal command if Stop or sign-out happened during preparation',async()=>{
    for(const stopAll of [false,true]){
      let prepared!:(root:string)=>void;
      const root=new Promise<string>(resolve=>{prepared=resolve;});
      const coordinator={invalidateVerification:vi.fn(async()=>undefined),terminalRoot:vi.fn(()=>root)};
      const terminal=new TerminalHost(()=>undefined),sessionId=randomUUID();
      const pending=routeInference({} as ConnectionManager,coordinator as unknown as HostCoordinator,new ApprovalBroker(()=>undefined),'terminalRun',[sessionId,'echo should-not-run'],{
        projects:{} as never,terminal,editors:async()=>[],openIn:async()=>undefined,mcp:{} as never,
      });
      await vi.waitFor(()=>expect(coordinator.terminalRoot).toHaveBeenCalled());
      if(stopAll)terminal.stopAll();else terminal.stop(sessionId);
      prepared('/multai-canceled-command');
      expect(await pending).toEqual({ok:false,error:{code:'TERMINAL_STOPPED',message:'The command was canceled before it started.'}});
    }
  });
});
