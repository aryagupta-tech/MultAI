import {describe, expect, it, vi} from 'vitest';
import {createHash, randomUUID} from 'node:crypto';
import {createLocalJWKSet, exportJWK, generateKeyPair, SignJWT} from 'jose';
import {ChatGptOAuth, verifyChatGptIdentity, type ChatGptRegistration} from './chatgpt';
import {ConnectionManager, type ConnectionAccount, type ConnectionRecord} from './connections';
import type {JsonTransport} from './network';

vi.mock('electron', () => ({app:{getPath:()=>'/tmp/multai-synthetic-unused'}, safeStorage:{isEncryptionAvailable:()=>false,getSelectedStorageBackend:()=> 'basic_text'},shell:{openExternal:vi.fn()}}));
const discovery={issuer:'https://auth.openai.com',authorization_endpoint:'https://auth.openai.com/api/accounts/authorize',token_endpoint:'https://auth.openai.com/api/accounts/oauth/token',jwks_uri:'https://auth.openai.com/.well-known/jwks.json',revocation_endpoint:'https://auth.openai.com/api/accounts/oauth/revoke'};
const bundle={access_token:'synthetic-access',refresh_token:'synthetic-refresh',id_token:'synthetic-id-token',token_type:'Bearer',expires_in:3600,scope:'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct'};
const previous:ChatGptRegistration={clientId:'oaiapp_synthetic',hostId:'urn:uuid:synthetic-host',subject:'synthetic-subject',email:'synthetic@example.test',accessToken:'synthetic-access',refreshToken:'synthetic-refresh',idToken:'synthetic-id',scopes:['chatgpt.tokens.use.direct'],expiresAt:Date.now()+3600000};

