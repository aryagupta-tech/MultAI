import {EventEmitter} from 'node:events';
import {describe,expect,it,vi} from 'vitest';
import type WebSocket from 'ws';
import type {ConnectionSummary} from '../../src/bridge/inference';
import {META_TRANSCRIBE_MODEL,OPENAI_TRANSCRIBE_MODEL,SAMPLE_RATE,chooseVoiceConnection,transcribeMeta,transcribeOpenAI,wav} from './voice';

const second=Buffer.alloc(SAMPLE_RATE*2);
const connection=(id:string,provider:ConnectionSummary['provider'],status:ConnectionSummary['status']='ready'):ConnectionSummary=>({id,name:id,provider,status,baseUrl:''});

class FakeSocket extends EventEmitter {sent:(Record<string,unknown>|Buffer)[]=[];closed=false;send(data:string|Buffer){this.sent.push(typeof data==='string'?JSON.parse(data):Buffer.from(data));}close(){this.closed=true;}}
function meta(){
  const socket=new FakeSocket();const urls:string[]=[];
  const factory=(url:string)=>{urls.push(url);return socket as unknown as WebSocket;};
  return {socket,urls,factory};
}
const say=(socket:FakeSocket,event:unknown)=>socket.emit('message',Buffer.from(JSON.stringify(event)),false);
const streamed=async(socket:FakeSocket)=>vi.waitFor(()=>expect(socket.sent.at(-1)).toEqual({type:'endStream'}),{timeout:3000});

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
    // Parsed back the way a server would read it.
    const headers=seen?.init.headers as Record<string,string>;
    const form=await new Response(seen?.init.body as Uint8Array<ArrayBuffer>,{headers:{'content-type':headers['content-type']!}}).formData();
    expect(form.get('model')).toBe(OPENAI_TRANSCRIBE_MODEL);
    expect((form.get('file') as File).size).toBe(44+second.length);
    expect((form.get('file') as File).name).toBe('voice.wav');
    const refused=async()=>new Response('{}',{status:401});
    await expect(transcribeOpenAI({apiKey:'bad'},second,refused as typeof fetch,new AbortController().signal)).rejects.toMatchObject({code:'provider_credentials_invalid'});
    const silent=async()=>new Response(JSON.stringify({text:''}));
    await expect(transcribeOpenAI({apiKey:'k'},second,silent as typeof fetch,new AbortController().signal)).rejects.toMatchObject({code:'VOICE_EMPTY'});
  });

  it('hands Muse Voice Transcribe the key in its handshake, streams binary PCM frames, ends the stream and joins the final transcripts',async()=>{
    const x=meta();
    const pcm=Buffer.alloc(SAMPLE_RATE*2);
    const result=transcribeMeta({apiKey:'meta-key'},pcm,new AbortController().signal,x.factory,5000,0);
    expect(x.urls[0]).toBe('wss://api.meta.ai/v1/asr/realtime');
    x.socket.emit('open');
    expect(x.socket.sent[0]).toEqual({authorization:{accessToken:'Bearer meta-key'},audioEncoding:'PCM_24KHZ',model:META_TRANSCRIBE_MODEL,mode:'PUSH_TO_TALK'});
    expect(x.socket.sent).toHaveLength(1); // nothing is streamed before the handshake is accepted
    say(x.socket,{sessionId:'s1'});
    await streamed(x.socket);
    const frames=x.socket.sent.filter((item):item is Buffer=>Buffer.isBuffer(item));
    expect(frames.every(frame=>frame.length<=3840)).toBe(true);
    expect(frames.reduce((sum,frame)=>sum+frame.length,0)).toBe(pcm.length);
    say(x.socket,{type:'transcript',transcript:'agent two',final:false});
    say(x.socket,{type:'transcript',transcript:'Agent two,',final:true});
    say(x.socket,{type:'transcript',transcript:'use cents instead of floats.',final:true});
    x.socket.emit('close',1000);
    await expect(result).resolves.toBe('Agent two, use cents instead of floats.');
  });

  it('reports Meta errors, a refused handshake, rate limits, cancellation and silence, and keeps what it heard',async()=>{
    const failing=meta();
    const failed=transcribeMeta({apiKey:'k'},second,new AbortController().signal,failing.factory,5000,0);
    say(failing.socket,{type:'error',message:'bad audio'});
    await expect(failed).rejects.toMatchObject({code:'VOICE_FAILED'});

    const refused=meta();
    const denied=transcribeMeta({apiKey:'k'},second,new AbortController().signal,refused.factory,5000,0);
    refused.socket.emit('open');refused.socket.emit('close',1008);
    await expect(denied).rejects.toMatchObject({code:'provider_credentials_invalid'});

    const limited=meta();
    const busy=transcribeMeta({apiKey:'k'},second,new AbortController().signal,limited.factory,5000,0);
    limited.socket.emit('close',1013);
    await expect(busy).rejects.toMatchObject({code:'provider_rate_limited'});

    const canceled=meta();const controller=new AbortController();
    const stopped=transcribeMeta({apiKey:'k'},second,controller.signal,canceled.factory,5000,0);
    controller.abort();
    await expect(stopped).rejects.toMatchObject({code:'VOICE_CANCELED'});

    const silent=meta();
    const empty=transcribeMeta({apiKey:'k'},second,new AbortController().signal,silent.factory,5000,0);
    say(silent.socket,{sessionId:'s'});await streamed(silent.socket);silent.socket.emit('close',1000);
    await expect(empty).rejects.toMatchObject({code:'VOICE_EMPTY'});

    const dropped=meta();
    const partial=transcribeMeta({apiKey:'k'},second,new AbortController().signal,dropped.factory,5000,0);
    say(dropped.socket,{sessionId:'s'});say(dropped.socket,{type:'transcript',transcript:'half a sentence',final:false});dropped.socket.emit('close',1011);
    await expect(partial).resolves.toBe('half a sentence');

    const quiet=meta();
    await expect(transcribeMeta({apiKey:'k'},second,new AbortController().signal,quiet.factory,30,0)).rejects.toMatchObject({code:'VOICE_TIMEOUT'});
  });
});
