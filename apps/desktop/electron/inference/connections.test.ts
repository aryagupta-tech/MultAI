import {afterEach, describe, expect, it, vi} from 'vitest';
import {mkdtemp, readFile, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {createCipheriv, createDecipheriv, randomBytes} from 'node:crypto';
import {ConnectionManager, type ConnectionAccount, type ConnectionRecord} from './connections';
import {SecureConnectionStore, type Encryption} from './secure-store';
import {isPublicAddress, loopbackFetch, publicProviderFetch, validateBaseUrl, validateLocalUrl} from './network';
import {createServer} from 'node:http';

vi.mock('electron', () => ({app:{getPath:()=>'/tmp/multai-synthetic-unused'}, safeStorage:{isEncryptionAvailable:()=>false,getSelectedStorageBackend:()=> 'basic_text'},shell:{openExternal:vi.fn()}}));
const directories: string[] = [];
afterEach(async () => {await Promise.all(directories.splice(0).map(directory => rm(directory,{recursive:true,force:true})));});
const memory = () => {
  const records = new Map<string,ConnectionRecord>();
  return {records, factory: (scope:string) => ({
    load:async () => structuredClone(records.get(scope) ?? {hostId:'urn:uuid:synthetic-host',connections:[]}),
    save:async (value:ConnectionRecord) => {records.set(scope,structuredClone(value));},
  })};
};
function account() {
  const current = {userId:'synthetic-alice',deviceId:'synthetic-device',generation:1};
  const value: ConnectionAccount = {origin:'https://collaboration.example', get accountGeneration(){return current.generation;},identitySnapshot:async()=>({...current})};
  return {current,value};
}

describe('host-only AI connections', () => {
  it('stores keys privately while list/add/change return only whitelisted summaries',async () => {
    const identity=account(), storage=memory();
    const changes:unknown[]=[];
    const manager=new ConnectionManager({account:identity.value,storeFactory:storage.factory,onChange:value=>changes.push(value)});
    const added=await manager.add({provider:'openai',apiKey:'synthetic-api-key-not-a-real-secret'});
    expect(added.provider).toBe('openai');
    expect(JSON.stringify([added,await manager.list(),changes])).not.toContain('synthetic-api-key');
    expect((await manager.resolve(added.id)).apiKey).toBe('synthetic-api-key-not-a-real-secret');
    expect([...storage.records.values()][0]?.connections[0]?.apiKey).toBe('synthetic-api-key-not-a-real-secret');
  });
  it('connects Meta Muse at its fixed endpoint over the Responses API and never accepts another address',async () => {
    const identity=account(),storage=memory();
    const transport=vi.fn(async (url:string,options?:{headers?:Record<string,string>}) => {
      expect(url).toBe('https://api.meta.ai/v1/models');
      expect(options?.headers?.authorization).toBe('Bearer synthetic-meta-key');
      return {object:'list',data:[{id:'muse-wonder-1.0'},{id:'sam-3.1'},{id:'muse-image-1.0'},{id:'muse-voice-transcribe-1.0'},{id:'muse-spark-1.3'}]};
    });
    const manager=new ConnectionManager({account:identity.value,storeFactory:storage.factory,transport});
    const meta=await manager.add({provider:'meta',apiKey:'synthetic-meta-key'});
    expect(meta).toMatchObject({provider:'meta',name:'Meta Muse',baseUrl:'https://api.meta.ai/v1'});
    expect(await manager.resolve(meta.id)).toEqual({kind:'meta',apiKey:'synthetic-meta-key',baseUrl:'https://api.meta.ai/v1'});
    expect((await manager.models(meta.id)).map(model=>model.id)).toEqual(['muse-spark-1.3','muse-wonder-1.0']);
    await expect(manager.add({provider:'meta',apiKey:'synthetic-meta-key',baseUrl:'https://attacker.example/v1'})).rejects.toHaveProperty('code','invalid_provider_url');
  });
  it('offers Meta\'s documented models only when its live catalog is empty',async () => {
    const identity=account(),storage=memory();
    const transport=vi.fn(async () => ({object:'list',data:[]}));
    const manager=new ConnectionManager({account:identity.value,storeFactory:storage.factory,transport});
    const meta=await manager.add({provider:'meta',apiKey:'synthetic-meta-key'});
    expect((await manager.models(meta.id)).map(model=>model.id)).toEqual(['muse-spark-1.3','muse-wonder-1.0']);
    const openai=await manager.add({provider:'openai',apiKey:'synthetic-openai-key'});
    expect(await manager.models(openai.id)).toEqual([]);
  });
  it('keeps Google account/device/service scopes separate and does not auto-infer on save',async () => {
    const identity=account(),storage=memory(),transport=vi.fn();
    const manager=new ConnectionManager({account:identity.value,storeFactory:storage.factory,transport});
    const alice=await manager.add({provider:'kimi',apiKey:'synthetic-alice-key'});
    expect(transport).not.toHaveBeenCalled();
    identity.current.userId='synthetic-bob'; identity.current.generation++;
    expect(await manager.list()).toEqual([]);
    await expect(manager.resolve(alice.id)).rejects.toHaveProperty('code','connection_not_found');
    identity.current.userId='synthetic-alice'; identity.current.generation++;
    expect((await manager.list())[0]?.id).toBe(alice.id);
    identity.current.deviceId='other-device'; identity.current.generation++;
    expect(await manager.list()).toEqual([]);
  });
  it('discovers actual models from the selected provider and rejects stale account results',async () => {
    const identity=account(),storage=memory();
    let release!:(value:unknown)=>void;
    const transport=vi.fn(async (_url:string,options?:{headers?:Record<string,string>}) => {
      expect(options?.headers?.['x-api-key']).toBe('synthetic-claude-key');
      return new Promise(resolve=>{release=resolve;});
    });
    const manager=new ConnectionManager({account:identity.value,storeFactory:storage.factory,transport});
    const connection=await manager.add({provider:'anthropic',apiKey:'synthetic-claude-key'});
    const response=manager.models(connection.id);
    await vi.waitFor(()=>expect(transport).toHaveBeenCalledOnce());
    identity.current.generation++;
    release({data:[{id:'synthetic-model-from-provider',display_name:'Synthetic provider model'}]});
    await expect(response).rejects.toHaveProperty('code','stale_account');
  });
  it('blocks private, insecure and credential-bearing custom endpoints',async () => {
    const identity=account(),storage=memory();
    const manager=new ConnectionManager({account:identity.value,storeFactory:storage.factory});
    for(const baseUrl of ['http://provider.example/v1','https://localhost/v1','https://127.0.0.1/v1','https://169.254.169.254/latest','https://10.0.0.1/v1','https://[::1]/v1','https://user:pass@provider.example/v1','https://provider.example:8443/v1','https://provider.example/v1?token=bad']) {
      await expect(manager.add({provider:'compatible',baseUrl,apiKey:'synthetic-key'})).rejects.toHaveProperty('code','invalid_provider_url');
    }
    expect(validateBaseUrl('https://provider.example/v1/')).toBe('https://provider.example/v1');
    expect(isPublicAddress('127.0.0.1')).toBe(false);
    expect(isPublicAddress('::ffff:127.0.0.1')).toBe(false);
    expect(isPublicAddress('10.10.10.10')).toBe(false);
    expect(isPublicAddress('8.8.8.8')).toBe(true);
  });
  it('enforces the same endpoint and request bounds on the actual streaming transport',async()=>{
    for(const url of ['https://127.0.0.1/v1/responses','https://169.254.169.254/latest','https://[::1]/v1/responses','http://provider.example/v1/responses']){
      await expect(publicProviderFetch(url,{method:'POST',headers:{authorization:'Bearer synthetic-key'},body:'{}'})).rejects.toHaveProperty('code','invalid_provider_url');
    }
    await expect(publicProviderFetch('https://provider.example/v1/responses',{method:'DELETE'})).rejects.toHaveProperty('code','invalid_provider_request');
    await expect(publicProviderFetch('https://provider.example/v1/responses',{method:'POST',body:'x'.repeat(1_048_577)})).rejects.toHaveProperty('code','provider_request_limit');
  });
});

describe('OS-encrypted connection storage', () => {
  function encryption():Encryption {
    const key=randomBytes(32);
    return {available:()=>true,encrypt:value=>{const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key,iv);const body=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return Buffer.concat([iv,cipher.getAuthTag(),body]);},decrypt:value=>{const cipher=createDecipheriv('aes-256-gcm',key,value.subarray(0,12));cipher.setAuthTag(value.subarray(12,28));return Buffer.concat([cipher.update(value.subarray(28)),cipher.final()]).toString('utf8');}};
  }
  it('writes encrypted private bytes and rejects a swapped scope or unsafe path',async () => {
    const directory=await mkdtemp(path.join(tmpdir(),'multai-inference-store-')); directories.push(directory);
    const crypto=encryption();
    const store=new SecureConnectionStore('https://service.example\nalice',()=>({key:''}),crypto,directory);
    await store.save({key:'synthetic-private-key'});
    expect((await readFile(store.filename)).toString()).not.toContain('synthetic-private-key');
    expect(await store.load()).toEqual({key:'synthetic-private-key'});
    const wrong=new SecureConnectionStore('https://service.example\nbob',()=>({key:''}),crypto,directory);
    await writeFile(wrong.filename,await readFile(store.filename));
    await expect(wrong.load()).rejects.toHaveProperty('code','credential_store_invalid');
    const target=path.join(directory,'untouched.txt'); await writeFile(target,'untouched');
    const linked=new SecureConnectionStore('https://service.example\nsymlink',()=>({key:''}),crypto,directory);
    await symlink(target,linked.filename);
    await expect(linked.load()).rejects.toHaveProperty('code','credential_store_invalid');
    expect(await readFile(target,'utf8')).toBe('untouched');
  });
  it('fails securely without an unlocked OS keyring and never writes a plaintext fallback',async () => {
    const directory=await mkdtemp(path.join(tmpdir(),'multai-inference-store-')); directories.push(directory);
    const unavailable:Encryption={available:()=>false,encrypt:()=>{throw new Error('Must not encrypt');},decrypt:()=>{throw new Error('Must not decrypt');}};
    const store=new SecureConnectionStore('https://service.example\nalice',()=>({key:''}),unavailable,directory);
    await expect(store.save({key:'synthetic-key'})).rejects.toHaveProperty('code','secure_storage_unavailable');
    await expect(readFile(store.filename)).rejects.toHaveProperty('code','ENOENT');
  });
});

