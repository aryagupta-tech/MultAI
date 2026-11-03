import {spawn} from 'node:child_process';
import type {ChildProcess} from 'node:child_process';
import {EventEmitter} from 'node:events';
import {PassThrough} from 'node:stream';
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import {TerminalHost,type TerminalEvent} from './terminal';

vi.mock('node:child_process',()=>({spawn:vi.fn(),spawnSync:vi.fn()}));

let child:ChildProcess;
let stdout:PassThrough;
let stderr:PassThrough;
beforeEach(()=>{
  vi.clearAllMocks();stdout=new PassThrough();stderr=new PassThrough();
  child=Object.assign(new EventEmitter(),{stdout,stderr}) as unknown as ChildProcess;
  vi.mocked(spawn).mockReturnValue(child);
});
afterEach(()=>vi.unstubAllEnvs());

it.skipIf(process.platform==='win32')('uses the portable shell when SHELL is missing or relative',()=>{
  const terminal=new TerminalHost(()=>undefined);
  for(const [index,shell] of [undefined,'relative-shell'].entries()){
    vi.stubEnv('SHELL',shell);terminal.run(`session-${index}`,'/workspace','echo hello');
    expect(spawn).toHaveBeenLastCalledWith('/bin/sh',['-lc','echo hello'],expect.objectContaining({cwd:'/workspace'}));
    child.emit('close',0);
  }
});

it.skipIf(process.platform!=='win32')('passes a leading quoted executable to cmd without Node rewriting its arguments',()=>{
  const terminal=new TerminalHost(()=>undefined);
  const command='"C:\\Program Files\\nodejs\\node.exe" -e "console.log(1)"';
  terminal.run('quoted','C:\\workspace',command);
  expect(spawn).toHaveBeenCalledWith(expect.any(String),['/d','/s','/c','"',command,'"'],expect.objectContaining({windowsVerbatimArguments:true}));
  child.emit('close',0);
});

it('preserves UTF-8 characters split across stdout and stderr chunks',()=>{
  const events:TerminalEvent[]=[];const terminal=new TerminalHost(event=>events.push(event));
  const {id}=terminal.run('session','/workspace','echo hello');
  const output=Buffer.from('क🙂');
  for(const byte of output)stdout.write(Buffer.from([byte]));
  const error=Buffer.from('é');stderr.write(error.subarray(0,1));stderr.end(error.subarray(1));
  stdout.end();child.emit('close',0);
  expect(events.filter(event=>event.kind==='output').map(event=>event.text).join('')).toBe('क🙂é');
  expect(events.at(-1)).toEqual({sessionId:'session',id,kind:'exit',code:0,stopped:false});
});

it('failed process startup releases the session and emits one exit',()=>{
  const events:TerminalEvent[]=[];const terminal=new TerminalHost(event=>events.push(event));
  terminal.run('session','/workspace','echo hello');
  child.emit('error',new Error('spawn ENOENT'));child.emit('close',null);
  expect(events.filter(event=>event.kind==='exit')).toEqual([expect.objectContaining({code:127})]);
  expect(()=>terminal.run('session','/workspace','retry')).not.toThrow();
});

it('stopping a session or signing out cancels commands still being prepared',()=>{
  const terminal=new TerminalHost(()=>undefined);
  const stopped=terminal.generation('session');terminal.stop('session');
  expect(()=>terminal.run('session','/workspace','old command',stopped)).toThrow(/canceled/);
  const signedOut=terminal.generation('other-session');terminal.stopAll();
  expect(()=>terminal.run('other-session','/workspace','old account command',signedOut)).toThrow(/canceled/);
  expect(spawn).not.toHaveBeenCalled();
  expect(()=>terminal.run('other-session','/workspace','new command')).not.toThrow();
});
