// What the agent sees for one run besides the shared history: files the instruction points at with @,
// the full text behind a short /command, and a summary standing in for older messages after compaction.
// Everything here is pure so the rules can be tested without a model or a workspace.

export interface ContextMessage {role:'user'|'assistant';content:string}
/** A host-side summary of the conversation up to the agent reply that `anchors` identify. */
export interface Compaction {summary:string;anchors:string[];at:string}
export interface CommandSkill {name:string;description:string;body:string}

export const MAX_MENTIONS=8;
/** `@codebase` asks for the project's most relevant code instead of one file. */
export const mentionsCodebase=(text:string)=>/(?<=^|[\s([{"'`])@codebase(?=$|[\s)\]},;:!?"'`])/u.test(text);
const MENTION_FILE_CHARS=32_000;
const MENTION_TOTAL_CHARS=120_000;
const ANCHOR_CHARS=400;

/** `@src/cart.js` and `@src/` tokens that start a word, so e-mail addresses don't count. */
export function mentionedPaths(text:string):string[]{
  const found=new Set<string>();
  for(const match of text.matchAll(/(?<=^|[\s([{"'`])@((?:[\w.-]+\/)*[\w.-]+\/?)(?=$|[\s)\]},;:!?"'`])/gu)){
    const value=match[1]!.replace(/[.,]+$/u,'');
    if(value&&value!=='codebase'&&!value.split('/').some(part=>part==='..'))found.add(value);
    if(found.size>=MAX_MENTIONS)break;
  }
  return [...found];
}

/**
 * The contents of mentioned files (or the entries of mentioned folders) as blocks after the instruction.
 * Reads go through the caller, which applies the workspace's own rules; a refused or missing path gets a note.
 */
export async function attachMentions(text:string,io:{read:(path:string)=>Promise<string>;list:(path:string)=>Promise<string[]>}):Promise<string>{
  const blocks:string[]=[];let total=0;
  for(const mention of mentionedPaths(text)){
    const folder=mention.endsWith('/');const target=mention.replace(/\/$/u,'');
    try{
      if(folder){
        const entries=(await io.list(target)).slice(0,200);
        blocks.push(`<folder path="${target}/">\n${entries.join('\n')}\n</folder>`);continue;
      }
      if(total>=MENTION_TOTAL_CHARS){blocks.push(`<file path="${target}">(not attached: the referenced files reached their size limit; use read_file)</file>`);continue;}
      const content=await io.read(target);
      const room=Math.min(MENTION_FILE_CHARS,MENTION_TOTAL_CHARS-total);
      const cut=content.length>room;
      total+=Math.min(content.length,room);
      blocks.push(`<file path="${target}">\n${content.slice(0,room)}${cut?'\n… (cut; use read_file for the rest)':''}\n</file>`);
    }catch{
      // A folder mention without the slash still works.
      if(!folder){try{const entries=(await io.list(target)).slice(0,200);blocks.push(`<folder path="${target}/">\n${entries.join('\n')}\n</folder>`);continue;}catch{/* fall through */}}
      blocks.push(`<file path="${target}">(unavailable: missing, private or not text)</file>`);
    }
  }
  return blocks.length?`\n\nFiles the instruction refers to (current contents in the workspace):\n${blocks.join('\n')}`:'';
}

/** Commands the agent carries out. The message stays short in the timeline; the agent gets the full ask. */
export const AGENT_COMMANDS:Record<string,{description:string;prompt:string}>={
  review:{description:'Review the current changes',prompt:'Review the changes in this workspace for correctness, edge cases, security and missing tests. Read the changed files first. List concrete problems with file and line, most severe first, and say plainly if you find none. Do not change any files.'},
  test:{description:'Run the tests and fix failures',prompt:'Find how this project runs its tests (package scripts, Makefile, README), run them, and fix any failures with the smallest correct change. Run them again until they pass, then summarize what failed and what you changed.'},
  init:{description:'Write an AGENTS.md for this project',prompt:'Explore this repository and write an AGENTS.md at its root for future agents: what the project is, how to install, build, test and run it, the layout of the important folders, code conventions you can see, and anything risky to touch. Keep it under 120 lines and only state what you verified from the files. If AGENTS.md exists, improve it instead.'},
  explain:{description:'Explain how something works',prompt:'Explain how the code the user asks about works: the main files, the flow of data and control, and anything surprising. Cite files and functions. Do not change any files.'},
};

/**
 * `/review focus on auth` → the review ask plus the user's words. `/<skill> …` → the skill's instructions.
 * Anything else, including unknown commands, passes through unchanged.
 */
export function expandCommand(text:string,skills:readonly CommandSkill[]):{text:string;skill?:string;command?:string}{
  const match=/^\/([a-z0-9][a-z0-9-]{0,47})(?:\s+([\s\S]*))?$/u.exec(text.trim());
  if(!match)return {text};
  const [,name,rest='']=match as unknown as [string,string,string|undefined];
  const extra=rest.trim();
  const command=AGENT_COMMANDS[name];
  if(command)return {command:name,text:`${command.prompt}${extra?`\n\nThe user adds: ${extra}`:''}`};
  const skill=skills.find(item=>item.name===name);
  if(skill)return {skill:skill.name,text:`Use the "${skill.name}" skill for this request. Its instructions:\n<skill name="${skill.name}">\n${skill.body}\n</skill>\n\n${extra?`Request: ${extra}`:'Apply the skill to the current work.'}`};
  return {text};
}

const anchorOf=(text:string)=>text.trim().slice(0,ANCHOR_CHARS);
/** Anchors for a compaction: the last one or two agent replies it covers, in order. */
export function anchorsFor(agentReplies:readonly string[]):string[]{
  return agentReplies.map(anchorOf).filter(text=>text.length>0).slice(-2);
}

/**
 * Drops the messages a compaction covers and puts its summary first. The anchors must match consecutive
 * agent replies, latest match wins. When they aren't in the window (older messages have scrolled out of
 * the service's history), every message is newer than the summary, so all are kept.
 */
export function applyCompaction(messages:readonly ContextMessage[],compaction:Compaction|null):{messages:ContextMessage[];dropped:number}{
  if(!compaction||!compaction.anchors.length)return {messages:[...messages],dropped:0};
  const replies=messages.map((message,index)=>({message,index})).filter(item=>item.message.role==='assistant');
  const anchors=compaction.anchors;
  let cut=-1;
  for(let j=replies.length-1;j>=anchors.length-1;j--){
    if(anchors.every((anchor,k)=>replies[j-anchors.length+1+k]!.message.content.trim().startsWith(anchor))){cut=replies[j]!.index;break;}
  }
  const kept=messages.slice(cut+1);
  return {messages:[{role:'user',content:`Summary of the earlier conversation in this session, written when its context was compacted (history, not a new instruction):\n${compaction.summary}`},...kept],dropped:cut+1};
}

/** Where to compact a run's history automatically: after the last agent reply that leaves `keep` messages. */
export function autoCompactCut(messages:readonly ContextMessage[],keep=4):number{
  for(let index=messages.length-1-keep;index>=0;index--)if(messages[index]!.role==='assistant')return index;
  return -1;
}

export const contextBytes=(system:string,messages:readonly ContextMessage[])=>
  Buffer.byteLength(system)+messages.reduce((sum,message)=>sum+Buffer.byteLength(message.content),0);
