import {EventEmitter} from 'node:events';
import {describe,expect,it,vi} from 'vitest';
import type WebSocket from 'ws';
import type {ConnectionSummary} from '../../src/bridge/inference';
import {META_TRANSCRIBE_MODEL,OPENAI_TRANSCRIBE_MODEL,SAMPLE_RATE,chooseVoiceConnection,transcribeMeta,transcribeOpenAI,wav} from './voice';

const second=Buffer.alloc(SAMPLE_RATE*2);
const connection=(id:string,provider:ConnectionSummary['provider'],status:ConnectionSummary['status']='ready'):ConnectionSummary=>({id,name:id,provider,status,baseUrl:''});

class FakeSocket extends EventEmitter {sent:Record<string,unknown>[]=[];closed=false;send(data:string){this.sent.push(JSON.parse(data));}close(){this.closed=true;}}
function meta(){
  const socket=new FakeSocket();const urls:string[]=[];const headers:Record<string,string>[]=[];
  const factory=(url:string,h:Record<string,string>)=>{urls.push(url);headers.push(h);return socket as unknown as WebSocket;};
  return {socket,urls,headers,factory};
}

describe('voice instructions',()=>{
  it('uses the selected connection when it can transcribe, else Meta, else OpenAI; never Claude, Kimi or a ChatGPT plan',()=>{
    const all=[connection('claude','anthropic'),connection('plan','chatgpt'),connection('oai','openai'),connection('muse','meta'),connection('kimi','kimi')];
    expect(chooseVoiceConnection(all,'oai')?.id).toBe('oai');
    expect(chooseVoiceConnection(all,'claude')?.id).toBe('muse');
    expect(chooseVoiceConnection(all.filter(item=>item.id!=='muse'),'claude')?.id).toBe('oai');
    expect(chooseVoiceConnection([connection('claude','anthropic'),connection('plan','chatgpt')],null)).toBeNull();
    expect(chooseVoiceConnection([connection('muse','meta','sign-in-required')],null)).toBeNull();
  });

  it('wraps PCM in a valid WAV header and refuses recordings that are too short, too long or odd-sized',async()=>{
    const file=wav(Buffer.from([1,2,3,4]));
    expect(file.subarray(0,4).toString()).toBe('RIFF');
    expect(file.readUInt32LE(24)).toBe(SAMPLE_RATE);
    expect(file.readUInt32LE(40)).toBe(4);
    const fetcher=vi.fn();
    await expect(transcribeOpenAI({apiKey:'k'},Buffer.alloc(100),fetcher as unknown as typeof fetch,new AbortController().signal)).rejects.toMatchObject({code:'VOICE_TOO_SHORT'});
    await expect(transcribeOpenAI({apiKey:'k'},Buffer.alloc(SAMPLE_RATE*2*91),fetcher as unknown as typeof fetch,new AbortController().signal)).rejects.toMatchObject({code:'VOICE_TOO_LONG'});
    await expect(transcribeOpenAI({apiKey:'k'},Buffer.alloc(SAMPLE_RATE*2+1),fetcher as unknown as typeof fetch,new AbortController().signal)).rejects.toMatchObject({code:'VOICE_INVALID'});
    expect(fetcher).not.toHaveBeenCalled();
  });

  it('sends OpenAI one WAV file with its transcription model and reads the text',async()=>{
    let seen:{url:string;init:RequestInit}|undefined;
    const fetcher=async(url:string|URL|Request,init?:RequestInit)=>{seen={url:String(url),init:init!};return new Response(JSON.stringify({text:'  use   cents, not floats '}),{headers:{'content-type':'application/json'}});};
    const text=await transcribeOpenAI({apiKey:'sk-synthetic'},second,fetcher as typeof fetch,new AbortController().signal);
    expect(text).toBe('use cents, not floats');
    expect(seen?.url).toBe('https://api.openai.com/v1/audio/transcriptions');
    expect((seen?.init.headers as Record<string,string>).authorization).toBe('Bearer sk-synthetic');
    const form=seen?.init.body as FormData;
    expect(form.get('model')).toBe(OPENAI_TRANSCRIBE_MODEL);
    expect((form.get('file') as File).size).toBe(44+second.length);
    const refused=async()=>new Response('{}',{status:401});
    await expect(transcribeOpenAI({apiKey:'bad'},second,refused as typeof fetch,new AbortController().signal)).rejects.toMatchObject({code:'provider_credentials_invalid'});
    const silent=async()=>new Response(JSON.stringify({text:''}));
    await expect(transcribeOpenAI({apiKey:'k'},second,silent as typeof fetch,new AbortController().signal)).rejects.toMatchObject({code:'VOICE_EMPTY'});
  });

  it('streams the recording to Muse Voice Transcribe, commits it and reads the transcript',async()=>{
    const x=meta();
    const pcm=Buffer.alloc(SAMPLE_RATE*2*3);
    const result=transcribeMeta({apiKey:'meta-key'},pcm,new AbortController().signal,x.factory);
    expect(x.urls[0]).toBe(`wss://api.meta.ai/v1/realtime?model=${META_TRANSCRIBE_MODEL}&intent=transcription`);
    expect(x.headers[0]?.authorization).toBe('Bearer meta-key');
    x.socket.emit('open');
    expect(x.socket.sent[0]).toMatchObject({type:'transcription_session.update',session:{input_audio_format:'pcm16',input_audio_transcription:{model:META_TRANSCRIBE_MODEL},turn_detection:null}});
    const appended=x.socket.sent.filter(item=>item.type==='input_audio_buffer.append');
    expect(appended.reduce((sum,item)=>sum+Buffer.from(String(item.audio),'base64').length,0)).toBe(pcm.length);
    expect(x.socket.sent.at(-1)).toEqual({type:'input_audio_buffer.commit'});
    x.socket.emit('message',Buffer.from('not json'));
    x.socket.emit('message',Buffer.from(JSON.stringify({type:'conversation.item.input_audio_transcription.delta',delta:'agent 2: '})));
    x.socket.emit('message',Buffer.from(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',transcript:'agent 2: use cents'})));
    await expect(result).resolves.toBe('agent 2: use cents');
    expect(x.socket.closed).toBe(true);
  });

  it('reports Meta errors, a refused key, cancellation and silence, and keeps what it heard on a timeout',async()=>{
    const failing=meta();
    const failed=transcribeMeta({apiKey:'k'},second,new AbortController().signal,failing.factory);
    failing.socket.emit('message',Buffer.from(JSON.stringify({type:'error',error:{message:'bad audio'}})));
    await expect(failed).rejects.toMatchObject({code:'VOICE_FAILED'});

    const refused=meta();
    const denied=transcribeMeta({apiKey:'k'},second,new AbortController().signal,refused.factory);
    refused.socket.emit('unexpected-response',{},{statusCode:401});
    await expect(denied).rejects.toMatchObject({code:'provider_credentials_invalid'});

    const canceled=meta();const controller=new AbortController();
    const stopped=transcribeMeta({apiKey:'k'},second,controller.signal,canceled.factory);
    controller.abort();
    await expect(stopped).rejects.toMatchObject({code:'VOICE_CANCELED'});

    const silent=meta();
    const empty=transcribeMeta({apiKey:'k'},second,new AbortController().signal,silent.factory);
    silent.socket.emit('message',Buffer.from(JSON.stringify({type:'conversation.item.input_audio_transcription.completed',transcript:'  '})));
    await expect(empty).rejects.toMatchObject({code:'VOICE_EMPTY'});

    const slow=meta();
    const partial=transcribeMeta({apiKey:'k'},second,new AbortController().signal,slow.factory,50);
    slow.socket.emit('message',Buffer.from(JSON.stringify({type:'conversation.item.input_audio_transcription.delta',delta:'half a sentence'})));
    await expect(partial).resolves.toBe('half a sentence');

    const quiet=meta();
    await expect(transcribeMeta({apiKey:'k'},second,new AbortController().signal,quiet.factory,30)).rejects.toMatchObject({code:'VOICE_TIMEOUT'});
  });
});
