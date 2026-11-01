// MCP tools from servers the host adds in Settings. A small client for the stdio transport: one process
// per server and folder, JSON-RPC 2.0 messages one per line (initialize, tools/list, tools/call). Only
// servers the host configured are started; a repository can't add any. Every tool call the agent makes
// is an `external` action the host approves like any other effect.
import {spawn,type ChildProcessWithoutNullStreams} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import os from 'node:os';
import {hostPath} from './projects';

export interface McpServer {id:string;name:string;command:string;args:string[];env:Record<string,string>;enabled:boolean}
export interface McpTool {serverId:string;server:string;name:string;description:string;inputSchema:Record<string,unknown>}
export class McpError extends Error {constructor(readonly code:string,message:string){super(message);this.name='McpError';}}

const PROTOCOL='2025-06-18';
const MAX_LINE=4*1024*1024;
const NAME=/^[a-z0-9][a-z0-9-]{0,23}$/u;

export function validServer(input:McpServer):McpServer {
  const name=input.name.trim().toLowerCase();
  if(!NAME.test(name))throw new McpError('INVALID_SERVER','Use a short name of lowercase letters, numbers and dashes (up to 24).');
  const command=input.command.trim();
  if(!command||command.length>1024||/[\u0000-\u001f]/u.test(command))throw new McpError('INVALID_SERVER','Enter the command that starts the server, like npx or /usr/local/bin/my-server.');
  if(input.args.length>64||input.args.some(arg=>arg.length>4096||arg.includes('\u0000')))throw new McpError('INVALID_SERVER','The server arguments are too long.');
  const env=Object.entries(input.env);
  if(env.length>32||env.some(([key,value])=>!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(key)||value.length>8192||value.includes('\u0000')))throw new McpError('INVALID_SERVER','Environment variables need NAME=value with a plain name.');
  return {id:input.id,name,command,args:[...input.args],env:Object.fromEntries(env),enabled:input.enabled};
}

/** One running server. Requests time out; a crash fails every pending request. */
export class McpClient {
  private child:ChildProcessWithoutNullStreams|null=null;
  private pending=new Map<number,{resolve:(value:unknown)=>void;reject:(error:Error)=>void;timer:NodeJS.Timeout}>();
  private nextId=1;
  private buffer='';
  private stderr='';
  private exited:string|null=null;
  constructor(private readonly server:McpServer,private readonly cwd:string){}

  async start(timeoutMs=20_000):Promise<void>{
    // The host's own PATH (so npx, uvx and friends resolve) and only the variables configured for this server.
    const env={PATH:hostPath(),HOME:os.homedir(),LANG:'C.UTF-8',...(process.env.TMPDIR?{TMPDIR:process.env.TMPDIR}:{}),...this.server.env};
    const child=spawn(this.server.command,this.server.args,{cwd:this.cwd,env,stdio:['pipe','pipe','pipe'],windowsHide:true});
    this.child=child;
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    // Writing to a server that already exited is reported through 'exit', not as a crash of the app.
    child.stdin.on('error',()=>undefined);
    child.stdout.on('data',(chunk:string)=>this.receive(chunk));
    child.stderr.on('data',(chunk:string)=>{this.stderr=(this.stderr+chunk).slice(-4000);});
    child.on('error',error=>this.fail((error as NodeJS.ErrnoException).code==='ENOENT'?`“${this.server.command}” wasn’t found on this computer.`:'The server could not start.'));
    child.on('exit',code=>this.fail(`The server stopped${code===null?'':` (exit ${code})`}.${this.stderr.trim()?` ${this.stderr.trim().split('\n').at(-1)!.slice(0,300)}`:''}`));
    await this.request('initialize',{protocolVersion:PROTOCOL,capabilities:{},clientInfo:{name:'MultAI',version:'0.1.0'}},timeoutMs);
    this.notify('notifications/initialized');
  }
  async tools():Promise<McpTool[]>{
    const tools:McpTool[]=[];let cursor:string|undefined;
    for(let page=0;page<5;page++){
      const result=await this.request('tools/list',cursor?{cursor}:{}) as {tools?:unknown[];nextCursor?:unknown};
      for(const raw of result.tools??[]){
        const tool=raw as {name?:unknown;description?:unknown;inputSchema?:unknown};
        if(typeof tool.name!=='string'||!tool.name||tool.name.length>128)continue;
        const schema=tool.inputSchema&&typeof tool.inputSchema==='object'&&!Array.isArray(tool.inputSchema)?tool.inputSchema as Record<string,unknown>:{type:'object',properties:{}};
        tools.push({serverId:this.server.id,server:this.server.name,name:tool.name,description:typeof tool.description==='string'?tool.description.slice(0,2000):'',inputSchema:schema});
      }
      if(typeof result.nextCursor!=='string'||!result.nextCursor)break;
      cursor=result.nextCursor;
    }
    return tools;
  }
  /** The tool's text content. A tool-level error (isError) is a result the agent can read, not a crash. */
  async call(name:string,args:unknown,timeoutMs=120_000):Promise<{text:string;isError:boolean}>{
    const result=await this.request('tools/call',{name,arguments:args??{}},timeoutMs) as {content?:unknown[];isError?:unknown;structuredContent?:unknown};
    const parts=(result.content??[]).map(part=>{
      const item=part as {type?:unknown;text?:unknown;resource?:{text?:unknown;uri?:unknown}};
      if(item.type==='text'&&typeof item.text==='string')return item.text;
      if(item.type==='resource'&&typeof item.resource?.text==='string')return item.resource.text;
      return item.type?`[${String(item.type)} content not shown]`:'';
    }).filter(Boolean);
    const text=parts.length?parts.join('\n'):result.structuredContent!==undefined?JSON.stringify(result.structuredContent):'';
    return {text:text.slice(0,16_000),isError:result.isError===true};
  }
  close():void {
    const child=this.child;this.child=null;
    this.fail('The server was stopped.');
    if(child&&child.exitCode===null){child.kill('SIGTERM');setTimeout(()=>{if(child.exitCode===null)child.kill('SIGKILL');},2000).unref();}
  }
  get alive():boolean {return Boolean(this.child)&&this.exited===null;}

