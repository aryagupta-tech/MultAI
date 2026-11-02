import {describe,expect,it,vi} from 'vitest';
vi.mock('electron',()=>({net:{fetch:vi.fn()}}));
import {isNewer,latestRelease,releaseFrom} from './update';

describe('update check',()=>{
  it('compares x.y.z versions, with or without a v',()=>{
    expect(isNewer('v0.1.1','0.1.0')).toBe(true);
    expect(isNewer('0.2.0','0.1.9')).toBe(true);
    expect(isNewer('1.0.0','0.9.9')).toBe(true);
    expect(isNewer('0.1.0','0.1.0')).toBe(false);
    expect(isNewer('0.0.9','0.1.0')).toBe(false);
    expect(isNewer('v0.2.0-beta','0.1.0')).toBe(false);
  });
  it('only offers a published, newer release page of this repository',()=>{
    const page='https://github.com/aryagupta-tech/MultAI/releases/tag/v0.2.0';
    expect(releaseFrom({tag_name:'v0.2.0',html_url:page},'0.1.0')).toEqual({version:'0.2.0',url:page});
    expect(releaseFrom({tag_name:'v0.2.0',html_url:page,draft:true},'0.1.0')).toBeNull();
    expect(releaseFrom({tag_name:'v0.2.0',html_url:page,prerelease:true},'0.1.0')).toBeNull();
    expect(releaseFrom({tag_name:'v0.2.0',html_url:'https://evil.example/MultAI'},'0.1.0')).toBeNull();
    expect(releaseFrom({tag_name:'v0.1.0',html_url:page},'0.1.0')).toBeNull();
    expect(releaseFrom(null,'0.1.0')).toBeNull();
  });
  it('treats no releases, errors and timeouts as nothing to show, and checks at most every six hours',async()=>{
    const notFound=vi.fn(async()=>new Response('{}',{status:404}));
    expect(await latestRelease('0.1.0',notFound as unknown as typeof fetch,1)).toBeNull();
    expect(await latestRelease('0.1.0',notFound as unknown as typeof fetch,2)).toBeNull();
    expect(notFound).toHaveBeenCalledTimes(1);
    const later=6*60*60*1000+10;
    const failing=vi.fn(async()=>{throw new Error('offline');});
    expect(await latestRelease('0.1.0',failing as unknown as typeof fetch,later)).toBeNull();
    const found=vi.fn(async()=>new Response(JSON.stringify({tag_name:'v0.3.0',html_url:'https://github.com/aryagupta-tech/MultAI/releases/tag/v0.3.0'})));
    expect(await latestRelease('0.1.0',found as unknown as typeof fetch,later+1)).toEqual({version:'0.3.0',url:'https://github.com/aryagupta-tech/MultAI/releases/tag/v0.3.0'});
  });
});
