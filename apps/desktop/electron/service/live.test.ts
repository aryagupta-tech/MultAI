import {EventEmitter} from 'node:events';
import {describe,expect,it,vi} from 'vitest';
import type WebSocket from 'ws';
import type {LivePresence} from '../../src/bridge/contract';
import {LiveHub} from './live';

class FakeSocket extends EventEmitter {readyState=1;sent:string[]=[];send(data:string){this.sent.push(data);}terminate(){this.readyState=3;}}
const session='11111111-1111-4111-8111-111111111111';
const user='22222222-2222-4222-8222-222222222222';

describe('live presence',()=>{
  it('passes presence to the renderer and only sends ours once the service has shown it accepts it',async()=>{
    const sockets:FakeSocket[]=[];
    const presence:LivePresence[]=[];
    const account={origin:'https://api.example',accountGeneration:1,authorizationHeader:async()=>'Bearer token',forceRefreshOnNextUse:()=>undefined};
    const hub=new LiveHub(account,()=>undefined,()=>undefined,{socketFactory:()=>{const socket=new FakeSocket();sockets.push(socket);return socket as unknown as WebSocket;},emitPresence:item=>presence.push(item)});
    hub.subscribe(session,0);
    await vi.waitFor(()=>expect(sockets).toHaveLength(1));
    const socket=sockets[0]!;socket.emit('open');
    // An older service would close the stream on any message, so nothing is sent yet.
    hub.sendPresence(session,{typing:true,viewing:null});
    expect(socket.sent).toEqual([]);
    socket.emit('message',Buffer.from(JSON.stringify({type:'presence',participants:[{userId:user,typing:false,viewing:'cart.js'}]})));
    expect(presence).toEqual([{sessionId:session,participants:[{userId:user,typing:false,viewing:'cart.js'}]}]);
    hub.sendPresence(session,{typing:true,viewing:'cart.js'});
    expect(socket.sent.map(item=>JSON.parse(item))).toEqual([{type:'presence',typing:true,viewing:'cart.js'}]);
    hub.closeAll();
  });

  it('reconnects after the computer sleeps, from where it left off',async()=>{
    const sockets:FakeSocket[]=[];const urls:URL[]=[];
    const account={origin:'https://api.example',accountGeneration:1,authorizationHeader:async()=>'Bearer token',forceRefreshOnNextUse:()=>undefined};
    const hub=new LiveHub(account,()=>undefined,()=>undefined,{socketFactory:url=>{urls.push(url);const socket=new FakeSocket();sockets.push(socket);return socket as unknown as WebSocket;}});
    hub.subscribe(session,7);
    await vi.waitFor(()=>expect(sockets).toHaveLength(1));
    sockets[0]!.emit('open');
    hub.suspend();
    expect(sockets[0]!.readyState).toBe(3);
    await vi.waitFor(()=>expect(sockets).toHaveLength(2));
    expect(urls[1]!.searchParams.get('after')).toBe('7');
    hub.closeAll();
  });
});
