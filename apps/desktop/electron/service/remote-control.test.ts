import {randomUUID} from 'node:crypto';
import {afterEach,beforeEach,describe, expect, it, vi} from 'vitest';
import type {AuthState} from '../../src/bridge/contract';
import type {ActionDescriptor} from '@multai/runtime';
import {buildEnvelope, exportPublic, generatePhoneKeys, keyThumbprint, openPreview, signControl, verificationCode, type ControlKind, type ControlTargets} from '@multai/companion-core';
import {ApprovalBroker} from '../inference/approvals';
import {RemoteControlHost, routeController, type TrustedPhone,type TrustStore} from './remote-control';

const sessionId = randomUUID(), otherSession = randomUUID(), owner = randomUUID();
const fingerprint = 'f'.repeat(64);
const queueFingerprint = 'q'.replace('q', 'a').repeat(64);

function descriptor(command: string): ActionDescriptor {
  return {version: 1, requestId: randomUUID(), sessionId, originalOwnerId: owner, originalDeviceId: owner, accountGeneration: 1, sessionGeneration: 4, runtimeGeneration: 4, connectionId: owner, payerId: owner, resourceIdentity: `workspace:${sessionId}`, cwd: '/synthetic', expiresAt: Date.now() + 60_000, operation: {kind: 'shell', executable: '/bin/sh', argv: ['-c', command], commandText: command}};
}

async function setup(options: {status?: 'inactive' | 'running'; generation?: number; requiresReview?: boolean; pending?: string[]} = {}) {
  const phoneKeys = await generatePhoneKeys();
  const signingKey = await exportPublic(phoneKeys.signing.publicKey), encryptionKey = await exportPublic(phoneKeys.encryption.publicKey);
  const pairingId = randomUUID();
  const trusted: TrustedPhone = {pairingId, deviceName: 'Synthetic Pixel', platform: 'android', signingKey, encryptionKey, thumbprint: await keyThumbprint(signingKey, encryptionKey), sessionIds: [sessionId], expiresAt: Date.now() + 86_400_000, confirmedAt: Date.now()};
  let saved: TrustedPhone[] = [trusted];
  const state = {status: options.status ?? 'running', generation: options.generation ?? 4};
  const accountGeneration={value:1};
  const instructionId = randomUUID();
  const calls: {method: string; path: string; body?: unknown}[] = [];
  const request = vi.fn(async (method: string, path: string, body?: unknown) => {
    calls.push({method, path, body});
    if (path === `/v1/sessions/${sessionId}`) return {session: {runtimeGeneration: state.generation, status: state.status, capabilities: {execute: true}}};
    if (path.startsWith('/v1/host/control-requests?')) return new Promise(() => undefined);
    return {};
  });
  const approvals = new ApprovalBroker(() => undefined);
  const coordinator = {
    run: vi.fn(async () => ({runId: randomUUID()})),
    stop: vi.fn(async () => null),
    conflictContext: vi.fn(async () => ({fingerprint: queueFingerprint, requiresReview: options.requiresReview ?? false, pending: (options.pending ?? [instructionId]).map(id => ({id, authorId: owner, authorName: 'Host', text: 'Fix it', revision: 1}))})),
    selection: vi.fn(async () => ({connectionId: randomUUID(), model: 'synthetic-model'})),
    lockedActions: vi.fn(async () => []),
  };
  const store:TrustStore={load:async()=>saved,save:async value=>{saved=value;}};
  const host = new RemoteControlHost({request, accountGeneration: () => accountGeneration.value, identity: async () => ({userId: owner, deviceId: owner}),
    trust: () => store, coordinator: coordinator as never, approvals});
  await host.start();
  const sign = async <K extends ControlKind>(kind: K, target: ControlTargets[K], extra: {now?: number; sessionId?: string; generation?: number; pairingId?: string} = {}) => {
    const envelope = buildEnvelope({pairingId: extra.pairingId ?? pairingId, sessionId: extra.sessionId ?? sessionId, runGeneration: extra.generation ?? 4, kind, target, now: extra.now ?? Date.now()});
    const signed = await signControl(envelope, phoneKeys.signing.privateKey);
    return {id: envelope.requestId, pairingId: extra.pairingId ?? pairingId, sessionId: envelope.sessionId, envelope, signature: signed.signature};
  };
  return {host, approvals, coordinator, request, calls, state, accountGeneration, sign, pairingId, instructionId, phoneKeys, store, saved: () => saved};
}

