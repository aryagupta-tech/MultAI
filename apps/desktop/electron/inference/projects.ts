// The host's real projects. A project is a git checkout the host chose; each session in it gets its own
// git worktree on a `multai/…` branch, so the agent never edits the host's checkout directly. Only the
// host's buttons (keep, apply, discard, push) move work between the two, and every one of them is
// all-or-nothing. Paths stay in the main process; the renderer sees ids and display hints.
import {execFile,spawnSync} from 'node:child_process';
import {randomUUID} from 'node:crypto';
import {copyFile,lstat,mkdir,readFile,readdir,realpath,rename,rm,unlink,writeFile} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {FileChange,DiffHunk} from '../../src/model/types';

export class ProjectError extends Error {
  constructor(readonly code:string,message:string){super(message);this.name='ProjectError';}
}
export interface ProjectGit {branch:string|null;head:string;dirty:number;remote:string|null}
export interface ProjectRecord {root:string;name:string}
/** What a session's worktree came from. Stored next to the worktree, never shared. */
export interface WorkInfo {
  version:1;sessionId:string;projectId:string;projectName:string;
  /** baseCommit is where the review diff starts; fromCommit is the project's HEAD it branched from. */
  branch:string;baseBranch:string|null;baseCommit:string;fromCommit?:string;carried:boolean;createdAt:string;kept:string|null;pushedTo:string|null;
  /** Snapshots taken before each run, oldest first, so the host can undo what a run changed. */
  checkpoints?:Checkpoint[];
}
export interface Checkpoint {commit:string;at:string;instruction:string}
const MAX_CHECKPOINTS=20;
export interface WorkSummary {projectName:string;branch:string;baseBranch:string|null;baseCommit:string;fromCommit?:string;carried:boolean;kept:string|null;pushedTo:string|null;remote:string|null}

const MAX_DIFF_LINES=2000;
const MAX_FILES=200;
const MAX_CARRY_BYTES=5*1024*1024;

let loginPath:string|undefined;
/**
 * The PATH of the host's login shell, read once. Apps started from the Dock get a bare PATH, which
 * would hide git from Homebrew, gh, node and the like. Only PATH is taken from the shell.
 */
export function hostPath():string {
  if(loginPath!==undefined)return loginPath;
  const fallback=[process.env.PATH,'/opt/homebrew/bin','/usr/local/bin','/usr/bin','/bin','/usr/sbin','/sbin'].filter(Boolean).join(path.delimiter);
  if(process.platform==='win32')return loginPath=process.env.PATH??'';
  try{
    const shell=process.env.SHELL&&path.isAbsolute(process.env.SHELL)?process.env.SHELL:'/bin/zsh';
    const marker='__MULTAI_PATH__';
    const result=spawnSync(shell,['-lc',`printf '${marker}%s${marker}' "$PATH"`],{encoding:'utf8',timeout:5000,env:{HOME:os.homedir(),USER:os.userInfo().username,SHELL:shell}});
    const found=result.stdout?.split(marker)[1];
    loginPath=found?`${found}${path.delimiter}${fallback}`:fallback;
  }catch{loginPath=fallback;}
  return loginPath;
}
/** Directories of the developer tools the agent's approved commands may need (node, npm, python…). */
export function toolPath():string {
  const wanted=['node','npm','npx','pnpm','yarn','bun','python3','pip3','go','cargo','rustc','java','ruby','deno','make','git'];
  const directories=new Set<string>(['/usr/bin','/bin','/usr/sbin','/sbin']);
  for(const directory of hostPath().split(path.delimiter)){
    if(!directory||!path.isAbsolute(directory))continue;
    for(const tool of wanted){try{if(spawnSync('test',['-x',path.join(directory,tool)]).status===0){directories.add(directory);break;}}catch{/* skip */}}
  }
  return [...directories].join(path.delimiter);
}

