import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {access,mkdtemp,mkdir,readFile,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,describe,expect,it} from 'vitest';
import {ProjectRegistry,createWork} from './projects';
import {applyCommit,captureWork,createLanes,laneResult,mergeLanes,parsePlan,removeLanes,routeDirection,splitTask} from './split';

const cleanup:string[]=[];
afterEach(async()=>{for(const directory of cleanup.splice(0))await rm(directory,{recursive:true,force:true});});
const sh=(cwd:string,...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8',env:{...process.env,GIT_AUTHOR_NAME:'Test',GIT_AUTHOR_EMAIL:'t@example.com',GIT_COMMITTER_NAME:'Test',GIT_COMMITTER_EMAIL:'t@example.com'}});
const exists=(file:string)=>access(file).then(()=>true,()=>false);

async function chat(){
  const base=await realpath(await mkdtemp(join(tmpdir(),'multai-split-')));cleanup.push(base);
  const repo=join(base,'shop');await mkdir(join(repo,'src'),{recursive:true});
  sh(repo,'init','-q','-b','main');sh(repo,'config','user.name','Host');sh(repo,'config','user.email','host@example.com');
  await writeFile(join(repo,'src','cart.js'),'export const total = items => items.reduce((a, b) => a + b, 0);\n');
  await writeFile(join(repo,'src','shared.js'),'line one\nline two\nline three\n');
  await writeFile(join(repo,'old.txt'),'remove me\n');
  sh(repo,'add','-A');sh(repo,'commit','-qm','init');
  const registry=new ProjectRegistry(()=>join(base,'data','projects.json'));
  const project=await registry.register(repo);
  const root=join(base,'data','workspaces',randomUUID());
  await createWork({root,project,projectId:project.projectId,sessionId:randomUUID(),title:'split',carry:false});
  return {root,repo};
}

describe('splitting a task',()=>{
  it('recognizes /split and nothing else',()=>{
    expect(splitTask('/split Add a cart page and an API')).toBe('Add a cart page and an API');
    expect(splitTask('  /split\nmulti\nline')).toBe('multi\nline');
    expect(splitTask('/split')).toBe('');
    expect(splitTask('/splitting hairs')).toBeNull();
    expect(splitTask('please /split this')).toBeNull();
  });

  it('accepts a plan with separate files and refuses overlap, unsafe paths and junk',()=>{
    const plan=parsePlan('Here you go:\n{"parts":[{"title":"API","task":"Add GET /cart","files":["./src/api.js","src/api.js"]},{"title":"Page","task":"Render the cart","files":["src/page.js","../escape.js",".git/config"]}]}');
    expect(plan).toEqual([{title:'API',task:'Add GET /cart',files:['src/api.js']},{title:'Page',task:'Render the cart',files:['src/page.js']}]);
    expect(()=>parsePlan('{"parts":[{"title":"A","task":"x","files":["a.js"]},{"title":"B","task":"y","files":["a.js"]}]}')).toThrow(/Two parts of the plan change a\.js/u);
    expect(()=>parsePlan('no json at all')).toThrow(/didn’t return a plan/u);
    expect(()=>parsePlan('{"parts":[]}')).toThrow(/incomplete/u);
    expect(()=>parsePlan(`{"parts":${JSON.stringify(Array.from({length:5},(_,i)=>({title:`P${i}`,task:'t',files:[]})))}}`)).toThrow(/incomplete/u);
    expect(()=>parsePlan('{"parts": [ {"title": "A", } ] }')).toThrow(/valid JSON/u);
  });

  it('routes "agent 2: …" to that agent and anything else to all of them',()=>{
    expect(routeDirection('agent 2: use cents',3)).toEqual({lane:2,text:'use cents'});
    expect(routeDirection('@Agent #1, keep the API',3)).toEqual({lane:1,text:'keep the API'});
    expect(routeDirection('Lane 3 - add a test',3)).toEqual({lane:3,text:'add a test'});
    expect(routeDirection('agent 7: nope',3)).toEqual({lane:null,text:'agent 7: nope'});
    expect(routeDirection('use cents everywhere',3)).toEqual({lane:null,text:'use cents everywhere'});
  });

  it('runs parts in their own worktrees and merges them into the chat, including deletions',async()=>{
    const {root}=await chat();
    // The chat already has work of its own before the split.
    await writeFile(join(root,'notes.md'),'host notes\n');
    const head=sh(root,'rev-parse','HEAD').trim();
    const base=await captureWork(root,head,'before split');
    const lanes=await createLanes(root,base,[{title:'API',task:'a',files:['src/api.js']},{title:'Cleanup',task:'b',files:['old.txt']},{title:'Nothing',task:'c',files:[]}]);
    expect(lanes.map(lane=>lane.index)).toEqual([1,2,3]);
    expect(await readFile(join(lanes[0]!.root,'notes.md'),'utf8')).toBe('host notes\n');
    await writeFile(join(lanes[0]!.root,'src','api.js'),'export const api = 1;\n');
    await rm(join(lanes[1]!.root,'old.txt'));
    const results=(await Promise.all(lanes.map(lane=>laneResult(lane,base)))).filter(result=>result!==null);
    expect(results.map(result=>[result.lane.index,result.files])).toEqual([[1,['src/api.js']],[2,['old.txt']]]);
    // Meanwhile the host edited the chat's worktree too.
    await writeFile(join(root,'src','cart.js'),'export const total = () => 42;\n');
    const current=await captureWork(root,base,'now');
    const outcome=await mergeLanes(root,base,current,results);
    expect(outcome.conflicts).toEqual([]);
    expect(outcome.merged.map(result=>result.lane.index)).toEqual([1,2]);
    expect((await applyCommit(root,current,outcome.commit)).sort()).toEqual(['old.txt','src/api.js']);
    expect(await readFile(join(root,'src','api.js'),'utf8')).toBe('export const api = 1;\n');
    expect(await exists(join(root,'old.txt'))).toBe(false);
    expect(await readFile(join(root,'src','cart.js'),'utf8')).toBe('export const total = () => 42;\n');
    // The chat's own index and HEAD are untouched; the merge shows up as ordinary changes.
    expect(sh(root,'rev-parse','HEAD').trim()).toBe(head);
    expect(sh(root,'diff','--cached','--name-only').trim()).toBe('');
    await removeLanes(root,lanes);
    for(const lane of lanes)expect(await exists(lane.root)).toBe(false);
    expect(sh(root,'worktree','list').includes('.lane-')).toBe(false);
  });

  it('leaves out a part that conflicts and names the files',async()=>{
    const {root}=await chat();
    const base=await captureWork(root,sh(root,'rev-parse','HEAD').trim(),'before split');
    const lanes=await createLanes(root,base,[{title:'One',task:'a',files:[]},{title:'Two',task:'b',files:[]}]);
    await writeFile(join(lanes[0]!.root,'src','shared.js'),'line one\nline TWO by agent 1\nline three\n');
    await writeFile(join(lanes[1]!.root,'src','shared.js'),'line one\nline 2 by agent 2\nline three\n');
    await writeFile(join(lanes[1]!.root,'src','extra.js'),'export const extra = true;\n');
    const results=(await Promise.all(lanes.map(lane=>laneResult(lane,base)))).filter(result=>result!==null);
    const outcome=await mergeLanes(root,base,base,results);
    expect(outcome.merged.map(result=>result.lane.index)).toEqual([1]);
    expect(outcome.conflicts.map(item=>[item.result.lane.index,item.files])).toEqual([[2,['src/shared.js']]]);
    await applyCommit(root,base,outcome.commit);
    expect(await readFile(join(root,'src','shared.js'),'utf8')).toBe('line one\nline TWO by agent 1\nline three\n');
    // The conflicting part is left out entirely, including its file that didn't conflict.
    expect(await exists(join(root,'src','extra.js'))).toBe(false);
    await removeLanes(root,lanes);
  });

  it('cleans up the worktrees it made when creating one fails',async()=>{
    const {root}=await chat();
    const base=await captureWork(root,sh(root,'rev-parse','HEAD').trim(),'before split');
    await expect(createLanes(root,'0000000000000000000000000000000000000000',[{title:'A',task:'a',files:[]}])).rejects.toThrow();
    expect(sh(root,'worktree','list').includes('.lane-')).toBe(false);
    const lanes=await createLanes(root,base,[{title:'A',task:'a',files:[]}]);
    expect(await laneResult(lanes[0]!,base)).toBeNull();
    await removeLanes(root,lanes);
  });
});
