import {beforeAll,beforeEach,expect,test,vi} from 'vitest';
const fake=vi.hoisted(()=>({post:vi.fn()}));
vi.mock('../bridge/client',()=>({getBridge:()=>({service:{postMessage:fake.post}})}));
let useApp:typeof import('../model/store')['useApp'],send:typeof import('./controller')['send'];
const user={id:'qa',name:'QA',email:'',initials:'QA',hue:0,workspace:'Personal'};
beforeAll(async()=>{vi.stubGlobal('localStorage',{getItem:()=>null,setItem:()=>{},removeItem:()=>{}});useApp=(await import('../model/store')).useApp;send=(await import('./controller')).send;});
beforeEach(()=>{fake.post.mockReset();useApp.setState({account:user,dataMode:'live',drafts:{session:{text:'original',kind:'discussion',files:[{name:'note.md',text:'content'}]}},sending:{}});});
function pending(){let resolve!:(value:any)=>void;return {promise:new Promise<any>(yes=>{resolve=yes;}),resolve};}
const ok={ok:true,value:{event:{id:'event',sequence:1,type:'message.discussion',payload:{text:'sent'}}}};
test('delayed sends preserve edits and files made while in flight',async()=>{
 const gate=pending();fake.post.mockReturnValue(gate.promise);const request=send('session','discussion','original');
 useApp.getState().setDraft('session',{text:'new unsent text',files:[{name:'new.md',text:'new'}]});gate.resolve(ok);await request;
 expect(useApp.getState().drafts.session).toMatchObject({text:'new unsent text',files:[{name:'new.md'}]});
});
test('account switches fence old responses from replacement drafts and busy state',async()=>{
 const gate=pending();fake.post.mockReturnValue(gate.promise);const request=send('session','discussion','original');
 useApp.setState({account:{...user,id:'other'},drafts:{session:{text:'replacement',kind:'discussion'}},sending:{session:true}});gate.resolve(ok);await request;
 expect(useApp.getState().drafts.session?.text).toBe('replacement');expect(useApp.getState().sending.session).toBe(true);
});
test('duplicate sends are blocked and confirmed unchanged drafts clear files',async()=>{
 const gate=pending();fake.post.mockReturnValue(gate.promise);const request=send('session','discussion','original');await send('session','discussion','original');
 expect(fake.post).toHaveBeenCalledTimes(1);gate.resolve(ok);await request;
 expect(useApp.getState().drafts.session?.text).toBe('');expect(useApp.getState().drafts.session?.files).toBeUndefined();
});
test('failures preserve files and retry identity; changed kind gets a fresh identity',async()=>{
 fake.post.mockResolvedValue({ok:false,error:{code:'network_uncertain',message:'Try again'}});
 await send('session','discussion','original');await send('session','discussion','original');
 expect(fake.post.mock.calls[0]![1].requestId).toBe(fake.post.mock.calls[1]![1].requestId);expect(useApp.getState().drafts.session?.files).toHaveLength(1);
 await send('session','instruction','original');expect(fake.post.mock.calls[2]![1].requestId).not.toBe(fake.post.mock.calls[1]![1].requestId);
});
