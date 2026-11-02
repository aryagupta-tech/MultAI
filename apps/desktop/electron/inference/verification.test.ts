import {afterEach,expect,test,vi} from 'vitest';
import {mkdtemp,realpath,writeFile,mkdir,rm,rename,chmod,symlink,truncate,utimes,stat} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {checkRequirements,sourceRevision,type VerificationCriterion} from './verification';

const roots:string[]=[];
afterEach(async()=>{await Promise.all(roots.splice(0).map(root=>rm(root,{recursive:true,force:true})));});
async function workspace(git=false){
  const root=await realpath(await mkdtemp(join(tmpdir(),'multai-proof-')));roots.push(root);
  if(git){execFileSync('git',['init','-q'],{cwd:root});execFileSync('git',['config','user.name','Synthetic Verification'],{cwd:root});execFileSync('git',['config','user.email','verification@example.invalid'],{cwd:root});}
  return root;
}
const criterion=(checkCommand:string|null='npm test',state:VerificationCriterion['state']='approved'):VerificationCriterion=>({id:randomUUID(),text:'One order per checkout',checkCommand,version:1,state});
const signal=()=>new AbortController().signal;

test('source revisions track file bytes, paths, untracked additions and deletions without trusting mtime',async()=>{
  const root=await workspace(true),file=join(root,'cart.ts');await writeFile(file,'export const total = 1;');
  execFileSync('git',['add','cart.ts'],{cwd:root});execFileSync('git',['commit','-qm','baseline'],{cwd:root});
  const original=await sourceRevision(root),metadata=await stat(file);
  expect(await sourceRevision(root)).toBe(original);
  await writeFile(file,'export const total = 2;');await utimes(file,metadata.atime,metadata.mtime);
  expect(await sourceRevision(root)).not.toBe(original);
  await writeFile(file,'export const total = 1;');expect(await sourceRevision(root)).toBe(original);
  await writeFile(join(root,'new.ts'),'new source');const added=await sourceRevision(root);expect(added).not.toBe(original);
  await rename(join(root,'new.ts'),join(root,'renamed.ts'));expect(await sourceRevision(root)).not.toBe(added);
  await rm(join(root,'renamed.ts'));expect(await sourceRevision(root)).toBe(original);
  await rm(file);expect(await sourceRevision(root)).not.toBe(original);
});

test('source fingerprints executable permissions, binary bytes and unusual valid names',async()=>{
  const root=await workspace(),file=join(root,'a space-é-file.bin');await writeFile(file,Buffer.from([0,1,255,13,10]));
  await chmod(file,0o644);const original=await sourceRevision(root);
  if(process.platform!=='win32'){await chmod(file,0o755);expect(await sourceRevision(root)).not.toBe(original);await chmod(file,0o644);expect(await sourceRevision(root)).toBe(original);}
  await writeFile(file,Buffer.from([0,1,254,13,10]));expect(await sourceRevision(root)).not.toBe(original);
});

test('Git ignores generated output while tracked ignored source still contributes',async()=>{
  const root=await workspace(true);await writeFile(join(root,'.gitignore'),'generated/\ntracked.ts\n');await writeFile(join(root,'tracked.ts'),'first');
  execFileSync('git',['add','-f','tracked.ts'],{cwd:root});
  const initial=await sourceRevision(root);await mkdir(join(root,'generated'));await writeFile(join(root,'generated','result.json'),'one');expect(await sourceRevision(root)).toBe(initial);
  await writeFile(join(root,'generated','result.json'),'two');expect(await sourceRevision(root)).toBe(initial);
  await writeFile(join(root,'tracked.ts'),'second');expect(await sourceRevision(root)).not.toBe(initial);
});

test('protected secrets and dependency folders are excluded even when Git tracks them',async()=>{
  const root=await workspace(true);await writeFile(join(root,'safe.ts'),'source');await writeFile(join(root,'.env'),'PRIVATE=one');await mkdir(join(root,'node_modules'));await writeFile(join(root,'node_modules','dependency.js'),'first');
  execFileSync('git',['add','-f','.env','node_modules/dependency.js','safe.ts'],{cwd:root});const original=await sourceRevision(root);
  await writeFile(join(root,'.env'),'PRIVATE=two');await writeFile(join(root,'node_modules','dependency.js'),'second');expect(await sourceRevision(root)).toBe(original);
});

test('symlink roots, source symlinks and oversized files fail closed',async()=>{
  const root=await workspace(),outside=await workspace();await writeFile(join(outside,'secret'),'not source');
  await symlink(outside,join(root,'linked-root'),'dir');await expect(sourceRevision(join(root,'linked-root'))).rejects.toMatchObject({code:'VERIFICATION_PATH'});
  await rm(join(root,'linked-root'));await symlink(join(outside,'secret'),join(root,'linked-file'));
  await expect(sourceRevision(root)).rejects.toMatchObject({code:'VERIFICATION_PATH'});await rm(join(root,'linked-file'));
  const large=join(root,'large.bin');await writeFile(large,'');await truncate(large,16*1024*1024+1);await expect(sourceRevision(root)).rejects.toMatchObject({code:'VERIFICATION_LIMIT'});
});