function gitEnvironment(extra:Record<string,string>={}):NodeJS.ProcessEnv {
  // No inherited GIT_* overrides (GIT_DIR, GIT_WORK_TREE…) can redirect these commands elsewhere.
  return {PATH:hostPath(),HOME:os.homedir(),LANG:'C',LC_ALL:'C',GIT_TERMINAL_PROMPT:'0',GIT_OPTIONAL_LOCKS:'0',
    ...(process.env.SSH_AUTH_SOCK?{SSH_AUTH_SOCK:process.env.SSH_AUTH_SOCK}:{}),...extra};
}
interface GitResult {stdout:string;stderr:string;code:number}
export function git(cwd:string,args:string[],options:{input?:string;allowFail?:boolean;timeout?:number;command?:string;env?:Record<string,string>}={}):Promise<GitResult>{
  return new Promise((resolve,reject)=>{
    const child=execFile(options.command??'git',args,{cwd,env:gitEnvironment(options.env),maxBuffer:32*1024*1024,timeout:options.timeout??60_000,windowsHide:true},(error,stdout,stderr)=>{
      const code=error?(typeof (error as {code?:unknown}).code==='number'?(error as {code:number}).code:1):0;
      if(error&&(error as {code?:unknown}).code==='ENOENT')return reject(new ProjectError('GIT_MISSING',options.command==='gh'?'The GitHub CLI (gh) isn’t installed.':'Git isn’t installed on this computer. Install it and try again.'));
      if(code&&!options.allowFail)return reject(new ProjectError('GIT_FAILED',plainGitError(stderr||String(error?.message??''))));
      resolve({stdout,stderr,code});
    });
    if(options.input!==undefined){child.stdin?.end(options.input);}
  });
}
function plainGitError(stderr:string):string {
  const line=stderr.split('\n').map(item=>item.replace(/^(fatal|error):\s*/u,'').trim()).find(Boolean)??'Git failed.';
  return line.slice(0,300);
}

/** Paths from git or the renderer that must stay inside one checkout. */
export function safeRelative(file:string):string {
  if(typeof file!=='string'||!file||file.length>4096||path.isAbsolute(file)||/[\u0000-\u001f\\]/u.test(file))throw new ProjectError('UNSAFE_PATH','That file path isn’t valid.');
  const parts=file.split('/');
  if(parts.some(part=>!part||part==='.'||part==='..'||part.toLowerCase()==='.git'))throw new ProjectError('UNSAFE_PATH','That file path isn’t valid.');
  return file;
}

export function slug(text:string):string {
  return text.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/gu,'-').replace(/^-+|-+$/gu,'').slice(0,32).replace(/-+$/u,'');
}

export async function gitStatus(root:string):Promise<ProjectGit>{
  const head=await git(root,['rev-parse','--verify','-q','HEAD'],{allowFail:true});
  if(head.code)throw new ProjectError('NO_COMMITS','This repository has no commits yet. Make a first commit, then add it again.');
  const branch=(await git(root,['symbolic-ref','--short','-q','HEAD'],{allowFail:true})).stdout.trim()||null;
  const status=(await git(root,['status','--porcelain=v1','-z','--untracked-files=normal'])).stdout;
  const remote=(await git(root,['remote','get-url','origin'],{allowFail:true})).stdout.trim()||null;
  // With -z a rename or copy takes two entries (new, then old); count each change once.
  const entries=status.split('\0').filter(Boolean);
  return {branch,head:head.stdout.trim(),dirty:entries.length-entries.filter(entry=>/^[RC]/u.test(entry)).length,remote};
}

