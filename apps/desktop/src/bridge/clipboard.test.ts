import {afterEach,expect,test,vi} from 'vitest';
import {copyText} from './clipboard';
afterEach(()=>vi.unstubAllGlobals());
test('desktop copying uses native IPC, never the denied renderer clipboard permission',async()=>{
  const write=vi.fn(async()=>({ok:true,value:null})),browser=vi.fn();
  vi.stubGlobal('window',{multai:{writeClipboard:write}});vi.stubGlobal('navigator',{clipboard:{writeText:browser}});
  await copyText('synthetic invitation');expect(write).toHaveBeenCalledWith('synthetic invitation');expect(browser).not.toHaveBeenCalled();
});
test('native copy failure propagates instead of showing false success',async()=>{
  vi.stubGlobal('window',{multai:{writeClipboard:async()=>({ok:false,error:{message:'Unavailable'}})}});
  await expect(copyText('synthetic')).rejects.toThrow('Unavailable');
});
test('browser fallback waits for success and rejects unavailable or denied clipboards',async()=>{
  vi.stubGlobal('window',{});const write=vi.fn(async()=>{});vi.stubGlobal('navigator',{clipboard:{writeText:write}});
  await copyText('text');expect(write).toHaveBeenCalledWith('text');
  write.mockRejectedValueOnce(new Error('Denied'));await expect(copyText('text')).rejects.toThrow('Denied');
  vi.stubGlobal('navigator',{});await expect(copyText('text')).rejects.toThrow('Clipboard is unavailable');
});
