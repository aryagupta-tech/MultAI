import {mkdtemp,mkdir,rm,symlink,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach,describe,expect,it} from 'vitest';
import {anchorsFor,applyCompaction,attachMentions,autoCompactCut,expandCommand,mentionedPaths,type ContextMessage} from './context';
import {deletePersonalSkill,loadSkills,parseSkill,savePersonalSkill} from './skills';

const cleanup:string[]=[];
afterEach(async()=>{for(const directory of cleanup.splice(0))await rm(directory,{recursive:true,force:true});});

describe('@ mentions',()=>{
  it('finds file and folder tokens but not e-mail addresses or traversal',()=>{
    expect(mentionedPaths('Fix @src/cart.js and look at @src/ (see @README.md). Mail me@example.com, not @../secret')).toEqual(['src/cart.js','src/','README.md']);
    expect(mentionedPaths(Array.from({length:12},(_,i)=>`@f${i}.ts`).join(' '))).toHaveLength(8);
  });
  it('attaches contents within limits and notes what it could not read',async()=>{
    const files:Record<string,string>={'a.ts':'one','big.ts':'x'.repeat(40_000)};
    const io={read:async(path:string)=>{if(path in files)return files[path]!;throw new Error('missing');},list:async(path:string)=>{if(path==='src')return ['src/a.ts','src/lib/'];throw new Error('missing');}};
    const text=await attachMentions('look at @a.ts @big.ts @src @gone.ts',io);
    expect(text).toContain('<file path="a.ts">\none\n</file>');
    expect(text).toContain('… (cut; use read_file for the rest)');
    expect(text).toContain('<folder path="src/">\nsrc/a.ts\nsrc/lib/\n</folder>');
    expect(text).toContain('<file path="gone.ts">(unavailable');
    expect(await attachMentions('no mentions here',io)).toBe('');
  });
});

describe('commands',()=>{
  const skills=[{name:'changelog',description:'Write a changelog entry',body:'Read git log and write CHANGELOG.md.'}];
  it('expands agent commands and skills, and leaves the rest alone',()=>{
    expect(expandCommand('/review focus on auth',skills)).toMatchObject({command:'review',text:expect.stringMatching(/Review the changes[\s\S]*The user adds: focus on auth$/u)});
    expect(expandCommand('/changelog for 1.2',skills)).toMatchObject({skill:'changelog',text:expect.stringContaining('Read git log and write CHANGELOG.md.')});
    expect(expandCommand('/unknown thing',skills)).toEqual({text:'/unknown thing'});
    expect(expandCommand('fix /review',skills)).toEqual({text:'fix /review'});
  });
});

describe('compaction',()=>{
  const conversation:ContextMessage[]=[
    {role:'user',content:'Instruction: add tax'},{role:'assistant',content:'Added tax in cart.js.'},
    {role:'user',content:'Instruction: test it'},{role:'assistant',content:'Done.'},
    {role:'user',content:'Instruction: now discounts'},{role:'assistant',content:'Done.'},
    {role:'user',content:'Team discussion: looks good'},
  ];
  it('drops what the summary covers, matching consecutive agent replies',()=>{
    // Covers up to the first "Done.": the pair (tax reply, Done.) only matches there.
    const compaction={summary:'Tax was added and tested.',anchors:anchorsFor(['Added tax in cart.js.','Done.']),at:'now'};
    const result=applyCompaction(conversation,compaction);
    expect(result.dropped).toBe(4);
    expect(result.messages[0]!.content).toContain('Tax was added and tested.');
    expect(result.messages.slice(1)).toEqual(conversation.slice(4));
  });
  it('keeps every message when the covered replies scrolled out of the window',()=>{
    const result=applyCompaction(conversation.slice(4),{summary:'Old.',anchors:anchorsFor(['Added tax in cart.js.','Done.']),at:'now'});
    expect(result.dropped).toBe(0);
    expect(result.messages).toHaveLength(4);
  });
  it('cuts automatically after the last reply that leaves recent messages',()=>{
    expect(autoCompactCut(conversation,2)).toBe(3);
    expect(autoCompactCut(conversation.slice(0,2),4)).toBe(-1);
  });
});

describe('skills',()=>{
  it('parses frontmatter and falls back to the folder name',()=>{
    expect(parseSkill('---\nname: Release Notes\ndescription: "Draft notes"\n---\nSteps here',  'x')).toEqual({name:'release-notes',description:'Draft notes',body:'Steps here'});
    expect(parseSkill('# Title\nDo the thing.','my-skill')).toEqual({name:'my-skill',description:'Do the thing.',body:'# Title\nDo the thing.'});
    expect(parseSkill('---\nname: x\n---\n','x')).toBeNull();
  });
  it('loads project skills first, refuses links and big files, and manages personal skills',async()=>{
    const base=await mkdtemp(join(tmpdir(),'multai-skills-'));cleanup.push(base);
    const project=join(base,'project','.multai','skills');const personal=join(base,'personal');
    await mkdir(join(project,'lint'),{recursive:true});await writeFile(join(project,'lint','SKILL.md'),'---\ndescription: Project lint\n---\nRun eslint.');
    await mkdir(join(project,'huge'),{recursive:true});await writeFile(join(project,'huge','SKILL.md'),'x'.repeat(40_000));
    await mkdir(join(project,'linked'),{recursive:true});await writeFile(join(base,'outside.md'),'secret');await symlink(join(base,'outside.md'),join(project,'linked','SKILL.md'));
    await savePersonalSkill(personal,{name:'lint',description:'Mine',body:'Mine wins?'});
    await savePersonalSkill(personal,{name:'review-pr',description:'Review a PR',body:'Look at the diff.'});
    await expect(savePersonalSkill(personal,{name:'Bad Name!',description:'',body:'x'})).rejects.toMatchObject({code:'INVALID_SKILL'});
    const skills=await loadSkills([{directory:project,source:'project'},{directory:personal,source:'personal'}]);
    expect(skills.map(skill=>[skill.name,skill.source,skill.description])).toEqual([['lint','project','Project lint'],['review-pr','personal','Review a PR']]);
    await deletePersonalSkill(personal,'review-pr');
    expect((await loadSkills([{directory:personal,source:'personal'}])).map(skill=>skill.name)).toEqual(['lint']);
  });
});