/** Host-chosen project folders, by id. Kept per device in the app's data folder. */
export class ProjectRegistry {
  constructor(private readonly file:()=>string){}
  private async load():Promise<Record<string,ProjectRecord>>{
    try{
      const value=JSON.parse(await readFile(this.file(),'utf8')) as unknown;
      if(!value||typeof value!=='object'||Array.isArray(value))return {};
      return Object.fromEntries(Object.entries(value as Record<string,unknown>).filter((entry):entry is [string,ProjectRecord]=>{
        const record=entry[1] as Partial<ProjectRecord>|null;return typeof record?.root==='string'&&path.isAbsolute(record.root)&&typeof record.name==='string';
      }));
    }catch{return {};}
  }
  private async save(records:Record<string,ProjectRecord>):Promise<void>{
    const destination=this.file();await mkdir(path.dirname(destination),{recursive:true,mode:0o700});
    const temporary=`${destination}.${randomUUID()}.tmp`;
    await writeFile(temporary,JSON.stringify(records),{mode:0o600,flag:'wx'});await rename(temporary,destination);
  }
  /** Registers the repository that contains `folder`. Not a git repository → a readable refusal. */
  async register(folder:string):Promise<{projectId:string;name:string;root:string;git:ProjectGit}>{
    const chosen=await realpath(folder);
    const top=await git(chosen,['rev-parse','--show-toplevel'],{allowFail:true});
    if(top.code||!top.stdout.trim())throw new ProjectError('NOT_GIT','This folder isn’t a git repository. Run “git init” and make a first commit in it, then add it again.');
    const root=await realpath(top.stdout.trim());
    const status=await gitStatus(root);
    return serial(this.file(),async()=>{
      const records=await this.load();
      const existing=Object.entries(records).find(([,record])=>record.root===root);
      const projectId=existing?.[0]??randomUUID();
      records[projectId]={root,name:path.basename(root)};
      await this.save(records);
      return {projectId,name:path.basename(root),root,git:status};
    });
  }
  async get(projectId:string):Promise<ProjectRecord>{
    const record=(await this.load())[projectId];
    if(!record)throw new ProjectError('UNKNOWN_PROJECT','This project isn’t linked on this computer. Add its folder again.');
    const stat=await lstat(record.root).catch(()=>null);
    if(!stat?.isDirectory())throw new ProjectError('PROJECT_MOVED','The project folder was moved or deleted. Add it again.');
    return record;
  }
  async status(projectId:string):Promise<ProjectGit>{return gitStatus((await this.get(projectId)).root);}
  async all():Promise<ProjectRecord[]>{return Object.values(await this.load());}
}

const infoFile=(root:string)=>`${root}.work.json`;
export async function readWork(root:string):Promise<WorkInfo|null>{
  try{
    const value=JSON.parse(await readFile(infoFile(root),'utf8')) as WorkInfo;
    return value?.version===1&&typeof value.baseCommit==='string'&&typeof value.branch==='string'?value:null;
  }catch{return null;}
}
async function writeWork(root:string,info:WorkInfo):Promise<void>{
  const temporary=`${infoFile(root)}.${randomUUID()}.tmp`;
  await writeFile(temporary,JSON.stringify(info),{mode:0o600,flag:'wx'});await rename(temporary,infoFile(root));
}
/** git refuses commits without an identity; fall back to a local one rather than failing the host's click. */
async function identityArgs(root:string):Promise<string[]>{
  const email=(await git(root,['config','user.email'],{allowFail:true})).stdout.trim();
  const name=(await git(root,['config','user.name'],{allowFail:true})).stdout.trim();
  return [...(name?[]:['-c','user.name=MultAI']),...(email?[]:['-c','user.email=multai@localhost'])];
}

/**
 * Creates the session's worktree at `root` on a new `multai/<title>-<id>` branch from the project's HEAD.
 * With `carry`, the host's uncommitted edits and new files become one starting commit on that branch,
 * read without touching the host's checkout (no stash entry, no index change), so the agent starts
 * from exactly what the host sees and the review shows only the agent's work.
 */
export async function createWork(input:{root:string;sessionId:string;projectId:string;project:ProjectRecord;carry:boolean;title:string}):Promise<WorkInfo>{
  const existing=await readWork(input.root);
  if(existing)return existing;
  const projectRoot=input.project.root;
  const status=await gitStatus(projectRoot);
  const branch=`multai/${slug(input.title)||'session'}-${input.sessionId.slice(0,6)}`;
  await mkdir(path.dirname(input.root),{recursive:true,mode:0o700});
  // An empty leftover directory is fine for git; anything else means a half-made workspace.
  const leftover=await readdir(input.root).catch(()=>null);
  if(leftover&&leftover.length)throw new ProjectError('WORKSPACE_EXISTS','This session already has a workspace that isn’t linked to a project.');
  if(leftover)await rm(input.root,{recursive:true});
  await git(projectRoot,['worktree','add','--quiet','-b',branch,input.root,status.head]);
  let baseCommit=status.head;let carried=false;
  try{
    if(input.carry&&status.dirty>0){
      const snapshot=(await git(projectRoot,['stash','create'])).stdout.trim();
      if(snapshot)await git(input.root,['stash','apply','--quiet',snapshot]);
      const untracked=(await git(projectRoot,['ls-files','--others','--exclude-standard','-z'])).stdout.split('\0').filter(Boolean);
      let bytes=0;
      for(const file of untracked){
        const from=path.join(projectRoot,safeRelative(file));const stat=await lstat(from).catch(()=>null);
        if(!stat?.isFile()||stat.size>1024*1024||(bytes+=stat.size)>MAX_CARRY_BYTES)continue;
        await mkdir(path.dirname(path.join(input.root,file)),{recursive:true});await copyFile(from,path.join(input.root,file));
      }
      await git(input.root,['add','-A']);
      const staged=await git(input.root,['diff','--cached','--quiet'],{allowFail:true});
      if(staged.code){
        await git(input.root,[...await identityArgs(input.root),'commit','--quiet','--no-verify','-m','Start from the host’s uncommitted changes']);
        baseCommit=(await git(input.root,['rev-parse','HEAD'])).stdout.trim();carried=true;
      }
    }
  }catch(error){await discardWork(input.root,{root:projectRoot},{branch,deleteBranch:true}).catch(()=>undefined);throw error;}
  const info:WorkInfo={version:1,sessionId:input.sessionId,projectId:input.projectId,projectName:input.project.name,branch,baseBranch:status.branch,baseCommit,fromCommit:status.head,carried,createdAt:new Date().toISOString(),kept:null,pushedTo:null};
  await writeWork(input.root,info);
  return info;
}