describe('local models (Muse Glimmer, Ollama, LM Studio)', () => {
  it('connects to a server on this computer without a key and lists its models',async () => {
    const seen:string[]=[];
    const server=createServer((request,response)=>{seen.push(`${request.url} ${request.headers.authorization}`);response.setHeader('content-type','application/json');response.end(JSON.stringify({object:'list',data:[{id:'muse-glimmer:30b'},{id:'qwen3:8b'}]}));});
    await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    try{
      const port=(server.address() as {port:number}).port;
      const manager=new ConnectionManager({account:account().value,storeFactory:memory().factory});
      const local=await manager.add({provider:'local',baseUrl:`http://127.0.0.1:${port}/v1/`});
      expect(local).toMatchObject({provider:'local',name:'Local model',baseUrl:`http://127.0.0.1:${port}/v1`,status:'ready'});
      expect(await manager.resolve(local.id)).toMatchObject({kind:'local',baseUrl:`http://127.0.0.1:${port}/v1`});
      expect((await manager.models(local.id)).map(model=>model.id)).toEqual(['muse-glimmer:30b','qwen3:8b']);
      expect(seen).toEqual(['/v1/models Bearer local-model']);
    }finally{await new Promise(resolve=>server.close(resolve));}
  });

  it('refuses anything that is not on this computer, and still wants keys for every other provider',async () => {
    const manager=new ConnectionManager({account:account().value,storeFactory:memory().factory});
    for(const baseUrl of ['http://192.168.1.20:11434/v1','http://example.com/v1','http://localhost.example.com/v1','http://user:pw@localhost:1234/v1','file:///etc/passwd',''])await expect(manager.add({provider:'local',baseUrl})).rejects.toHaveProperty('code','invalid_provider_url');
    expect(()=>manager.add({provider:'openai'})).toThrow(/API key is required/u);
    expect(validateLocalUrl('http://[::1]:8080/v1/')).toBe('http://[::1]:8080/v1');
    await expect(loopbackFetch('http://10.0.0.5:11434/v1/models')).rejects.toHaveProperty('code','invalid_provider_url');
    // The public transport keeps refusing local addresses.
    expect(()=>validateBaseUrl('http://localhost:11434/v1')).toThrow();
  });

  it('says plainly when nothing is running at the address',async () => {
    const server=createServer();await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
    const port=(server.address() as {port:number}).port;await new Promise(resolve=>server.close(resolve));
    const manager=new ConnectionManager({account:account().value,storeFactory:memory().factory});
    const local=await manager.add({provider:'local',baseUrl:`http://localhost:${port}/v1`});
    await expect(manager.models(local.id)).rejects.toHaveProperty('code','local_unreachable');
  });
});