  private request(method:string,params:unknown,timeoutMs=30_000):Promise<unknown>{
    if(this.exited)return Promise.reject(new McpError('MCP_STOPPED',this.exited));
    const id=this.nextId++;
    return new Promise((resolve,reject)=>{
      const timer=setTimeout(()=>{this.pending.delete(id);reject(new McpError('MCP_TIMEOUT',`“${this.server.name}” didn’t answer ${method} in time.`));},timeoutMs);
      timer.unref();
      this.pending.set(id,{resolve,reject,timer});
      this.child!.stdin.write(`${JSON.stringify({jsonrpc:'2.0',id,method,params})}\n`);
    });
  }
  private notify(method:string):void {this.child?.stdin.write(`${JSON.stringify({jsonrpc:'2.0',method})}\n`);}
  private receive(chunk:string):void {
    this.buffer+=chunk;
    if(this.buffer.length>MAX_LINE){this.fail('The server sent a message that is too large.');this.child?.kill('SIGKILL');return;}
    let newline:number;
    while((newline=this.buffer.indexOf('\n'))>=0){
      const line=this.buffer.slice(0,newline).trim();this.buffer=this.buffer.slice(newline+1);
      if(!line)continue;
      let message:{id?:unknown;result?:unknown;error?:{message?:unknown};method?:unknown};
      try{message=JSON.parse(line);}catch{continue;}
      // Requests from the server (sampling, roots…) aren't supported; say so instead of leaving it waiting.
      if(message.method!==undefined&&message.id!==undefined){this.child?.stdin.write(`${JSON.stringify({jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Not supported by MultAI'}})}\n`);continue;}
      const waiting=typeof message.id==='number'?this.pending.get(message.id):undefined;
      if(!waiting)continue;
      this.pending.delete(message.id as number);clearTimeout(waiting.timer);
      if(message.error)waiting.reject(new McpError('MCP_ERROR',typeof message.error.message==='string'?message.error.message.slice(0,500):'The server reported an error.'));
      else waiting.resolve(message.result??{});
    }
  }
  private fail(reason:string):void {
    if(this.exited===null)this.exited=reason;
    for(const [id,waiting] of this.pending){clearTimeout(waiting.timer);waiting.reject(new McpError('MCP_STOPPED',reason));this.pending.delete(id);}
  }
}

/** Running servers per folder, started on first use and stopped on sign-out and quit. */
export class McpHost {
  private clients=new Map<string,Promise<McpClient>>();
  private toolCache=new Map<string,McpTool[]>();
  constructor(private readonly servers:()=>Promise<McpServer[]>){}
  private client(server:McpServer,cwd:string):Promise<McpClient>{
    const key=`${server.id}\u0000${cwd}`;
    const existing=this.clients.get(key);
    if(existing)return existing.then(client=>client.alive?client:this.restart(key,server,cwd));
    return this.restart(key,server,cwd);
  }
  private restart(key:string,server:McpServer,cwd:string):Promise<McpClient>{
    const starting=(async()=>{const client=new McpClient(server,cwd);try{await client.start();}catch(error){client.close();throw error;}return client;})();
    this.clients.set(key,starting);
    starting.catch(()=>{if(this.clients.get(key)===starting)this.clients.delete(key);});
    return starting;
  }
  /** Tools from every enabled server in this folder. A server that fails is skipped, not fatal. */
  async tools(cwd:string):Promise<McpTool[]>{
    const all:McpTool[]=[];
    for(const server of (await this.servers()).filter(item=>item.enabled)){
      try{
        const key=`${server.id}\u0000${cwd}`;
        if(!this.toolCache.has(key))this.toolCache.set(key,await (await this.client(server,cwd)).tools());
        all.push(...this.toolCache.get(key)!);
      }catch{/* Shown when the host tests the server in Settings. */}
    }
    return all;
  }
  async call(serverId:string,tool:string,args:unknown,cwd:string):Promise<{text:string;isError:boolean}>{
    const server=(await this.servers()).find(item=>item.id===serverId&&item.enabled);
    if(!server)throw new McpError('MCP_UNAVAILABLE','That MCP server was turned off or removed.');
    return (await this.client(server,cwd)).call(tool,args);
  }
  /** Starts the server in a scratch folder, lists its tools and stops it. */
  async test(server:McpServer,cwd:string):Promise<string[]>{
    const client=new McpClient(server,cwd);
    try{await client.start();return (await client.tools()).map(tool=>tool.name);}
    finally{client.close();}
  }
  stopAll():void {
    for(const starting of this.clients.values())void starting.then(client=>client.close(),()=>undefined);
    this.clients.clear();this.toolCache.clear();
  }
}

export const newServerId=()=>randomUUID();