// One git operation at a time per worktree: two at once collide on the worktree's index.lock.
const queues=new Map<string,Promise<unknown>>();
function serial<T>(root:string,task:()=>Promise<T>):Promise<T>{
  const next=(queues.get(root)??Promise.resolve()).catch(()=>undefined).then(task);
  queues.set(root,next);
  void next.finally(()=>{if(queues.get(root)===next)queues.delete(root);}).catch(()=>undefined);
  return next;
}

/** Everything the agent changed since the session started, committed or not, as review-ready files. */
export function diffWork(root:string,info:WorkInfo):Promise<FileChange[]>{
  return serial(root,async()=>{
    // Intent-to-add lets untracked files show up in one diff; it only touches this worktree's own index.
    await git(root,['add','--intent-to-add','--all']);
    const raw=(await git(root,['-c','core.quotePath=false','diff','--no-color','--no-ext-diff','-M',info.baseCommit])).stdout;
    return parseDiff(raw);
  });
}

export function parseDiff(raw:string):FileChange[]{
  const files:FileChange[]=[];
  let current:(FileChange&{lines:number})|null=null;let hunk:DiffHunk|null=null;let oldNo=0;let newNo=0;
  const finish=()=>{if(current){const {lines:_lines,...file}=current;files.push(file);}current=null;hunk=null;};
  for(const line of raw.split('\n')){
    if(line.startsWith('diff --git ')){
      finish();if(files.length>=MAX_FILES)break;
      const match=/^diff --git a\/(.+) b\/(.+)$/u.exec(line);
      current={path:match?.[2]??line.slice(11),status:'modified',additions:0,deletions:0,hunks:[],lines:0};continue;
    }
    if(!current)continue;
    if(!hunk){
      if(line.startsWith('new file mode'))current.status='added';
      else if(line.startsWith('deleted file mode'))current.status='deleted';
      else if(line.startsWith('rename to '))current.path=line.slice(10);
      else if(line.startsWith('Binary files')){current.hunks.push({header:'Binary file changed',lines:[]});}
    }
    const header=/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/u.exec(line);
    if(header){oldNo=Number(header[1]);newNo=Number(header[2]);hunk={header:line,lines:[]};current.hunks.push(hunk);continue;}
    if(!hunk)continue;
    if(current.lines>=MAX_DIFF_LINES){if(current.lines++===MAX_DIFF_LINES)hunk.lines.push({kind:'context',text:'… more lines not shown'});continue;}
    if(line.startsWith('+')){hunk.lines.push({kind:'add',text:line.slice(1),newNo:newNo++});current.additions++;current.lines++;}
    else if(line.startsWith('-')){hunk.lines.push({kind:'del',text:line.slice(1),oldNo:oldNo++});current.deletions++;current.lines++;}
    else if(line.startsWith(' ')){hunk.lines.push({kind:'context',text:line.slice(1),oldNo:oldNo++,newNo:newNo++});current.lines++;}
  }
  finish();
  return files;
}

