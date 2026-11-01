import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,readdir,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,describe,expect,it} from 'vitest';
import {ProjectRegistry,applyWork,compareUrl,createWork,diffWork,discardWork,githubRepo,keepWork,parseDiff,pushWork,readWork,revertFile,safeRelative} from './projects';
import {TerminalHost,type TerminalEvent} from './terminal';

const cleanup:string[]=[];
afterEach(async()=>{for(const directory of cleanup.splice(0))await rm(directory,{recursive:true,force:true});});
const sh=(cwd:string,...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8',env:{...process.env,GIT_AUTHOR_NAME:'Test',GIT_AUTHOR_EMAIL:'t@example.com',GIT_COMMITTER_NAME:'Test',GIT_COMMITTER_EMAIL:'t@example.com'}});

async function fixture(){
  const base=await realpath(await mkdtemp(join(tmpdir(),'multai-projects-')));cleanup.push(base);
  const repo=join(base,'shop');await mkdir(join(repo,'src'),{recursive:true});
  sh(repo,'init','-q','-b','main');sh(repo,'config','user.name','Host');sh(repo,'config','user.email','host@example.com');
  await writeFile(join(repo,'src','cart.js'),'export const total = items => items.reduce((a, b) => a + b, 0);\n');
  await writeFile(join(repo,'README.md'),'# Shop\n');
  await writeFile(join(repo,'old.txt'),'remove me\n');
  sh(repo,'add','-A');sh(repo,'commit','-qm','init');
  const registry=new ProjectRegistry(()=>join(base,'data','projects.json'));
  const project=await registry.register(join(repo,'src'));
  const workspaces=join(base,'data','workspaces');
  return {base,repo,registry,project,workspaces};
}

describe('project worktrees',()=>{
  it('registers the repository root and refuses folders that are not git repositories',async()=>{
    const x=await fixture();
    expect(x.project).toMatchObject({name:'shop',root:x.repo,git:{branch:'main',dirty:0,remote:null}});
    expect((await x.registry.register(x.repo)).projectId).toBe(x.project.projectId);
    const plain=join(x.base,'plain');await mkdir(plain);
    await expect(x.registry.register(plain)).rejects.toMatchObject({code:'NOT_GIT'});
    await expect(x.registry.get(randomUUID())).rejects.toMatchObject({code:'UNKNOWN_PROJECT'});
  });

  it('works on its own branch, shows every kind of change, and applies it to the host folder',async()=>{
    const x=await fixture();const sessionId=randomUUID();const root=join(x.workspaces,sessionId);
    const info=await createWork({root,sessionId,projectId:x.project.projectId,project:await x.registry.get(x.project.projectId),carry:false,title:'Fix the cart total!'});
    expect(info.branch).toBe(`multai/fix-the-cart-total-${sessionId.slice(0,6)}`);
    expect(sh(x.repo,'branch','--list',info.branch)).toContain(info.branch);
    await writeFile(join(root,'src','cart.js'),'export const total = items => items.reduce((a, b) => a + b.price, 0);\n');
    await writeFile(join(root,'src','tax.js'),'export const tax = n => n * 0.2;\n');
    await rm(join(root,'old.txt'));
    // Opening a session refreshes the review from two places at once; git must not collide on index.lock.
    const [files,...again]=await Promise.all([diffWork(root,info),diffWork(root,info),diffWork(root,info),diffWork(root,info)]);
    expect(files!.map(file=>[file.path,file.status,file.additions,file.deletions])).toEqual([['old.txt','deleted',0,1],['src/cart.js','modified',1,1],['src/tax.js','added',1,0]]);
    for(const other of again)expect(other).toEqual(files);
    // The host's checkout is untouched until the host applies.
    expect(sh(x.repo,'status','--porcelain')).toBe('');
    await revertFile(root,info,'old.txt');
    await revertFile(root,info,'src/tax.js');
    expect((await diffWork(root,info)).map(file=>file.path)).toEqual(['src/cart.js']);
    await expect(revertFile(root,info,'../shop/README.md')).rejects.toMatchObject({code:'UNSAFE_PATH'});
    expect(await applyWork(root,info,{root:x.repo,name:'shop'})).toEqual({files:['src/cart.js']});
    expect(await readFile(join(x.repo,'src','cart.js'),'utf8')).toContain('b.price');
    expect(sh(x.repo,'status','--porcelain').trim()).toBe('M src/cart.js');
  });

  it('refuses to apply over the host\'s own edits and changes nothing',async()=>{
    const x=await fixture();const sessionId=randomUUID();const root=join(x.workspaces,sessionId);
    const info=await createWork({root,sessionId,projectId:x.project.projectId,project:await x.registry.get(x.project.projectId),carry:false,title:'x'});
    await writeFile(join(root,'README.md'),'# Shop by the agent\n');
    await writeFile(join(root,'new.md'),'new\n');
    await writeFile(join(x.repo,'README.md'),'# Shop by the host\n');
    const before=await readFile(join(x.repo,'README.md'),'utf8');
    await expect(applyWork(root,info,{root:x.repo,name:'shop'})).rejects.toMatchObject({code:'APPLY_CONFLICT',message:expect.stringContaining('README.md')});
    expect(await readFile(join(x.repo,'README.md'),'utf8')).toBe(before);
    expect(await readdir(x.repo)).not.toContain('new.md');
  });

  it('carries the host\'s uncommitted work as the starting point without touching the checkout',async()=>{
    const x=await fixture();const sessionId=randomUUID();const root=join(x.workspaces,sessionId);
    await writeFile(join(x.repo,'README.md'),'# Shop (host draft)\n');
    await writeFile(join(x.repo,'notes.md'),'host notes\n');
    const statusBefore=sh(x.repo,'status','--porcelain');const stashes=sh(x.repo,'stash','list');
    const info=await createWork({root,sessionId,projectId:x.project.projectId,project:await x.registry.get(x.project.projectId),carry:true,title:'carry'});
    expect(info.carried).toBe(true);
    expect(await readFile(join(root,'README.md'),'utf8')).toBe('# Shop (host draft)\n');
    expect(await readFile(join(root,'notes.md'),'utf8')).toBe('host notes\n');
    expect(sh(x.repo,'status','--porcelain')).toBe(statusBefore);
    expect(sh(x.repo,'stash','list')).toBe(stashes);
    // The review shows only the agent's work, and applying it fits on top of the host's draft.
    expect(await diffWork(root,info)).toEqual([]);
    await writeFile(join(root,'README.md'),'# Shop (host draft)\n\nMore.\n');
    expect(await applyWork(root,info,{root:x.repo,name:'shop'})).toEqual({files:['README.md']});
    expect(await readFile(join(x.repo,'README.md'),'utf8')).toContain('More.');
  });

  it('keeps work on the branch, pushes it, and discards the worktree',async()=>{
    const x=await fixture();const sessionId=randomUUID();const root=join(x.workspaces,sessionId);
    const remote=join(x.base,'remote.git');sh(x.base,'init','-q','--bare',remote);sh(x.repo,'remote','add','origin',remote);
    const info=await createWork({root,sessionId,projectId:x.project.projectId,project:await x.registry.get(x.project.projectId),carry:false,title:'push me'});
    await expect(keepWork(root,info,'nothing')).rejects.toMatchObject({code:'NOTHING_TO_KEEP'});
    await expect(pushWork(root,info)).rejects.toMatchObject({code:'NOTHING_TO_PUSH'});
    await writeFile(join(root,'feature.txt'),'done\n');
    const kept=await keepWork(root,info,'Add the feature');
    expect(sh(x.repo,'log','-1','--format=%s',info.branch).trim()).toBe('Add the feature');
    expect(sh(x.repo,'status','--porcelain')).toBe('');
    const saved=(await readWork(root))!;expect(saved.kept).toBe(kept.commit);
    await pushWork(root,saved);
    expect(sh(remote,'branch','--list')).toContain(info.branch);
    expect((await readWork(root))!.pushedTo).toBe(remote);
    await discardWork(root,{root:x.repo},{branch:info.branch,deleteBranch:false});
    expect(sh(x.repo,'worktree','list')).not.toContain(sessionId);
    expect(sh(x.repo,'branch','--list',info.branch)).toContain(info.branch);
    expect(await readWork(root)).toBeNull();
  });

  it('discarding unkept work removes its branch too',async()=>{
    const x=await fixture();const sessionId=randomUUID();const root=join(x.workspaces,sessionId);
    const info=await createWork({root,sessionId,projectId:x.project.projectId,project:await x.registry.get(x.project.projectId),carry:false,title:'throwaway'});
    await discardWork(root,{root:x.repo},{branch:info.branch,deleteBranch:true});
    expect(sh(x.repo,'branch','--list',info.branch)).toBe('');
  });
});

describe('project helpers',()=>{
  it('reads GitHub remotes and builds compare links',()=>{
    for(const remote of ['git@github.com:acme/shop.git','https://github.com/acme/shop.git','https://github.com/acme/shop','ssh://git@github.com/acme/shop.git'])expect(githubRepo(remote),remote).toBe('acme/shop');
    expect(githubRepo('git@gitlab.com:acme/shop.git')).toBeNull();
    expect(compareUrl('acme/shop','main','multai/fix-1')).toBe('https://github.com/acme/shop/compare/main...multai%2Ffix-1?expand=1');
    const prefilled=new URL(compareUrl('acme/shop','main','multai/fix-1',{title:'Fix & test',body:'x'.repeat(5000)}));
    expect(prefilled.searchParams.get('title')).toBe('Fix & test');
    expect(prefilled.searchParams.get('body')).toHaveLength(4000);
  });
  it('refuses unsafe paths and caps long diffs',()=>{
    for(const bad of ['/etc/passwd','../x','a/../b','.git/config','a\\b',''])expect(()=>safeRelative(bad),bad).toThrow();
    const long=['diff --git a/big.txt b/big.txt','new file mode 100644','--- /dev/null','+++ b/big.txt','@@ -0,0 +1,3000 @@',...Array.from({length:3000},(_,i)=>`+line ${i}`)].join('\n');
    const [file]=parseDiff(long);
    expect(file).toMatchObject({path:'big.txt',status:'added',additions:2000});
    expect(file!.hunks[0]!.lines.at(-1)!.text).toMatch(/more lines/);
  });
});

describe('host terminal',()=>{
  it('runs in the given folder, streams output, and stops on request',async()=>{
    const folder=await realpath(await mkdtemp(join(tmpdir(),'multai-terminal-')));cleanup.push(folder);
    const events:TerminalEvent[]=[];
    const terminal=new TerminalHost(event=>events.push(event));
    terminal.run('s1',folder,'pwd; echo hi');
    await expect.poll(()=>events.some(event=>event.kind==='exit'),{timeout:10_000}).toBe(true);
    expect(events.filter(event=>event.kind==='output').map(event=>event.kind==='output'?event.text:'').join('')).toBe(`${folder}\nhi\n`);
    expect(events.at(-1)).toMatchObject({kind:'exit',code:0,stopped:false});
    events.length=0;
    terminal.run('s1',folder,'sleep 30');
    expect(()=>terminal.run('s1',folder,'ls')).toThrow(/still running/);
    terminal.stop('s1');
    await expect.poll(()=>events.find(event=>event.kind==='exit'),{timeout:10_000}).toMatchObject({stopped:true});
  });
});
