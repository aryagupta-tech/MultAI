// Parallel agents: one task split into parts that separate agents build at the same time, each in its own
// git worktree branched from the chat's current work, then merged back into the chat's worktree.
// Everything here is plain git and text; the coordinator runs the agents and their approvals.
import {randomUUID} from 'node:crypto';
import {mkdir,rm,unlink} from 'node:fs/promises';
import path from 'node:path';
import {z} from 'zod';
import {git,safeRelative,snapshotTree} from './projects';

export const MIN_PARTS = 2;
export const MAX_PARTS = 4;

export interface SplitPart {title:string; task:string; files:string[]}
export interface Lane extends SplitPart {index:number; root:string}

/** `/split <task>` asks for parallel agents. Returns the task, or null for an ordinary instruction. */
export function splitTask(text:string):string|null {
  const match = /^\/split(?:\s+([\s\S]*))?$/u.exec(text.trim());
  if (!match) return null;
  return (match[1] ?? '').trim();
}

export const PLAN_SYSTEM = `You plan work for several coding agents that will work at the same time, each in its own copy of the repository. Split the task into ${MIN_PARTS} to ${MAX_PARTS} parts that can be built independently and then merged.
Rules:
- Each part names the files it will create or change. Two parts never change the same file, so their work merges cleanly.
- Each part's task is a complete instruction an agent can follow without seeing the others: what to build, where, and how to check it.
- Put shared groundwork (a new module several parts use) in one part, and tell the others its exact names so they can rely on it.
- If the task can't be split without parts editing the same files, return a single part.
Reply with JSON only, no prose: {"parts":[{"title":"3-6 word label","task":"full instruction","files":["relative/path"]}]}`;

const planSchema = z.object({parts: z.array(z.object({
  title: z.string().trim().min(1).max(80),
  task: z.string().trim().min(1).max(6000),
  files: z.array(z.string().trim().min(1).max(512)).max(40).default([]),
})).min(1).max(MAX_PARTS)});