describe('the original host independently validates phone requests', () => {
  it('approves only the exact waiting action, once, even when the desktop decides at the same time', async () => {
    const t = await setup();
    const first = t.approvals.request(descriptor('npm test'), new AbortController().signal, undefined, fingerprint);
    const id = t.approvals.list()[0]!.id;
    expect(await t.host.decide(await t.sign('approve', {actionId: id, actionFingerprint: 'e'.repeat(64)}))).toMatchObject({outcome: 'rejected', code: 'action_changed'});
    expect(await t.host.decide(await t.sign('approve', {actionId: id, actionFingerprint: fingerprint}))).toMatchObject({outcome: 'accepted', code: 'approved'});
    await expect(first).resolves.toBe(true);
    // The desktop (or another phone) got there first: the late decision is refused, not applied.
    const second = t.approvals.request(descriptor('npm run build'), new AbortController().signal, undefined, fingerprint);
    const secondId = t.approvals.list()[0]!.id;
    t.approvals.decide(secondId, false);
    await expect(second).resolves.toBe(false);
    expect(await t.host.decide(await t.sign('approve', {actionId: secondId, actionFingerprint: fingerprint}))).toMatchObject({outcome: 'rejected', code: 'approval_unavailable'});
  });

  it('Stop invalidates waiting approvals, so a late phone approval does nothing', async () => {
    const t = await setup();
    const controller = new AbortController();
    const waiting = t.approvals.request(descriptor('npm test'), controller.signal, undefined, fingerprint);
    const id = t.approvals.list()[0]!.id;
    expect(await t.host.decide(await t.sign('stop', {}))).toMatchObject({outcome: 'accepted', code: 'stopped'});
    expect(t.coordinator.stop).toHaveBeenCalledWith(sessionId);
    controller.abort();
    await expect(waiting).resolves.toBe(false);
    expect(await t.host.decide(await t.sign('approve', {actionId: id, actionFingerprint: fingerprint}))).toMatchObject({outcome: 'rejected', code: 'approval_unavailable'});
  });

  it('refuses forged, foreign, out-of-scope, expired, stale and pre-reconnect requests', async () => {
    const t = await setup();
    const good = await t.sign('stop', {});
    expect(await t.host.decide({...good, signature: good.signature.slice(0, -2) + (good.signature.endsWith('AA') ? 'BB' : 'AA')})).toMatchObject({code: 'bad_signature'});
    expect(await t.host.decide({...good, envelope: {...good.envelope, runGeneration: 5}})).toMatchObject({code: 'bad_signature'});
    expect(await t.host.decide({...good, pairingId: randomUUID()})).toMatchObject({code: 'unknown_phone'});
    expect(await t.host.decide({...good, id: randomUUID()})).toMatchObject({code: 'request_mismatch'});
    expect(await t.host.decide(await t.sign('stop', {}, {sessionId: otherSession}))).toMatchObject({code: 'session_scope'});
    expect(await t.host.decide(await t.sign('stop', {}, {now: Date.now() - 125_000}))).toMatchObject({code: 'expired'});
    // Signed before this host (re)started listening: never executed after a reconnect.
    expect(await t.host.decide(await t.sign('stop', {}, {now: Date.now() - 60_000}))).toMatchObject({code: 'issued_before_reconnect'});
    t.state.generation = 5;
    expect(await t.host.decide(good)).toMatchObject({code: 'stale_generation'});
    expect(t.coordinator.stop).not.toHaveBeenCalled();
  });

  it('starts only the selected pending instruction from the exact reviewed queue', async () => {
    const t = await setup({status: 'inactive'});
    expect(await t.host.decide(await t.sign('start', {instructionId: t.instructionId, queueFingerprint: 'b'.repeat(64)}))).toMatchObject({code: 'queue_changed'});
    expect(await t.host.decide(await t.sign('start', {instructionId: randomUUID(), queueFingerprint}))).toMatchObject({code: 'instruction_unavailable'});
    expect(await t.host.decide(await t.sign('start', {instructionId: t.instructionId, queueFingerprint}))).toMatchObject({outcome: 'accepted', code: 'started'});
    expect(t.coordinator.run).toHaveBeenCalledWith(expect.objectContaining({sessionId, instructionId: t.instructionId, model: 'synthetic-model'}));
    expect(t.coordinator.run.mock.calls[0]).not.toContainEqual(expect.objectContaining({resolution: expect.anything()}));
  });

  it('conflicting directions need a resolution, which is bound to the reviewed queue', async () => {
    const t = await setup({status: 'inactive', requiresReview: true});
    expect(await t.host.decide(await t.sign('start', {instructionId: t.instructionId, queueFingerprint}))).toMatchObject({code: 'instruction_conflict'});
    expect(await t.host.decide(await t.sign('resolve', {instructionId: t.instructionId, queueFingerprint, resolution: 'Use integer cents.'}))).toMatchObject({outcome: 'accepted'});
    expect(t.coordinator.run).toHaveBeenCalledWith(expect.objectContaining({resolution: 'Use integer cents.', resolutionFingerprint: queueFingerprint}));
  });

  it('a phone removed on this desktop is refused immediately, even before the service hears about it', async () => {
    const t = await setup();
    const request=t.request.getMockImplementation()!;
    t.request.mockImplementation(async(method,path,body)=>{if(method==='DELETE')throw new Error('offline');return request(method,path,body);});
    await expect(t.host.revokePairing(t.pairingId)).rejects.toThrow();
    expect(t.saved()).toEqual([]);
    expect(await t.host.decide(await t.sign('stop', {}))).toMatchObject({code: 'unknown_phone'});
  });

  it('file previews in host reports open only on the paired phone', async () => {
    const t = await setup();
    const write = {...descriptor('x'), operation: {kind: 'file_write' as const, relativePath: 'src/total.ts', expectedContentHash: null, contentHash: 'a'.repeat(64)}};
    void t.approvals.request(write, new AbortController().signal, 'export const total = cents;\n', fingerprint);
    const state = await t.host.state(sessionId, 'online');
    expect(state.run.status).toBe('blocked');
    expect(state.approval).toMatchObject({kind: 'file_write', path: 'src/total.ts', newFile: true, fingerprint});
    expect(JSON.stringify(state)).not.toContain('cents');
    const sealed = state.approval!.preview![0]!;
    await expect(openPreview(sealed, t.phoneKeys.encryption.privateKey, {actionId: write.requestId, fingerprint})).resolves.toBe('export const total = cents;\n');
  });

  it('a recovered listener reports the live run even if it missed the original run-change event',async()=>{
    const t=await setup();
    expect((await t.host.state(sessionId,'online')).run.status).toBe('running');
    t.state.status='inactive';expect((await t.host.state(sessionId,'online')).run.status).toBe('idle');
  });

  it('pairing review computes the six digits from the phone keys on this computer', async () => {
    const t = await setup();
    const keys = await generatePhoneKeys();
    const signingKey = await exportPublic(keys.signing.publicKey), encryptionKey = await exportPublic(keys.encryption.publicKey);
    const id = randomUUID();
    t.request.mockImplementation(async (_method: string, path: string) => path === `/v1/controller-pairings/${id}` ? {pairing: {id, status: 'awaiting_confirmation', sessionIds: [sessionId], grantSeconds: 3600, deviceName: 'Phone', platform: 'ios', keyThumbprint: 'x', signingKey, encryptionKey, codeExpiresAt: new Date().toISOString(), createdAt: new Date().toISOString(), confirmedAt: null, expiresAt: null, revokedAt: null, revokedBy: null, lastSeenAt: null, verificationCode: '000 000'}} : {});
    const review = await t.host.reviewPairing(id);
    expect(review.verificationCode).toBe(await verificationCode(id, await keyThumbprint(signingKey, encryptionKey)));
    expect(review.verificationCode).not.toBe('000 000');
  });

  it('validates renderer arguments before acting', async () => {
    const t = await setup();
    expect(await routeController(t.host, 'createPairing', [['not-a-uuid'], 3600])).toMatchObject({ok: false, error: {code: 'invalid_request'}});
    expect(await routeController(t.host, 'createPairing', [[sessionId], 60])).toMatchObject({ok: false});
    expect(await routeController(t.host, 'runShell', [])).toMatchObject({ok: false});
  });

  it('a reconnect refuses signed requests from before recovery instead of replaying them',async()=>{
    vi.useFakeTimers({toFake:['Date']});
    try{
      const t=await setup(),before=Date.now(),request=await t.sign('stop',{}, {now:before});
      vi.setSystemTime(before+10_000);await t.host.suspend();await t.host.resume();
      expect(await t.host.decide(request)).toMatchObject({code:'issued_before_reconnect'});
      expect(t.coordinator.stop).not.toHaveBeenCalled();await t.host.suspend();
    }finally{vi.useRealTimers();}
  });

  it('sign-out during request validation cannot execute a phone action in another account',async()=>{
    const t=await setup();await settle();const response=deferred<unknown>(),delivered=deferred<void>();
    const request=t.request.getMockImplementation()!;
    t.request.mockImplementation(async(method,path,body)=>{
      if(method==='GET'&&path===`/v1/sessions/${sessionId}`){delivered.resolve();return response.promise;}
      return request(method,path,body);
    });
    const decision=t.host.decide(await t.sign('stop',{}));await delivered.promise;
    t.accountGeneration.value++;void t.host.stop();
    response.resolve({session:{runtimeGeneration:4,status:'running',capabilities:{execute:true}}});
    expect(await decision).toMatchObject({code:'host_unavailable'});expect(t.coordinator.stop).not.toHaveBeenCalled();
  });

  it('a delayed confirmation save cannot restore a phone revoked while it was pending',async()=>{
    const t=await setup(),pairing=pairingFixture(t.saved()[0]!,randomUUID(),[otherSession]);
    const request=t.request.getMockImplementation()!;
    t.request.mockImplementation(async(method,path,body)=>{
      if(path===`/v1/controller-pairings/${pairing.id}`)return {pairing};
      if(path.endsWith(`/${pairing.id}/confirm`))return {pairing:{...pairing,status:'active'}};
      return request(method,path,body);
    });
    const write=deferred<void>(),writing=deferred<void>(),save=t.store.save.bind(t.store);
    vi.spyOn(t.store,'save').mockImplementationOnce(async value=>{writing.resolve();await write.promise;await save(value);});
    const confirmed=t.host.confirmPairing(pairing.id,[otherSession]);await writing.promise;
    const revoked=t.host.revokePairing(t.pairingId);await settle();
    expect(t.host.covers(sessionId)).toBe(false);
    write.resolve();await Promise.all([confirmed,revoked]);
    expect(t.host.covers(sessionId)).toBe(false);expect(t.host.covers(otherSession)).toBe(true);
    expect(t.saved().map(phone=>phone.pairingId)).toEqual([pairing.id]);
  });

  it('a late confirmation response cannot restore the same pairing revoked locally',async()=>{
    const t=await setup(),pairing=pairingFixture(t.saved()[0]!,randomUUID(),[otherSession]);
    const request=t.request.getMockImplementation()!,response=deferred<unknown>(),confirming=deferred<void>();
    t.request.mockImplementation(async(method,path,body)=>{
      if(path===`/v1/controller-pairings/${pairing.id}`&&method==='GET')return {pairing};
      if(path.endsWith(`/${pairing.id}/confirm`)){confirming.resolve();return response.promise;}
      return request(method,path,body);
    });
    const confirmation=t.host.confirmPairing(pairing.id,[otherSession]),rejected=expect(confirmation).rejects.toMatchObject({code:'pairing_revoked'});
    await confirming.promise;await t.host.revokePairing(pairing.id);
    response.resolve({pairing:{...pairing,status:'active'}});await rejected;
    expect(t.host.covers(otherSession)).toBe(false);expect(t.saved().map(phone=>phone.pairingId)).toEqual([t.pairingId]);
  });

  it.each(['absent','awaiting_device'] as const)('an older %s list snapshot cannot erase a newly confirmed phone',async state=>{
    const t=await setup(),pairing=pairingFixture(t.saved()[0]!,randomUUID(),[otherSession]);
    const request=t.request.getMockImplementation()!,response=deferred<unknown>(),listing=deferred<void>();
    t.request.mockImplementation(async(method,path,body)=>{
      if(path==='/v1/controller-pairings'&&method==='GET'){listing.resolve();return response.promise;}
      if(path===`/v1/controller-pairings/${pairing.id}`)return {pairing};
      if(path.endsWith(`/${pairing.id}/confirm`))return {pairing:{...pairing,status:'active'}};
      return request(method,path,body);
    });
    const listed=t.host.listPhones();await listing.promise;
    await t.host.confirmPairing(pairing.id,[otherSession]);
    const original=pairingFixture(t.saved().find(phone=>phone.pairingId===t.pairingId)!,t.pairingId,[sessionId]);
    response.resolve({pairings:[{...original,status:'active'},...(state==='absent'?[]:[{...pairing,status:'awaiting_device'}])]});await listed;
    expect(t.host.covers(otherSession)).toBe(true);expect(t.saved().map(phone=>phone.pairingId)).toContain(pairing.id);
  });
});

