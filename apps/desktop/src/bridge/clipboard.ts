import {getBridge} from './client';

/** The sandboxed desktop uses native IPC; browser previews use the Clipboard API. */
export async function copyText(text:string):Promise<void>{
  const bridge=getBridge();
  if(bridge?.writeClipboard){
    const result=await bridge.writeClipboard(text);
    if(!result.ok)throw new Error(result.error.message);
    return;
  }
  if(!globalThis.navigator?.clipboard?.writeText)throw new Error('Clipboard is unavailable. Select the text and copy it manually.');
  await navigator.clipboard.writeText(text);
}
