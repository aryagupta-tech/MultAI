import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,describe,expect,it} from 'vitest';
import {McpClient,McpHost,validServer,type McpServer} from './mcp';

const cleanup:string[]=[];
afterEach(async()=>{for(const directory of cleanup.splice(0))await rm(directory,{recursive:true,force:true});});

// A tiny stdio MCP server: initialize, two tools, one that errors and one that never answers.
const FAKE=`
let buffer='';
process.stdin.setEncoding('utf8');
process.stdin.on('data',chunk=>{buffer+=chunk;let i;while((i=buffer.indexOf('\\n'))>=0){const line=buffer.slice(0,i);buffer=buffer.slice(i+1);if(line.trim())handle(JSON.parse(line));}});
const reply=(id,result)=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',id,result})+'\\n');
function handle(m){
  if(m.method==='initialize')return reply(m.id,{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fake',version:'1'}});
  if(m.method==='notifications/initialized')return;
  if(m.method==='tools/list')return reply(m.id,{tools:[
    {name:'echo',description:'Echo text back',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text']}},
    {name:'cwd',description:'Where am I',inputSchema:{type:'object',properties:{}}},
    {name:'fail',description:'Always fails'},{name:'hang',description:'Never answers'}]});
  if(m.method==='tools/call'){
    if(m.params.name==='echo')return reply(m.id,{content:[{type:'text',text:'echo: '+m.params.arguments.text+' '+(process.env.SECRET_NAME??'')}]});
    if(m.params.name==='cwd')return reply(m.id,{content:[{type:'text',text:process.cwd()}]});
    if(m.params.name==='fail')return reply(m.id,{content:[{type:'text',text:'bad input'}],isError:true});
    if(m.params.name==='hang')return;
  }
  process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,error:{code:-32601,message:'unknown'}})+'\\n');
}`;

async function fixture(){
  const directory=await mkdtemp(join(tmpdir(),'multai-mcp-'));cleanup.push(directory);
  const script=join(directory,'server.mjs');await writeFile(script,FAKE);
  const server:McpServer={id:'s1',name:'fake',command:process.execPath,args:[script],env:{SECRET_NAME:'from-env',ELECTRON_RUN_AS_NODE:'1'},enabled:true};
  return {directory,server};
}

describe('MCP over stdio',()=>{
  it('starts, lists tools, calls them in the given folder, and reports tool errors as results',async()=>{
    const {directory,server}=await fixture();
    const client=new McpClient(server,directory);
    try{
      await client.start();
      const tools=await client.tools();
      expect(tools.map(tool=>tool.name)).toEqual(['echo','cwd','fail','hang']);
      expect(tools[2]!.inputSchema).toEqual({type:'object',properties:{}});
      expect(await client.call('echo',{text:'hi'})).toEqual({text:'echo: hi from-env',isError:false});
      expect((await client.call('cwd',{})).text).toContain('multai-mcp-');
      expect(await client.call('fail',{})).toEqual({text:'bad input',isError:true});
      await expect(client.call('hang',{},300)).rejects.toMatchObject({code:'MCP_TIMEOUT'});
    }finally{await client.close();}
    await expect(client.call('echo',{text:'x'})).rejects.toMatchObject({code:'MCP_STOPPED'});
  });
  it('explains a missing command, and the host skips a broken server',async()=>{
    const {directory,server}=await fixture();
    const missing={...server,id:'s2',name:'missing',command:'multai-no-such-command'};
    await expect(new McpHost(async()=>[missing]).test(missing,directory)).rejects.toThrow(/wasn’t found/u);
    const host=new McpHost(async()=>[server,missing]);
    try{
      expect((await host.tools(directory)).map(tool=>`${tool.server}.${tool.name}`)).toEqual(['fake.echo','fake.cwd','fake.fail','fake.hang']);
      expect(await host.call('s1','echo',{text:'again'},directory)).toMatchObject({text:'echo: again from-env'});
      await expect(host.call('s2','echo',{},directory)).rejects.toThrow();
    }finally{await host.stopAll();}
  });
  it('sign-out during settings lookup cannot start a server or dispatch a tool',async()=>{
    const {directory,server}=await fixture();
    let release!:(servers:McpServer[])=>void;
    const host=new McpHost(()=>new Promise(resolve=>{release=resolve;}));
    const listing=host.tools(directory);await host.stopAll();release([server]);
    expect(await listing).toEqual([]);
    const calling=host.call(server.id,'echo',{text:'stale'},directory);
    const refused=expect(calling).rejects.toMatchObject({code:'MCP_STOPPED'});
    await host.stopAll();release([server]);await refused;
  });
  it('stops an initializing server and waits until its working directory is released',async()=>{
    const {directory,server}=await fixture();
    const script=join(directory,'initializing.mjs'),marker=join(directory,'started');
    // Like npx, the server starts a child inheriting stdio. Stopping only the launcher leaves the
    // worker alive and its working directory locked, so the real process tree must be terminated.
    await writeFile(script,"import{writeFileSync}from'node:fs';import{spawn}from'node:child_process';spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'inherit',env:{...process.env,ELECTRON_RUN_AS_NODE:'1'}});writeFileSync(process.argv[2],'ready');process.stdin.resume();");
    const host=new McpHost(async()=>[{...server,args:[script,marker]}]);
    const listing=host.tools(directory);
    const {access}=await import('node:fs/promises');
    await expect.poll(async()=>{try{await access(marker);return true;}catch{return false;}}).toBe(true);
    await host.stopAll();expect(await listing).toEqual([]);
    await rm(directory,{recursive:true,force:true});
  });
  it('validates server settings',()=>{
    const base={id:'x',name:'GitHub',command:'npx',args:['-y','pkg'],env:{TOKEN:'t'},enabled:true};
    expect(validServer(base).name).toBe('github');
    expect(()=>validServer({...base,name:'has space'})).toThrow();
    expect(()=>validServer({...base,env:{'BAD-NAME':'x'}})).toThrow();
    expect(()=>validServer({...base,command:''})).toThrow();
  });
});