function pairingFixture(phone:TrustedPhone,id:string,sessionIds:string[]){
  return {id,status:'awaiting_confirmation',sessionIds,grantSeconds:3600,deviceName:'New phone',platform:'android',keyThumbprint:phone.thumbprint,
    signingKey:phone.signingKey,encryptionKey:phone.encryptionKey,codeExpiresAt:new Date(Date.now()+60_000).toISOString(),createdAt:new Date().toISOString(),
    confirmedAt:new Date().toISOString(),expiresAt:new Date(Date.now()+3600_000).toISOString(),revokedAt:null,revokedBy:null,lastSeenAt:null};
}

function deferred<T>(){
  let resolve!:(value:T)=>void;
  return {promise:new Promise<T>(done=>{resolve=done;}),resolve};
}
async function settle(){for(let index=0;index<12;index++)await Promise.resolve();}

describe('phone controller account lifecycle',()=>{
  const hosts:RemoteControlHost[]=[];
  beforeEach(()=>vi.useFakeTimers());
  afterEach(()=>{for(const host of hosts.splice(0))void host.stop();vi.clearAllTimers();vi.useRealTimers();});
  function fixture(){
    const account={generation:1};
    const identity=vi.fn(async():Promise<{userId:string;deviceId:string}>=>({userId:owner,deviceId:owner}));
    const load=vi.fn(async():Promise<TrustedPhone[]>=>[]),save=vi.fn(async(_value:TrustedPhone[])=>undefined);
    const trust=vi.fn((_key:string):TrustStore=>({load,save}));
    const pairing={id:randomUUID(),status:'awaiting_device',sessionIds:[sessionId],grantSeconds:3600,deviceName:null,platform:null,keyThumbprint:null,signingKey:null,encryptionKey:null,codeExpiresAt:new Date(Date.now()+60_000).toISOString(),createdAt:new Date().toISOString(),confirmedAt:null,expiresAt:null,revokedAt:null,revokedBy:null,lastSeenAt:null,code:'123456',link:'https://example.test/pair'};
    const request=vi.fn(async(method:string,path:string):Promise<unknown>=>{
      if(method==='POST'&&path==='/v1/controller-pairings')return {pairing};
      if(method==='GET'&&path==='/v1/controller-pairings')return {pairings:[]};
      throw new Error('Unexpected endpoint');
    });
    const host=new RemoteControlHost({request,accountGeneration:()=>account.generation,identity,trust,coordinator:{} as never,approvals:new ApprovalBroker(()=>undefined)});
    hosts.push(host);return {host,account,identity,load,save,trust,request,pairing};
  }

  it.each(['identity','trust'] as const)('pairing retries a failed cold-start %s load without requiring sign-out',async failed=>{
    const t=fixture();
    if(failed==='identity')t.identity.mockRejectedValueOnce(new Error('Cold-start network unavailable'));
    else t.load.mockRejectedValueOnce(new Error('Cold-start keyring locked'));
    await expect(t.host.start()).rejects.toThrow('Cold-start');
    expect(await routeController(t.host,'createPairing',[[sessionId],3600])).toMatchObject({ok:true,value:{id:t.pairing.id}});
    expect(t.identity).toHaveBeenCalledTimes(2);expect(t.request).toHaveBeenCalledWith('POST','/v1/controller-pairings',{sessionIds:[sessionId],grantSeconds:3600});
    expect(await t.host.listPhones()).toEqual([]);
  });

  it('concurrent starts and controller calls share one identity/trust initialization',async()=>{
    const t=fixture(),read=deferred<TrustedPhone[]>();t.load.mockImplementationOnce(()=>read.promise);
    const first=t.host.start(),second=t.host.start(),phones=t.host.listPhones(),pairing=t.host.createPairing([sessionId],3600);
    expect(first).toBe(second);await settle();expect(t.identity).toHaveBeenCalledOnce();expect(t.load).toHaveBeenCalledOnce();expect(t.request).not.toHaveBeenCalled();
    read.resolve([]);await Promise.all([first,second,phones,pairing]);
    expect(t.identity).toHaveBeenCalledOnce();
  });

  it.each(['identity','trust'] as const)('a delayed %s initialization cannot cross sign-out or replace a new account',async phase=>{
    const t=fixture(),identity=deferred<{userId:string;deviceId:string}>(),read=deferred<TrustedPhone[]>();
    if(phase==='identity')t.identity.mockImplementationOnce(()=>identity.promise);
    else t.load.mockImplementationOnce(()=>read.promise);
    const first=t.host.start(),rejected=expect(first).rejects.toMatchObject({code:'stale_account'});
    await settle();t.account.generation++;await t.host.stop();
    const nextOwner=randomUUID();t.identity.mockResolvedValueOnce({userId:nextOwner,deviceId:nextOwner});
    await t.host.start();
    identity.resolve({userId:owner,deviceId:owner});read.resolve([]);await rejected;
    expect(await t.host.createPairing([sessionId],3600)).toMatchObject({id:t.pairing.id});
    expect(t.trust).toHaveBeenLastCalledWith(`${nextOwner}:${nextOwner}`);
  });

  it('resume initializes an account even when cold start never obtained its trust store',async()=>{
    const t=fixture();t.identity.mockRejectedValueOnce(new Error('offline'));
    await expect(t.host.start()).rejects.toThrow('offline');
    await t.host.resume();expect(t.load).toHaveBeenCalledOnce();
    expect(await t.host.createPairing([sessionId],3600)).toMatchObject({id:t.pairing.id});
  });

  it('a recovered auth read retries in the background without changing the real signed-in result',async()=>{
    const t=fixture();t.identity.mockRejectedValueOnce(new Error('keyring busy'));
    const state:AuthState={status:'signed-in',me:{id:owner,displayName:'Host',deviceId:owner,workspaceId:owner},persisted:true};
    expect(t.host.recover(state,t.account.generation)).toBeUndefined();await settle();
    expect(state).toMatchObject({status:'signed-in',persisted:true});
    t.host.recover(state,t.account.generation);await settle();expect(t.load).toHaveBeenCalledOnce();
    const calls=t.identity.mock.calls.length;
    t.host.recover(state,t.account.generation-1);t.host.recover({status:'signed-out'},t.account.generation);await settle();
    expect(t.identity).toHaveBeenCalledTimes(calls);
  });

  it('a pairing response for an account that signed out is never returned as a fresh offer',async()=>{
    const t=fixture(),response=deferred<unknown>();t.request.mockImplementationOnce(()=>response.promise);
    const offer=t.host.createPairing([sessionId],3600),rejected=expect(offer).rejects.toMatchObject({code:'stale_account'});
    await settle();t.account.generation++;const stopping=t.host.stop();response.resolve({pairing:t.pairing});await rejected;
    await vi.advanceTimersByTimeAsync(3000);await stopping;
  });
});
