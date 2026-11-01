import {describe,expect,it,vi} from 'vitest';
import {effortLimits,nativeEffort} from './coordinator';

vi.mock('electron',()=>({app:{getPath:()=>'/tmp/multai-effort-unused'},shell:{openExternal:vi.fn()},safeStorage:{isEncryptionAvailable:()=>false}}));

const levels=['low','medium','high','xhigh','max'] as const;
const meta={kind:'compatible',baseUrl:'https://api.meta.ai/v1'};

describe('reasoning levels',()=>{
  it('stay inside the runtime\'s agent and stream bounds at every level',()=>{
    for(const credentials of [meta,{kind:'openai'}] as {kind:string;baseUrl?:string}[]){
      let previous=0;
      for(const level of levels){
        const limits=effortLimits(level,credentials);
        expect(limits.maxOutputTokens,level).toBeLessThanOrEqual(65_536);
        expect(limits.maxIterations,level).toBeLessThanOrEqual(32);
        expect(limits.maxToolCalls,level).toBeLessThanOrEqual(64);
        expect(limits.deadlineMs,level).toBeLessThanOrEqual(300_000);
        expect(limits.maxEvents,level).toBeLessThanOrEqual(50_000);
        expect(limits.maxOutputTokens,level).toBeGreaterThan(previous);
        previous=limits.maxOutputTokens;
      }
    }
  });
  it('sends the provider\'s own setting only where it is accepted, and never at medium',()=>{
    expect(levels.map(level=>nativeEffort(level,{kind:'chatgpt'}))).toEqual(['low',undefined,'high','xhigh','xhigh']);
    expect(levels.map(level=>nativeEffort(level,meta))).toEqual(['low',undefined,'high','high','high']);
    expect(levels.map(level=>nativeEffort(level,{kind:'anthropic'}))).toEqual(levels.map(()=>undefined));
  });
});
