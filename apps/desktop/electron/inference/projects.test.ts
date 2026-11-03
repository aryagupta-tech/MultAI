import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {mkdtemp,mkdir,readFile,readdir,realpath,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,describe,expect,it} from 'vitest';
import {ProjectRegistry,applyWork,checkpointChanges,compareUrl,createWork,diffWork,discardWork,git as projectGit,githubRepo,keepWork,listWorkFiles,parseDiff,pushWork,readWork,restoreCheckpoint,revertFile,safeRelative,snapshotWork} from './projects';
import {isDeniedPath} from '@multai/runtime';
import {TerminalHost,type TerminalEvent} from './terminal';

const cleanup:string[]=[];
afterEach(async()=>{for(const directory of cleanup.splice(0))await rm(directory,{recursive:true,force:true});});
const sh=(cwd:string,...args:string[])=>execFileSync('git',args,{cwd,encoding:'utf8',env:{...process.env,GIT_AUTHOR_NAME:'Test',GIT_AUTHOR_EMAIL:'t@example.com',GIT_COMMITTER_NAME:'Test',GIT_COMMITTER_EMAIL:'t@example.com'}});

async function fixture(){
  const base=await realpath(await mkdtemp(join(tmpdir(),'multai-projects-')));cleanup.push(base);
  const repo=join(base,'shop');await mkdir(join(repo,'src'),{recursive:true});
  sh(repo,'init','-q','-b','main');sh(repo,'config','user.name','Host');sh(repo,'config','user.email','host@example.com');
  sh(repo,'config','core.autocrlf','false');
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

  it('preserves every project and one stable identity when registrations overlap',async()=>{
    const x=await fixture();
    const folders=await Promise.all(Array.from({length:4},async(_,index)=>{
      const root=join(x.base,`other-${index}`);await mkdir(root);
      sh(root,'init','-q','-b','main');sh(root,'commit','--allow-empty','-qm','init');
      return root;
    }));
    const registryFile=join(x.base,'concurrent-projects.json');
    const registries=[new ProjectRegistry(()=>registryFile),new ProjectRegistry(()=>registryFile)];
    const registered=await Promise.all([...folders,...folders].map((folder,index)=>registries[index%2]!.register(folder)));
    for(let index=0;index<folders.length;index++){
      expect(registered[index]!.projectId).toBe(registered[index+folders.length]!.projectId);
      expect(await registries[0]!.get(registered[index]!.projectId)).toMatchObject({root:folders[index]});
    }
    expect(await registries[0]!.all()).toHaveLength(folders.length);
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

describe('checkpoints and file lists',()=>{
  it('undo respects the host repository line-ending configuration',async()=>{
    const x=await fixture();const sessionId=randomUUID();const root=join(x.workspaces,sessionId);
    sh(x.repo,'config','core.autocrlf','true');
    await createWork({root,sessionId,projectId:x.project.projectId,project:await x.registry.get(x.project.projectId),carry:false,title:'configured line endings'});
    const before=await readFile(join(root,'old.txt'));
    expect(before.toString('utf8')).toBe('remove me\r\n');
    await snapshotWork(root,'Remove a file');
    await rm(join(root,'old.txt'));
    await restoreCheckpoint(root);
    expect(await readFile(join(root,'old.txt'))).toEqual(before);
    expect(sh(x.repo,'config','--local','--get','core.autocrlf').trim()).toBe('true');
  });

  it('snapshots deep worktree paths without changing repository Git configuration',async()=>{
    const x=await fixture();const sessionId=randomUUID();
    sh(x.repo,'config','core.longpaths','false');
    const configBefore=await readFile(join(x.repo,'.git','config'),'utf8');
    const root=join(x.workspaces,'scope-'.repeat(16),'session-'.repeat(13),sessionId);
    expect(root.length).toBeGreaterThan(260);
    await createWork({root,sessionId,projectId:x.project.projectId,project:await x.registry.get(x.project.projectId),carry:false,title:'deep workspace'});
    await writeFile(join(root,'README.md'),'# Earlier work\n');
    const statusBefore=(await projectGit(root,['status','--porcelain=v1'])).stdout;
    expect((await projectGit(root,['config','--get','core.longpaths'])).stdout.trim()).toBe('true');
    expect(await snapshotWork(root,'Take a checkpoint')).not.toBeNull();
    expect((await projectGit(root,['status','--porcelain=v1'])).stdout).toBe(statusBefore);
    expect(await readFile(join(x.repo,'.git','config'),'utf8')).toBe(configBefore);
    expect((await readdir(join(root,'..'))).some(file=>file.includes('.snapshot-'))).toBe(false);
  });

  it('lists the worktree\'s files without ignored or private ones',async()=>{
    const x=await fixture();const sessionId=randomUUID();const root=join(x.workspaces,sessionId);
    const info=await createWork({root,sessionId,projectId:x.project.projectId,project:await x.registry.get(x.project.projectId),carry:false,title:'files'});
    await writeFile(join(root,'.gitignore'),'dist/\n');await mkdir(join(root,'dist'));await writeFile(join(root,'dist','out.js'),'x');
    await mkdir(join(root,'node_modules','pkg'),{recursive:true});await writeFile(join(root,'node_modules','pkg','index.js'),'x');
    await writeFile(join(root,'.env'),'KEY=1');await writeFile(join(root,'notes.md'),'n');
    const {files}=await listWorkFiles(root);
    const visible=files.filter(file=>!isDeniedPath(file));
    expect(visible.sort()).toEqual(['.gitignore','README.md','notes.md','old.txt','src/cart.js']);
    expect(files).not.toContain('dist/out.js');
    void info;
  });
  it('undoes exactly what a run changed and leaves earlier work alone',async()=>{
    const x=await fixture();const sessionId=randomUUID();const root=join(x.workspaces,sessionId);
    await createWork({root,sessionId,projectId:x.project.projectId,project:await x.registry.get(x.project.projectId),carry:false,title:'undo'});
    // Work from an earlier run, uncommitted, that undo must keep.
    await writeFile(join(root,'README.md'),'# Shop, edited before\n');await writeFile(join(root,'kept.txt'),'earlier\n');
    const checkpoint=await snapshotWork(root,'Change the cart');
    expect(checkpoint).toMatchObject({instruction:'Change the cart'});
    const again=await snapshotWork(root,'Same again');
    expect(again).toMatchObject({commit:checkpoint!.commit,instruction:'Same again'});
    expect((await readWork(root))!.checkpoints).toHaveLength(1);
    // The run: modify, add, delete.
    await writeFile(join(root,'src','cart.js'),'broken\n');await writeFile(join(root,'src','new.js'),'new\n');await rm(join(root,'old.txt'));
    const preview=(await checkpointChanges(root))!;
    expect(preview.files.sort((a,b)=>a.path.localeCompare(b.path))).toEqual([{path:'old.txt',status:'deleted'},{path:'src/cart.js',status:'modified'},{path:'src/new.js',status:'added'}]);
    const undone=await restoreCheckpoint(root);
    expect(undone.files.sort()).toEqual(['old.txt','src/cart.js','src/new.js']);
    expect(await readFile(join(root,'src','cart.js'),'utf8')).toContain('reduce');
    expect(await readFile(join(root,'old.txt'),'utf8')).toBe('remove me\n');
    expect(await readdir(join(root,'src'))).toEqual(['cart.js']);
    expect(await readFile(join(root,'README.md'),'utf8')).toBe('# Shop, edited before\n');
    expect(await readFile(join(root,'kept.txt'),'utf8')).toBe('earlier\n');
    expect((await readWork(root))!.checkpoints).toEqual([]);
    await expect(restoreCheckpoint(root)).rejects.toMatchObject({code:'NO_CHECKPOINT'});
    // The host's checkout and refs: untouched apart from the checkpoint ref, which is gone again.
    expect(sh(x.repo,'status','--porcelain')).toBe('');
    expect(sh(x.repo,'for-each-ref','refs/multai/')).toBe('');
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
    const node=(script:string)=>`"${process.execPath}" -e "${script}"`;
    terminal.run('s1',folder,node("console.log(process.cwd()); console.log('hi')"));
    await expect.poll(()=>events.some(event=>event.kind==='exit'),{timeout:10_000}).toBe(true);
    expect(events.filter(event=>event.kind==='output').map(event=>event.kind==='output'?event.text:'').join('')).toBe(`${folder}\nhi\n`);
    expect(events.at(-1)).toMatchObject({kind:'exit',code:0,stopped:false});
    events.length=0;
    terminal.run('s1',folder,node('setTimeout(()=>{},30000)'));
    expect(()=>terminal.run('s1',folder,node('console.log(1)'))).toThrow(/still running/);
    terminal.stop('s1');
    await expect.poll(()=>events.find(event=>event.kind==='exit'),{timeout:10_000}).toMatchObject({stopped:true});
  });
});