test('only approved exact commands execute; manual criteria stay manual and nonzero results remain failures',async()=>{
  const root=await workspace();await writeFile(join(root,'source.ts'),'source');
  const manual=criterion(null),passing=criterion('test exact bytes'),failing=criterion('failing command');
  const execute=vi.fn(async(command:string)=>({exitCode:command==='failing command'?1:0,output:command==='failing command'?'Duplicate order':'passed'}));
  const result=await checkRequirements(root,[criterion('unapproved','proposed'),manual,passing,failing,criterion('withdrawn','withdrawn')],execute,signal());
  expect(execute.mock.calls.map(call=>call[0])).toEqual(['test exact bytes','failing command']);expect(result.records).toHaveLength(3);
  expect(result.records[0]).toMatchObject({criterionId:manual.id,kind:'manual'});expect(result.records[0]).not.toHaveProperty('exitCode');
  expect(result.records[1]).toMatchObject({criterionId:passing.id,kind:'command',command:'test exact bytes',exitCode:0,revision:result.revision});
  expect(result.records[2]).toMatchObject({criterionId:failing.id,exitCode:1,output:'Duplicate order'});
});

test('denied, malformed and missing process outcomes do not become proof',async()=>{
  const root=await workspace();const execute=vi.fn().mockResolvedValueOnce({error:'rejected'}).mockResolvedValueOnce({output:'passed'}).mockResolvedValueOnce({exitCode:'0',output:'passed'}).mockResolvedValueOnce({exitCode:0,output:'verified'});
  const result=await checkRequirements(root,[criterion(),criterion(),criterion(),criterion()],execute,signal());
  expect(result.records).toHaveLength(1);expect(result.notes).toHaveLength(3);expect(result.records[0]).toMatchObject({exitCode:0,output:'verified'});
});

test('changes made by a check invalidate both that result and earlier results for the old source',async()=>{
  const root=await workspace(),file=join(root,'cart.ts');await writeFile(file,'initial');let calls=0;
  const execute=async()=>{if(++calls===2)await writeFile(file,'changed during test');return {exitCode:0,output:'passed'};};
  const result=await checkRequirements(root,[criterion(),criterion(),criterion()],execute,signal());
  expect(result.records).toHaveLength(1);expect(result.notes.some(note=>note.includes('source changed during the check'))).toBe(true);expect(result.notes.some(note=>note.includes('later source changes invalidated'))).toBe(true);
  expect(result.records[0]!.revision).toBe(await sourceRevision(root));
});

test('cancellation before or during a check never returns passing evidence',async()=>{
  const root=await workspace(),controller=new AbortController(),execute=vi.fn(async()=>({exitCode:0,output:'passed'}));controller.abort();
  await expect(checkRequirements(root,[criterion()],execute,controller.signal)).rejects.toBeDefined();expect(execute).not.toHaveBeenCalled();
  const during=new AbortController();await expect(checkRequirements(root,[criterion()],async()=>{during.abort();return {exitCode:0,output:'passed'};},during.signal)).rejects.toBeDefined();
});

test('verbose and binary command output fits the evidence API and preserves truncation disclosure',async()=>{
  const root=await workspace();
  const result=await checkRequirements(root,[criterion(),criterion()],vi.fn().mockResolvedValueOnce({exitCode:0,output:'x'.repeat(20000),truncated:false}).mockResolvedValueOnce({exitCode:1,output:'short\0binary',truncated:true}),signal());
  expect(result.records[0]!.output.length).toBeLessThanOrEqual(6000);expect(result.records[0]!.output).toMatch(/\[Output truncated\]$/u);
  expect(result.records[1]!.output).toBe('shortbinary\n[Output truncated]');expect(result.records[1]!.exitCode).toBe(1);
});

test('termination flags and a terminating signal cannot masquerade as successful completion',async()=>{
  const root=await workspace();
  const result=await checkRequirements(root,[criterion(),criterion(),criterion()],vi.fn().mockResolvedValueOnce({exitCode:0,output:'partial',timedOut:true}).mockResolvedValueOnce({exitCode:0,output:'partial',canceled:true}).mockResolvedValueOnce({exitCode:0,output:'partial',signal:'SIGTERM'}),signal());
  expect(result.records[0]).toMatchObject({timedOut:true});expect(result.records[1]).toMatchObject({canceled:true});expect(result.records[2]).toMatchObject({exitCode:null});
});
