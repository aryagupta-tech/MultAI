// The host's own command line in a session's worktree. It runs as the host, with the host's login
// PATH, like a terminal tab would; the agent can't reach it and its output never leaves this computer
// unless the host shares an excerpt. No PTY yet, so full-screen programs such as vim don't work.
import {spawn,spawnSync,type ChildProcess} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import {ProjectError,hostPath} from './projects';

export type TerminalEvent={sessionId:string;id:string}&({kind:'output';text:string}|{kind:'exit';code:number|null;stopped:boolean});
const MAX_OUTPUT=200_000;
const windows=process.platform==='win32';

export class TerminalHost {
  private readonly running=new Map<string,{id:string;child:ChildProcess;stopped:boolean}>();
  private readonly stops=new Map<string,number>();
  private epoch=0;
  constructor(private readonly emit:(event:TerminalEvent)=>void){}
  /** A stop also cancels commands still waiting for their worktree to be prepared. */
  generation(sessionId:string):string {return `${this.epoch}:${this.stops.get(sessionId)??0}`;}

  /** One command at a time per session; the previous one must finish or be stopped first. */
  run(sessionId:string,cwd:string,command:string,generation=this.generation(sessionId)):{id:string}{
    if(generation!==this.generation(sessionId))throw new ProjectError('TERMINAL_STOPPED','The command was canceled before it started.');
    if(this.running.has(sessionId))throw new ProjectError('TERMINAL_BUSY','A command is still running in this session. Stop it first.');
    const text=command.trim();
    if(!text||text.length>8000)throw new ProjectError('TERMINAL_EMPTY','Type a command to run.');
    const id=randomUUID();
    const shell=windows?(process.env.ComSpec??'cmd.exe'):(process.env.SHELL&&path.isAbsolute(process.env.SHELL)?process.env.SHELL:'/bin/sh');
    // cmd /s strips this outer pair of quotes; the exact command keeps its own
    // quotes, including a leading quoted executable path containing spaces.
    const child=spawn(shell,windows?['/d','/s','/c','"',text,'"']:['-lc',text],{
      cwd,detached:!windows,windowsHide:true,windowsVerbatimArguments:windows,stdio:['ignore','pipe','pipe'],
      env:{...process.env,PATH:hostPath(),HOME:os.homedir(),TERM:'dumb',NO_COLOR:'1',FORCE_COLOR:'0',CI:process.env.CI??''},
    });
    const entry={id,child,stopped:false};
    this.running.set(sessionId,entry);
    let sent=0;
    const forward=(chunk:string)=>{
      if(sent>=MAX_OUTPUT)return;
      // Strip terminal control sequences; this panel shows plain text.
      const text=chunk.replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/gu,'').replace(/\r(?!\n)/gu,'\n').slice(0,MAX_OUTPUT-sent);
      sent+=text.length;
      this.emit({sessionId,id,kind:'output',text:sent>=MAX_OUTPUT?`${text}\n… output limit reached; the command keeps running.\n`:text});
    };
    child.stdout?.setEncoding('utf8').on('data',forward);child.stderr?.setEncoding('utf8').on('data',forward);
    const done=(code:number|null)=>{
      if(this.running.get(sessionId)?.id!==id)return;
      this.running.delete(sessionId);
      this.emit({sessionId,id,kind:'exit',code,stopped:entry.stopped});
    };
    child.on('error',error=>{forward(`${error.message}\n`);done(127);});
    child.on('close',code=>done(code));
    return {id};
  }

  stop(sessionId:string):null {
    this.stops.set(sessionId,(this.stops.get(sessionId)??0)+1);
    const entry=this.running.get(sessionId);
    if(!entry)return null;
    entry.stopped=true;
    const pid=entry.child.pid;
    if(pid){
      if(windows)spawnSync('taskkill',['/pid',String(pid),'/T','/F'],{windowsHide:true,stdio:'ignore'});
      else{try{process.kill(-pid,'SIGTERM');}catch{/* already gone */}setTimeout(()=>{try{process.kill(-pid,'SIGKILL');}catch{/* gone */}},2000).unref();}
    }
    return null;
  }

  stopAll():void {this.epoch++;this.stops.clear();for(const sessionId of [...this.running.keys()])this.stop(sessionId);}
}