describe('official ChatGPT public-client flow',()=>{
  it('registers a dynamic client, binds exact loopback PKCE/nonce/resource, and stores issued ID before exchange',async()=>{
    let authorization!:URL;
    let retained=false;
    const transport:JsonTransport=vi.fn(async(url,options)=>{
      if(url.endsWith('openid-configuration'))return discovery;
      expect(url).toBe(discovery.token_endpoint);
      expect(retained).toBe(true);
      const body=new URLSearchParams(options?.body);
      expect(body.get('client_id')).toBe('oaiapp_synthetic_new');
      expect(body.get('redirect_uri')).toBe(authorization.searchParams.get('redirect_uri'));
      expect(body.get('resource')).toBe('https://api.openai.com/v1');
      expect(createHash('sha256').update(body.get('code_verifier')!).digest('base64url')).toBe(authorization.searchParams.get('code_challenge'));
      return bundle;
    });
    const oauth=new ChatGptOAuth({transport,verifyIdentity:async(_token,client,nonce,subject)=>{
      expect(client).toBe('oaiapp_synthetic_new');expect(nonce).toBe(authorization.searchParams.get('nonce'));expect(subject).toBeNull();return {subject:'synthetic-subject',email:'synthetic@example.test'};
    },openExternal:async url=>{
      authorization=new URL(url);
      expect(authorization.origin).toBe('https://auth.openai.com');
      expect(authorization.searchParams.get('client_id')).toBe('dynamic_agent_client');
      expect(authorization.searchParams.get('agent_name_hint')).toBe('MultAI');
      expect(authorization.searchParams.get('ext_agent_host_id')).toBe('urn:uuid:synthetic-host');
      const callback=new URL(authorization.searchParams.get('redirect_uri')!);
      expect(callback.hostname).toBe('127.0.0.1'); expect(callback.pathname).toBe('/auth/callback');
      callback.search=new URLSearchParams({code:'synthetic-code',state:'incorrect',client_id:'oaiapp_synthetic_new'}).toString();
      expect((await fetch(callback)).status).toBe(400);
      callback.searchParams.set('state',authorization.searchParams.get('state')!);
      expect((await fetch(callback)).status).toBe(200);
    }});
    const result=await oauth.signIn({hostId:'urn:uuid:synthetic-host',onRegistered:async client=>{expect(client).toBe('oaiapp_synthetic_new');retained=true;}},new AbortController().signal);
    expect(result.clientId).toBe('oaiapp_synthetic_new');expect(result.subject).toBe('synthetic-subject');expect(result.scopes).toContain('chatgpt.tokens.use.direct');
  });
  it('rejects a changed returning client ID before token exchange',async()=>{
    const transport=vi.fn(async()=>discovery);
    const registered=vi.fn();
    const oauth=new ChatGptOAuth({transport,openExternal:async url=>{
      const authorize=new URL(url);
      expect(authorize.searchParams.get('client_id')).toBe(previous.clientId);
      expect(authorize.searchParams.has('agent_name_hint')).toBe(false);
      const callback=new URL(authorize.searchParams.get('redirect_uri')!);
      callback.search=new URLSearchParams({state:authorize.searchParams.get('state')!,code:'synthetic-code',client_id:'oaiapp_wrong'}).toString();
      expect((await fetch(callback)).status).toBe(400);
    }});
    await expect(oauth.signIn({hostId:previous.hostId,previous,onRegistered:registered},new AbortController().signal)).rejects.toHaveProperty('code','invalid_chatgpt_callback');
    expect(transport).toHaveBeenCalledOnce();expect(registered).not.toHaveBeenCalled();
  });
  it('handles denied and canceled authorization without exchanging or activating credentials',async()=>{
    const transport=vi.fn(async()=>discovery);
    const oauth=new ChatGptOAuth({transport,openExternal:async url=>{
      const authorize=new URL(url),callback=new URL(authorize.searchParams.get('redirect_uri')!);
      callback.search=new URLSearchParams({state:authorize.searchParams.get('state')!,error:'access_denied'}).toString();
      expect((await fetch(callback)).status).toBe(200);
    }});
    await expect(oauth.signIn({hostId:previous.hostId,onRegistered:async()=>{}},new AbortController().signal)).rejects.toHaveProperty('code','chatgpt_access_denied');
    expect(transport).toHaveBeenCalledOnce();
    const controller=new AbortController();
    const canceled=new ChatGptOAuth({transport,openExternal:async()=>{controller.abort();}});
    await expect(canceled.signIn({hostId:previous.hostId,onRegistered:async()=>{}},controller.signal)).rejects.toHaveProperty('code','chatgpt_canceled');
  });
  it('verifies real synthetic signatures and rejects nonce, issuer, audience, expiry and returning-subject changes',async()=>{
    const pair=await generateKeyPair('RS256'),jwk=await exportJWK(pair.publicKey);jwk.kid='synthetic-key';
    const keys=createLocalJWKSet({keys:[jwk]});
    const sign=async(overrides:{nonce?:string;subject?:string;issuer?:string;audience?:string;expiry?:number}={})=>new SignJWT({nonce:overrides.nonce??'synthetic-nonce',email:'synthetic@example.test'}).setProtectedHeader({alg:'RS256',kid:'synthetic-key'}).setSubject(overrides.subject??'synthetic-subject').setIssuer(overrides.issuer??'https://auth.openai.com').setAudience(overrides.audience??'oaiapp_synthetic').setIssuedAt().setExpirationTime(overrides.expiry??Math.floor(Date.now()/1000)+300).sign(pair.privateKey);
    const token=await sign();
    expect((await verifyChatGptIdentity(token,'oaiapp_synthetic','synthetic-nonce',null,keys)).subject).toBe('synthetic-subject');
    for(const overrides of [{nonce:'wrong'},{issuer:'https://wrong.example'},{audience:'oaiapp_wrong'},{expiry:Math.floor(Date.now()/1000)-100}])await expect(verifyChatGptIdentity(await sign(overrides),'oaiapp_synthetic','synthetic-nonce',null,keys)).rejects.toHaveProperty('code','invalid_chatgpt_identity');
    await expect(verifyChatGptIdentity(token,'oaiapp_synthetic','synthetic-nonce','another-subject',keys)).rejects.toHaveProperty('code','invalid_chatgpt_identity');
    const other=await generateKeyPair('RS256');
    const invalid=await new SignJWT({nonce:'synthetic-nonce'}).setProtectedHeader({alg:'RS256',kid:'synthetic-key'}).setSubject('synthetic-subject').setIssuer('https://auth.openai.com').setAudience('oaiapp_synthetic').setIssuedAt().setExpirationTime('5m').sign(other.privateKey);
    await expect(verifyChatGptIdentity(invalid,'oaiapp_synthetic','synthetic-nonce',null,keys)).rejects.toHaveProperty('code','invalid_chatgpt_identity');
  });
  it('requires granted plan scope and filters the actual ChatGPT model catalog',async()=>{
    const id=randomUUID();
    let record:ConnectionRecord={hostId:previous.hostId,connections:[{id,name:'ChatGPT',provider:'chatgpt',baseUrl:'https://api.openai.com/v1',registration:{...previous,scopes:['openid']}}]};
    const account:ConnectionAccount={origin:'https://collaboration.example',accountGeneration:1,identitySnapshot:async()=>({userId:'synthetic-google-user',deviceId:'synthetic-device',generation:1})};
    const transport=vi.fn(async()=>({models:[{slug:'visible-model',display_name:'Visible model',visibility:'list'},{slug:'hidden-model',display_name:'Hidden model',visibility:'hidden'}]}));
    const manager=new ConnectionManager({account,transport,storeFactory:()=>({load:async()=>structuredClone(record),save:async value=>{record=structuredClone(value);}})});
    expect((await manager.list())[0]?.status).toBe('plan-permission-required');
    await expect(manager.resolve(id)).rejects.toHaveProperty('code','chatgpt_plan_permission_required');
    expect(transport).not.toHaveBeenCalled();
    record.connections[0]!.registration={...previous};
    expect(await manager.models(id)).toEqual([{id:'visible-model',name:'Visible model'}]);
    expect(transport).toHaveBeenCalledWith('https://api.openai.com/v1/models',expect.objectContaining({headers:{authorization:'Bearer synthetic-access'}}));
    expect(JSON.stringify(await manager.list())).not.toContain('synthetic-access');
  });
  it('serializes rotating ChatGPT refresh and retains the issued client/resource without widening scope',async()=>{
    const id=randomUUID();
    let record:ConnectionRecord={hostId:previous.hostId,connections:[{id,name:'ChatGPT',provider:'chatgpt',baseUrl:'https://api.openai.com/v1',registration:{...previous,expiresAt:Date.now()-1}}]};
    const account:ConnectionAccount={origin:'https://collaboration.example',accountGeneration:1,identitySnapshot:async()=>({userId:'synthetic-google-user',deviceId:'synthetic-device',generation:1})};
    const transport=vi.fn(async(url:string,options?:{body?:string})=>{
      expect(url).toBe(discovery.token_endpoint);
      const body=new URLSearchParams(options?.body);
      expect(body.get('client_id')).toBe(previous.clientId);expect(body.get('resource')).toBe('https://api.openai.com/v1');expect(body.has('scope')).toBe(false);
      return {...bundle,access_token:'synthetic-replacement-access',refresh_token:'synthetic-replacement-refresh',scope:undefined};
    });
    const oauth=new ChatGptOAuth({transport,openExternal:async()=>{},verifyIdentity:async()=>({subject:'synthetic-subject'})});
    const manager=new ConnectionManager({account,oauth,storeFactory:()=>({load:async()=>structuredClone(record),save:async value=>{record=structuredClone(value);}})});
    const [first,second]=await Promise.all([manager.resolve(id),manager.resolve(id)]);
    expect(first.apiKey).toBe('synthetic-replacement-access');expect(second.apiKey).toBe(first.apiKey);
    expect(transport).toHaveBeenCalledOnce();
    expect(record.connections[0]?.registration?.refreshToken).toBe('synthetic-replacement-refresh');
  });
  it('does not retry an uncertain rotating refresh or retain its old renewable token',async()=>{
    const id=randomUUID();
    let record:ConnectionRecord={hostId:previous.hostId,connections:[{id,name:'ChatGPT',provider:'chatgpt',baseUrl:'https://api.openai.com/v1',registration:{...previous,expiresAt:Date.now()-1}}]};
    const account:ConnectionAccount={origin:'https://collaboration.example',accountGeneration:1,identitySnapshot:async()=>({userId:'synthetic-google-user',deviceId:'synthetic-device',generation:1})};
    const transport=vi.fn(async()=>{throw new Error('Synthetic lost response');});
    const oauth=new ChatGptOAuth({transport,openExternal:async()=>{}});
    const manager=new ConnectionManager({account,oauth,storeFactory:()=>({load:async()=>structuredClone(record),save:async value=>{record=structuredClone(value);}})});
    await expect(manager.resolve(id)).rejects.toHaveProperty('code','chatgpt_sign_in_required');
    await expect(manager.resolve(id)).rejects.toHaveProperty('code','chatgpt_sign_in_required');
    expect(transport).toHaveBeenCalledOnce();
    expect(record.connections[0]?.registration?.refreshToken).toBeUndefined();
    expect(record.connections[0]?.registration?.clientId).toBe(previous.clientId);
    expect((await manager.list())[0]?.status).toBe('sign-in-required');
  });
  it('persists the welcome acknowledgement by verified subject across client renewal and manager restart',async()=>{
    const first=randomUUID(),second=randomUUID();
    let record:ConnectionRecord={hostId:previous.hostId,connections:[{id:first,name:'ChatGPT one',provider:'chatgpt',baseUrl:'https://api.openai.com/v1',registration:{...previous}},{id:second,name:'ChatGPT other registration',provider:'chatgpt',baseUrl:'https://api.openai.com/v1',registration:{...previous,clientId:'oaiapp_another'}}]};
    const account:ConnectionAccount={origin:'https://collaboration.example',accountGeneration:1,identitySnapshot:async()=>({userId:'synthetic-google-user',deviceId:'synthetic-device',generation:1})};
    const options={account,storeFactory:()=>({load:async()=>structuredClone(record),save:async(value:ConnectionRecord)=>{record=structuredClone(value);}})};
    const manager=new ConnectionManager(options);
    expect((await manager.list()).every(connection=>connection.needsPlanWelcome)).toBe(true);
    await manager.acknowledgeChatGPTPlan(first);
    expect((await new ConnectionManager(options).list()).every(connection=>!connection.needsPlanWelcome)).toBe(true);
    record.connections[1]!.registration={...previous,subject:'another-verified-subject'};
    expect((await manager.list()).find(connection=>connection.id===second)?.needsPlanWelcome).toBe(true);
    expect(JSON.stringify(await manager.list())).not.toContain('synthetic-subject');
    record.connections[1]!.registration={...previous,subject:null};
    await expect(manager.acknowledgeChatGPTPlan(second)).rejects.toHaveProperty('code','chatgpt_plan_permission_required');
  });
  it('opens only the fixed official usage settings target with no account or token in the URL',async()=>{
    const openExternal=vi.fn(async()=>{});
    const account:ConnectionAccount={origin:'https://collaboration.example',accountGeneration:1,identitySnapshot:vi.fn(async()=>{throw new Error('No identity needed for a fixed public settings link');})};
    const manager=new ConnectionManager({account,openExternal});
    await expect(manager.manageChatGPTUsage()).resolves.toBeNull();
    expect(openExternal).toHaveBeenCalledExactlyOnceWith('https://chatgpt.com/settings/usage');
    expect(account.identitySnapshot).not.toHaveBeenCalled();
  });
  it('asks for consent only when explicitly enabling plan use on a returning registration',async()=>{
    const transport:JsonTransport=vi.fn(async url=>url.endsWith('openid-configuration')?discovery:bundle);
    const authorize=vi.fn(async(url:string)=>{
      const parsed=new URL(url);
      expect(parsed.searchParams.get('prompt')).toBe('consent');
      expect(parsed.searchParams.has('force_reconsent')).toBe(false);
      const callback=new URL(parsed.searchParams.get('redirect_uri')!);
      callback.search=new URLSearchParams({state:parsed.searchParams.get('state')!,code:'synthetic-code'}).toString();
      await fetch(callback);
    });
    const oauth=new ChatGptOAuth({transport,openExternal:authorize,verifyIdentity:async()=>({subject:'synthetic-subject'})});
    await oauth.signIn({hostId:previous.hostId,previous,requestPlanConsent:true,onRegistered:async()=>{}},new AbortController().signal);
    expect(authorize).toHaveBeenCalledOnce();
  });
});