/** The model's plan, from the first JSON object in its reply. Overlapping files are refused. */
export function parsePlan(text:string):SplitPart[] {
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new SplitError('PLAN_INVALID', 'The model didn’t return a plan. Try again, or describe the parts yourself.');
  let raw:unknown;
  try {raw = JSON.parse(text.slice(start, end + 1));} catch {throw new SplitError('PLAN_INVALID', 'The model’s plan wasn’t valid JSON. Try again.');}
  const parsed = planSchema.safeParse(raw);
  if (!parsed.success) throw new SplitError('PLAN_INVALID', 'The model’s plan was incomplete. Try again.');
  const owner = new Map<string, number>();
  const parts = parsed.data.parts.map((part, index) => {
    const files = [...new Set(part.files.map(file => file.replace(/^\.\//u, '')))].filter(file => {
      try {safeRelative(file); return true;} catch {return false;}
    });
    for (const file of files) {
      const other = owner.get(file);
      if (other !== undefined && other !== index) throw new SplitError('PLAN_OVERLAP', `Two parts of the plan change ${file}. Try again, or split the task yourself.`);
      owner.set(file, index);
    }
    return {title: part.title, task: part.task, files};
  });
  return parts;
}

export class SplitError extends Error {
  constructor(readonly code:string, message:string) {super(message); this.name = 'SplitError';}
}

const author = ['-c', 'user.name=MultAI', '-c', 'user.email=multai@localhost'];
const commitTree = async (root:string, tree:string, parents:string[], message:string) =>
  (await git(root, [...author, 'commit-tree', tree, ...parents.flatMap(parent => ['-p', parent]), '-m', message])).stdout.trim();

/** The chat's worktree as it is right now, as a commit on top of `parent`. */
export async function captureWork(root:string, parent:string, message:string):Promise<string> {
  return commitTree(root, await snapshotTree(root), [parent], message);
}

/** A detached worktree at `base` for each part, next to the chat's own. */
export async function createLanes(root:string, base:string, parts:SplitPart[]):Promise<Lane[]> {
  const lanes:Lane[] = [];
  try {
    for (const [index, part] of parts.entries()) {
      const laneRoot = `${root}.lane-${index + 1}-${randomUUID().slice(0, 8)}`;
      await mkdir(path.dirname(laneRoot), {recursive: true});
      await git(root, ['worktree', 'add', '--detach', '--quiet', laneRoot, base]);
      lanes.push({...part, index: index + 1, root: laneRoot});
    }
    return lanes;
  } catch (error) {
    await removeLanes(root, lanes);
    throw error;
  }
}

export async function removeLanes(root:string, lanes:readonly Lane[]):Promise<void> {
  for (const lane of lanes) {
    await git(root, ['worktree', 'remove', '--force', lane.root], {allowFail: true});
    await rm(lane.root, {recursive: true, force: true}).catch(() => undefined);
  }
  await git(root, ['worktree', 'prune'], {allowFail: true});
}

export interface LaneResult {lane:Lane; commit:string; files:string[]}

/** What a lane changed since `base`, as a commit (or null when it changed nothing). */
export async function laneResult(lane:Lane, base:string):Promise<LaneResult|null> {
  const tree = await snapshotTree(lane.root);
  if (tree === (await git(lane.root, ['rev-parse', `${base}^{tree}`])).stdout.trim()) return null;
  const commit = await commitTree(lane.root, tree, [base], `MultAI agent ${lane.index}: ${lane.title}`);
  const files = (await git(lane.root, ['-c', 'core.quotePath=false', 'diff', '--name-only', '-z', base, commit])).stdout.split('\0').filter(Boolean);
  return {lane, commit, files};
}

export interface MergeOutcome {
  /** The merged work, or the chat's own work when nothing merged. */
  commit:string;
  merged:LaneResult[];
  conflicts:{result:LaneResult; files:string[]}[];
}

/**
 * Merges each lane into `current` (the chat's work now), oldest lane first. A lane that conflicts with
 * what is already merged is left out and reported with its conflicting files.
 */
export async function mergeLanes(root:string, base:string, current:string, results:readonly LaneResult[]):Promise<MergeOutcome> {
  let commit = current;
  const merged:LaneResult[] = [], conflicts:MergeOutcome['conflicts'] = [];
  for (const result of results) {
    const out = await git(root, ['-c', 'core.quotePath=false', 'merge-tree', '--write-tree', '--name-only', '-z', `--merge-base=${base}`, commit, result.commit], {allowFail: true});
    const [tree, ...rest] = out.stdout.split('\0');
    if (out.code === 0 && tree) {
      commit = await commitTree(root, tree.trim(), [commit, result.commit], `MultAI: merge agent ${result.lane.index} (${result.lane.title})`);
      merged.push(result);
    } else if (out.code === 1 && tree) {
      // With -z, conflicted file names follow the tree, then an empty entry and the messages.
      const files = rest.slice(0, Math.max(0, rest.indexOf(''))).filter(Boolean);
      conflicts.push({result, files: [...new Set(files)]});
    } else {
      throw new SplitError('MERGE_FAILED', 'Git couldn’t merge the agents’ work. MultAI needs Git 2.38 or newer.');
    }
  }
  return {commit, merged, conflicts};
}

/** Puts the files of `to` into the worktree where they differ from `from`, without touching its index. */
export async function applyCommit(root:string, from:string, to:string):Promise<string[]> {
  const changes = (await git(root, ['-c', 'core.quotePath=false', 'diff', '--name-status', '--no-renames', '-z', from, to])).stdout.split('\0').filter(Boolean);
  const deleted:string[] = [], written:string[] = [];
  for (let i = 0; i + 1 < changes.length; i += 2) {
    const file = safeRelative(changes[i + 1]!);
    (changes[i] === 'D' ? deleted : written).push(file);
  }
  for (const file of deleted) await rm(path.join(root, file), {force: true});
  if (written.length) {
    const index = `${root}.apply-${randomUUID()}.index`;
    const env = {GIT_INDEX_FILE: index};
    try {
      await git(root, ['read-tree', to], {env});
      await git(root, ['checkout-index', '--force', '--', ...written], {env});
    } finally {await unlink(index).catch(() => undefined);}
  }
  return [...written, ...deleted];
}

/** Steering for parallel agents: "agent 2: …" goes to that agent, anything else to all of them. */
export function routeDirection(text:string, lanes:number):{lane:number|null; text:string} {
  const match = /^\s*@?(?:agent|lane)\s*#?(\d)\s*[:,-]?\s*/iu.exec(text);
  const lane = match ? Number(match[1]) : NaN;
  if (match && lane >= 1 && lane <= lanes) return {lane, text: text.slice(match[0].length).trim() || text};
  return {lane: null, text};
}