/** Puts one file back the way it was when the session started. */
export function revertFile(root:string,info:WorkInfo,file:string):Promise<void>{return serial(root,()=>revertFileNow(root,info,file));}
async function revertFileNow(root:string,info:WorkInfo,file:string):Promise<void>{
  const relative=safeRelative(file);
  const inBase=(await git(root,['cat-file','-e',`${info.baseCommit}:${relative}`],{allowFail:true})).code===0;
  if(inBase){await git(root,['checkout',info.baseCommit,'--',relative]);return;}
  await git(root,['rm','--cached','--quiet','--force','--ignore-unmatch','--',relative]);
  await unlink(path.join(root,relative)).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;});
}

/** Commits the agent's work on the session branch. The host's own checkout is not touched. */
export function keepWork(root:string,info:WorkInfo,message:string):Promise<{commit:string;branch:string}>{return serial(root,()=>keepWorkNow(root,info,message));}
async function keepWorkNow(root:string,info:WorkInfo,message:string):Promise<{commit:string;branch:string}>{
  const text=message.trim().slice(0,2000)||'Changes from a MultAI session';
  await git(root,['add','-A']);
  if((await git(root,['diff','--cached','--quiet'],{allowFail:true})).code===0){
    const head=(await git(root,['rev-parse','HEAD'])).stdout.trim();
    if(head===info.baseCommit)throw new ProjectError('NOTHING_TO_KEEP','There are no changes to keep yet.');
    return {commit:head,branch:info.branch};
  }
  await git(root,[...await identityArgs(root),'commit','--quiet','--no-verify','-F','-'],{input:text});
  const commit=(await git(root,['rev-parse','HEAD'])).stdout.trim();
  await writeWork(root,{...info,kept:commit});
  return {commit,branch:info.branch};
}

/**
 * Applies the session's changes to the host's own checkout as uncommitted edits. git apply is atomic:
 * it checks every hunk first and changes nothing when any of them doesn't fit.
 */
export async function applyWork(root:string,info:WorkInfo,project:ProjectRecord):Promise<{files:string[]}>{
  const files=await diffWork(root,info);
  if(!files.length)throw new ProjectError('NOTHING_TO_APPLY','There are no changes to apply yet.');
  const patch=(await git(root,['diff','--binary','--no-color','--no-ext-diff','-M',info.baseCommit])).stdout;
  const check=await git(project.root,['apply','--check','--whitespace=nowarn','-'],{input:patch,allowFail:true});
  if(check.code){
    const conflicts=[...new Set([...check.stderr.matchAll(/(?:patch failed|already exists in working directory|does not exist in index|No such file or directory):?\s*([^\s:]+)/gu)].map(match=>match[1]))].slice(0,10);
    throw new ProjectError('APPLY_CONFLICT',conflicts.length?`These files changed in your folder since the session started: ${conflicts.join(', ')}. Nothing was applied. Keep the work on its branch and merge it instead.`:'Your folder changed since the session started, so the changes don’t fit. Nothing was applied. Keep the work on its branch and merge it instead.');
  }
  await git(project.root,['apply','--whitespace=nowarn','-'],{input:patch});
  return {files:files.map(file=>file.path)};
}

/** Every file in the worktree that git tracks or would track, for the composer's @ picker. */
export async function listWorkFiles(root:string,limit=20_000):Promise<{files:string[];truncated:boolean}>{
  const out=(await git(root,['-c','core.quotePath=false','ls-files','-z','--cached','--others','--exclude-standard','--deduplicate'])).stdout.split('\0').filter(Boolean);
  return {files:out.slice(0,limit),truncated:out.length>limit};
}

const checkpointRef=(info:WorkInfo,commit:string)=>`refs/multai/checkpoints/${info.sessionId}/${commit}`;
/**
 * The worktree as a commit, made through a temporary index so the worktree's own index and HEAD stay
 * as they are. Ignored files are left out, like everywhere else in the review.
 */
