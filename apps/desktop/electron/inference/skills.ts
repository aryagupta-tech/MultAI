// Skills: reusable instructions in a folder with a SKILL.md, from the project (.multai/skills, or
// .claude/skills for repositories that already have them) or the host's own personal skills. The agent
// sees each skill's name and description and loads the body when it needs it, or the host forces one
// with /<name>. Reads are bounded and refuse links, so a repository can't point the loader elsewhere.
import {randomUUID} from 'node:crypto';
import {lstat,mkdir,open,readdir,rename,rm,writeFile} from 'node:fs/promises';
import path from 'node:path';

export type SkillSource='project'|'personal';
export interface Skill {name:string;description:string;body:string;source:SkillSource}
export class SkillError extends Error {constructor(readonly code:string,message:string){super(message);this.name='SkillError';}}

export const MAX_SKILLS=50;
const MAX_SKILL_BYTES=32*1024;
const NAME=/^[a-z0-9][a-z0-9-]{0,47}$/u;
export const PROJECT_SKILL_FOLDERS=['.multai/skills','.claude/skills'];

/** `---\nname: x\ndescription: y\n---\nbody` with simple one-line values. */
export function parseSkill(text:string,folder:string):{name:string;description:string;body:string}|null{
  const match=/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/u.exec(text);
  const fields:Record<string,string>={};
  for(const line of (match?.[1]??'').split(/\r?\n/u)){
    const field=/^([A-Za-z_-]+):\s*(.*)$/u.exec(line);
    if(field)fields[field[1]!.toLowerCase()]=field[2]!.trim().replace(/^(["'])(.*)\1$/u,'$2');
  }
  const name=(fields.name||folder).toLowerCase().replace(/[^a-z0-9-]+/gu,'-').replace(/^-+|-+$/gu,'');
  if(!NAME.test(name))return null;
  const body=(match?match[2]!:text).trim();
  if(!body)return null;
  const description=(fields.description||body.split('\n').find(line=>line.trim()&&!line.startsWith('#'))||name).trim().slice(0,300);
  return {name,description,body};
}

async function readBounded(file:string):Promise<string|null>{
  const stat=await lstat(file).catch(()=>null);
  if(!stat?.isFile()||stat.isSymbolicLink()||stat.size>MAX_SKILL_BYTES)return null;
  const handle=await open(file,'r');
  try{
    const buffer=Buffer.alloc(Math.min(stat.size,MAX_SKILL_BYTES));
    const {bytesRead}=await handle.read(buffer,0,buffer.length,0);
    const text=buffer.subarray(0,bytesRead).toString('utf8');
    return text.includes('\u0000')?null:text;
  }finally{await handle.close();}
}

/** Skills from each folder in order; the first skill with a name wins. */
export async function loadSkills(sources:readonly {directory:string;source:SkillSource}[]):Promise<Skill[]>{
  const skills:Skill[]=[];const names=new Set<string>();
  for(const {directory,source} of sources){
    const stat=await lstat(directory).catch(()=>null);
    if(!stat?.isDirectory()||stat.isSymbolicLink())continue;
    const entries=(await readdir(directory,{withFileTypes:true}).catch(()=>[])).filter(entry=>entry.isDirectory()).sort((a,b)=>a.name.localeCompare(b.name));
    for(const entry of entries){
      if(skills.length>=MAX_SKILLS)return skills;
      const text=await readBounded(path.join(directory,entry.name,'SKILL.md')).catch(()=>null);
      const parsed=text?parseSkill(text,entry.name):null;
      if(!parsed||names.has(parsed.name))continue;
      names.add(parsed.name);skills.push({...parsed,source});
    }
  }
  return skills;
}

/** Creates or replaces a personal skill. */
export async function savePersonalSkill(directory:string,input:{name:string;description:string;body:string}):Promise<Skill>{
  const name=input.name.trim().toLowerCase();
  if(!NAME.test(name))throw new SkillError('INVALID_SKILL','Use lowercase letters, numbers and dashes for the skill name, up to 48 characters.');
  const description=input.description.replace(/\s+/gu,' ').trim().slice(0,300);
  const body=input.body.trim();
  if(!body)throw new SkillError('INVALID_SKILL','Write the skill’s instructions first.');
  const text=`---\nname: ${name}\ndescription: ${description}\n---\n\n${body}\n`;
  if(Buffer.byteLength(text)>MAX_SKILL_BYTES)throw new SkillError('INVALID_SKILL','Skills can be at most 32 KB.');
  const folder=path.join(directory,name);
  await mkdir(folder,{recursive:true,mode:0o700});
  const target=path.join(folder,'SKILL.md');const temporary=`${target}.${randomUUID()}.tmp`;
  await writeFile(temporary,text,{mode:0o600,flag:'wx'});await rename(temporary,target);
  return {name,description:description||name,body,source:'personal'};
}

export async function deletePersonalSkill(directory:string,name:string):Promise<void>{
  if(!NAME.test(name))throw new SkillError('INVALID_SKILL','That isn’t a skill name.');
  const folder=path.join(directory,name);
  const stat=await lstat(folder).catch(()=>null);
  if(!stat)return;
  if(stat.isSymbolicLink()||!stat.isDirectory())throw new SkillError('INVALID_SKILL','That skill folder isn’t a plain folder.');
  await rm(folder,{recursive:true,force:true});
}
