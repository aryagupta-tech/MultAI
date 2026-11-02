import {describe,expect,it,vi} from 'vitest';
import {routeReview} from './review';
import {route,isServiceOp} from './router';
import type {Account} from './account';
import type {LiveHub} from './live';
const session='11111111-1111-4111-8111-111111111111',criterion='22222222-2222-4222-8222-222222222222',requestId='33333333-3333-4333-8333-333333333333',evidence='44444444-4444-4444-8444-444444444444';
function fixture(){return {origin:'https://api.example.test',request:vi.fn(async(..._args:unknown[]):Promise<unknown>=>({ok:true}))};}

describe('review IPC route boundary',()=>{
  it('rejects path escapes, arbitrary destinations, execution/evidence writes and extra authority before issuing a request',async()=>{
    const account=fixture();
    for(const [id,input] of [
      ['../other',{kind:'acceptance'}],
      [session,{kind:'acceptance',url:'https://attacker.example'}],
      [session,{kind:'propose',requestId,text:'Check it',authorId:criterion}],
      [session,{kind:'approve',requestId,criterionId:'../../runs',expectedVersion:1}],
      [session,{kind:'evidence',exitCode:0}],
      [session,{kind:'revision',revision:'a'.repeat(64)}],
      [session,{kind:'run'}],[session,{kind:'constructor'}],
      [session,{kind:'admit',reviewerId:criterion,decision:'owner'}],
      [session,{kind:'screenshot',label:'unsafe',image:'data:image/svg+xml;base64,PHN2Zz4='}],
      [session,{kind:'screenshot',label:'remote',image:'https://attacker.example/image.png'}],
    ] as const)await expect(routeReview(account,id,input)).rejects.toThrow();
    expect(account.request).not.toHaveBeenCalled();
  });
  it('preserves exact check bytes and review evidence identity while constructing only scoped paths',async()=>{
    const account=fixture(),checkCommand="node -e 'process.exit(0)'\n";
    await routeReview(account,session,{kind:'propose',requestId,text:'  No duplicate orders  ',checkCommand});
    expect(account.request).toHaveBeenLastCalledWith('POST',`/v1/sessions/${session}/acceptance/criteria`,{requestId,text:'No duplicate orders',checkCommand});
    await routeReview(account,session,{kind:'approve',requestId,criterionId:criterion,expectedVersion:2});
    expect(account.request).toHaveBeenLastCalledWith('POST',`/v1/sessions/${session}/acceptance/criteria/${criterion}/approve`,{requestId,expectedVersion:2});
    await routeReview(account,session,{kind:'decision',requestId,criterionId:criterion,criterionVersion:2,evidenceId:evidence,revision:'a'.repeat(64),decision:'reject',comment:'Needs keyboard support'});
    expect(account.request).toHaveBeenLastCalledWith('POST',`/v1/sessions/${session}/acceptance/reviews`,{requestId,criterionId:criterion,criterionVersion:2,evidenceId:evidence,revision:'a'.repeat(64),decision:'reject',comment:'Needs keyboard support'});
  });
  it('keeps invitation secrets in a fragment and rejects malformed service invitations',async()=>{
    const account=fixture(),token='A'.repeat(43),expiresAt='2030-01-01T00:00:00.000Z';
    account.request.mockResolvedValueOnce({invitation:{id:criterion,token,expiresAt}});
    const result=await routeReview(account,session,{kind:'invite',expiresInSeconds:86400}) as {link:string};
    const link=new URL(result.link);expect(link.origin).toBe(account.origin);expect(link.pathname).toBe('/review');expect(link.search).toBe('');expect(link.hash).toBe(`#${token}`);
    for(const value of [{invitation:{id:criterion,token:'../../evil?secret',expiresAt}},{invitation:{id:criterion,token,expiresAt:'not-a-date'}},{}]){
      account.request.mockResolvedValueOnce(value);
      await expect(routeReview(account,session,{kind:'invite',expiresInSeconds:86400})).rejects.toThrow();
    }
  });
  it('service wrapper refuses malformed IPC tuples and preserves failed authorization',async()=>{
    const account=fixture(),live={} as LiveHub;
    expect(isServiceOp('review')).toBe(true);expect(isServiceOp('__proto__')).toBe(false);
    for(const args of [[session,{kind:'acceptance'},'extra'],[session,{kind:'propose',requestId,text:''}],{sessionId:session,kind:'acceptance'}]){
      expect(await route(account as unknown as Account,live,'review',args)).toMatchObject({ok:false,error:{code:'invalid_request'}});
    }
    expect(account.request).not.toHaveBeenCalled();
    account.request.mockRejectedValueOnce(new Error('Synthetic network failure'));
    expect(await route(account as unknown as Account,live,'review',[session,{kind:'reviewers'}])).toMatchObject({ok:false});
  });
  it('caps identifiers, review versions, comments and image payloads before transport',async()=>{
    const account=fixture();
    for(const input of [
      {kind:'approve',requestId,criterionId:criterion,expectedVersion:0},
      {kind:'invite',expiresInSeconds:86401},
      {kind:'decision',requestId,criterionId:criterion,criterionVersion:1,evidenceId:evidence,revision:'invalid',decision:'accept'},
      {kind:'decision',requestId,criterionId:criterion,criterionVersion:1,evidenceId:evidence,revision:'a'.repeat(64),decision:'accept',comment:'x'.repeat(2001)},
      {kind:'screenshot',label:'Oversize',image:'data:image/png;base64,'+'A'.repeat(110000)},
    ])await expect(routeReview(account,session,input)).rejects.toThrow();
    expect(account.request).not.toHaveBeenCalled();
  });
});