export async function snapshotTree(root:string):Promise<string>{
  const index=`${root}.snapshot-${randomUUID()}.index`;
  const env={GIT_INDEX_FILE:index};
  try{
    // Starting from a copy of the worktree's own index lets git skip files whose size and time match,
    // instead of hashing every tracked file again.
    const own=(await git(root,['rev-parse','--path-format=absolute','--git-path','index'])).stdout.trim();
    if(!(await copyFile(own,index).then(()=>true,()=>false)))await git(root,['read-tree','HEAD'],{env});
    await git(root,['add','-A'],{env});
    return (await git(root,['write-tree'],{env})).stdout.trim();
  }finally{await unlink(index).catch(()=>undefined);}
}
/** Saves the worktree before a run. Kept under refs/multai so git's cleanup doesn't remove it. */
export function snapshotWork(root:string,instruction:string):Promise<Checkpoint|null>{
  return serial(root,async()=>{
    const info=await readWork(root);if(!info)return null;
    const tree=await snapshotTree(root);
    const commit=(await git(root,['-c','user.name=MultAI','-c','user.email=multai@localhost','commit-tree',tree,'-p','HEAD','-m','MultAI checkpoint'])).stdout.trim();
    const list=info.checkpoints??[];
    const last=list.at(-1);
    const checkpoint={commit,at:new Date().toISOString(),instruction:instruction.replace(/\s+/gu,' ').trim().slice(0,120)};
    // Nothing changed since the last snapshot: reuse its commit, but it now stands for this newer run.
    if(last&&(await git(root,['rev-parse',`${last.commit}^{tree}`],{allowFail:true})).stdout.trim()===tree){
      const reused={...checkpoint,commit:last.commit};
      await writeWork(root,{...info,checkpoints:[...list.slice(0,-1),reused]});
      return reused;
    }
    const next=[...list,checkpoint];
    await git(root,['update-ref',checkpointRef(info,commit),commit]);
    for(const dropped of next.splice(0,Math.max(0,next.length-MAX_CHECKPOINTS)))await git(root,['update-ref','-d',checkpointRef(info,dropped.commit)],{allowFail:true});
    await writeWork(root,{...info,checkpoints:next});
    return checkpoint;
  });
}
/** What undoing the last run would change: files that differ between its checkpoint and now. */
export function checkpointChanges(root:string):Promise<{checkpoint:Checkpoint;files:{path:string;status:'added'|'modified'|'deleted'}[]}|null>{
  return serial(root,async()=>{
    const info=await readWork(root);const checkpoint=info?.checkpoints?.at(-1);
    if(!checkpoint)return null;
    return {checkpoint,files:await changedSince(root,checkpoint.commit)};
  });
}
async function changedSince(root:string,commit:string):Promise<{path:string;status:'added'|'modified'|'deleted'}[]>{
  const now=await snapshotTree(root);
  const raw=(await git(root,['-c','core.quotePath=false','diff-tree','-r','-z','--no-renames','--name-status',`${commit}^{tree}`,now])).stdout.split('\0').filter(Boolean);
  const files:{path:string;status:'added'|'modified'|'deleted'}[]=[];
  for(let index=0;index+1<raw.length;index+=2){
    const code=raw[index]![0];const file=raw[index+1]!;
    files.push({path:file,status:code==='A'?'added':code==='D'?'deleted':'modified'});
  }
  return files;
}
/**
 * Puts the worktree back to its last checkpoint: files the run added are removed, the rest restored.
 * Only the worktree's files change; its index, HEAD and the host's checkout are not touched.
 */
export function restoreCheckpoint(root:string):Promise<{checkpoint:Checkpoint;files:string[]}>{
  return serial(root,async()=>{
    const info=await readWork(root);const checkpoint=info?.checkpoints?.at(-1);
    if(!info||!checkpoint)throw new ProjectError('NO_CHECKPOINT','There is no earlier run to undo in this session.');
    const files=await changedSince(root,checkpoint.commit);
    if(!files.length)throw new ProjectError('NOTHING_TO_UNDO','The files already match how they were before the last run.');
    for(const file of files.filter(item=>item.status==='added')){
      await unlink(path.join(root,safeRelative(file.path))).catch(error=>{if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;});
    }
    const restore=files.filter(item=>item.status!=='added').map(item=>safeRelative(item.path));
    for(let start=0;start<restore.length;start+=200)await git(root,['restore',`--source=${checkpoint.commit}`,'--worktree','--',...restore.slice(start,start+200)]);
    const list=info.checkpoints!.slice(0,-1);
    await git(root,['update-ref','-d',checkpointRef(info,checkpoint.commit)],{allowFail:true});
    await writeWork(root,{...info,checkpoints:list});
    return {checkpoint,files:files.map(file=>file.path)};
  });
}

/** Removes the worktree, and its branch unless the work was kept or pushed. */
export async function discardWork(root:string,project:Pick<ProjectRecord,'root'>,options:{branch:string;deleteBranch:boolean}):Promise<void>{
  await git(project.root,['worktree','remove','--force',root],{allowFail:true});
  await rm(root,{recursive:true,force:true});
  await git(project.root,['worktree','prune'],{allowFail:true});
  if(options.deleteBranch)await git(project.root,['branch','-D',options.branch],{allowFail:true});
  const sessionId=path.basename(root);
  const refs=(await git(project.root,['for-each-ref','--format=%(refname)',`refs/multai/checkpoints/${sessionId}/`],{allowFail:true})).stdout.split('\n').filter(Boolean);
  for(const ref of refs)await git(project.root,['update-ref','-d',ref],{allowFail:true});
  await unlink(infoFile(root)).catch(()=>undefined);
}

/** owner/repo for GitHub remotes in https, ssh and scp-like forms. */
export function githubRepo(remote:string|null):string|null {
  if(!remote)return null;
  const match=/^(?:https:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?\/?$/u.exec(remote.trim());
  return match?.[1]??null;
}
/** GitHub's new-pull-request page; title and body prefill its form (the body is cut to keep the link short). */
export function compareUrl(repo:string,base:string,branch:string,pr?:{title:string;body:string}):string {
  const query=new URLSearchParams({expand:'1',...(pr?{title:pr.title.slice(0,250),body:pr.body.slice(0,4000)}:{})});
  return `https://github.com/${repo}/compare/${encodeURIComponent(base)}...${encodeURIComponent(branch)}?${query}`;
}

/** Pushes the session branch with the host's own git credentials. */
export async function pushWork(root:string,info:WorkInfo):Promise<{remote:string;branch:string}>{
  const remote=(await git(root,['remote','get-url','origin'],{allowFail:true})).stdout.trim();
  if(!remote)throw new ProjectError('NO_REMOTE','This project has no “origin” remote to push to.');
  if((await git(root,['rev-parse','HEAD'])).stdout.trim()===info.baseCommit)throw new ProjectError('NOTHING_TO_PUSH','Keep the changes on the branch before pushing.');
  const pushed=await git(root,['push','--quiet','-u','origin',`HEAD:refs/heads/${info.branch}`],{allowFail:true,timeout:120_000});
  if(pushed.code){
    const reason=/rejected|non-fast-forward|fetch first/u.test(pushed.stderr)?'The push was rejected because the remote branch has other commits. Pull or rename the branch first.':/Permission|denied|Authentication|could not read Username/iu.test(pushed.stderr)?'The push was refused: git on this computer isn’t signed in to that remote.':plainGitError(pushed.stderr);
    throw new ProjectError('PUSH_FAILED',reason);
  }
  await writeWork(root,{...info,pushedTo:remote});
  return {remote,branch:info.branch};
}

/** Opens a pull request with gh when it is installed and signed in; otherwise returns the compare page. */
export async function openPullRequest(root:string,info:WorkInfo,input:{title:string;body:string}):Promise<{url:string;created:boolean}>{
  const remote=(await git(root,['remote','get-url','origin'],{allowFail:true})).stdout.trim()||null;
  const repo=githubRepo(remote);
  if(!repo)throw new ProjectError('NOT_GITHUB','The branch was pushed. Opening a pull request from MultAI works with GitHub remotes; open it on your git host instead.');
  const base=info.baseBranch??((await git(root,['symbolic-ref','--short','-q','refs/remotes/origin/HEAD'],{allowFail:true})).stdout.trim().replace(/^origin\//u,'')||'main');
  const created=await git(root,['pr','create','--repo',repo,'--head',info.branch,'--base',base,'--title',input.title.slice(0,250),'--body-file','-'],{command:'gh',input:input.body.slice(0,60_000),allowFail:true,timeout:60_000}).catch(()=>null);
  const url=created&&!created.code?/https:\/\/github\.com\/\S+\/pull\/\d+/u.exec(created.stdout)?.[0]:undefined;
  if(url)return {url,created:true};
  return {url:compareUrl(repo,base,info.branch,input),created:false};
}
