// The composer's shortcuts: `/` commands, `@` file mentions and `!` terminal commands. Pure, so the
// rules for when the list opens and what a pick inserts can be tested without the DOM.

/** `app` commands act in MultAI and send nothing; `agent` commands are sent and expanded by the host. */
export interface SlashCommand {
  name: string;
  description: string;
  kind: 'app' | 'agent';
  /** Text after the name is kept: `/review focus on auth`. */
  args?: string;
  /** Needs a session in a project worktree. */
  project?: boolean;
  /** Needs an existing session. */
  session?: boolean;
}

export const COMMANDS: readonly SlashCommand[] = [
  { name: 'plan', description: 'Plan mode: the agent reads and plans, no edits', kind: 'app', args: 'task', session: true },
  { name: 'build', description: 'Build mode: the agent can edit files and run commands', kind: 'app', session: true },
  { name: 'review', description: 'Review the current changes for bugs', kind: 'agent', args: 'focus' },
  { name: 'test', description: 'Run the tests and fix failures', kind: 'agent', args: 'which tests' },
  { name: 'explain', description: 'Explain how part of the code works', kind: 'agent', args: 'what' },
  { name: 'init', description: 'Write an AGENTS.md for this project', kind: 'agent' },
  { name: 'split', description: 'Split a task across agents working in parallel', kind: 'agent', args: 'task', project: true },
  { name: 'compact', description: 'Summarize the conversation to free up context', kind: 'app', session: true },
  { name: 'undo', description: 'Undo the files the last run changed', kind: 'app', session: true, project: true },
  { name: 'diff', description: 'Open the changes', kind: 'app', session: true },
  { name: 'terminal', description: 'Open the terminal', kind: 'app', session: true },
  { name: 'pr', description: 'Push the branch and open a pull request', kind: 'app', session: true, project: true },
  { name: 'brief', description: 'Write a catch-up brief for the team', kind: 'app', session: true },
  { name: 'skills', description: 'Manage skills', kind: 'app' },
  { name: 'new', description: 'Start a new chat', kind: 'app' },
  { name: 'help', description: 'Shortcuts and commands', kind: 'app' },
];
export const commandNamed = (name: string) => COMMANDS.find((command) => command.name === name);

/** A token the caret is in: `/rev` at the start of the draft, or `@src/ca` starting a word. */
export interface Trigger { kind: 'slash' | 'mention'; query: string; start: number; end: number }

export function triggerAt(text: string, caret: number): Trigger | null {
  const before = text.slice(0, caret);
  const slash = /^\/([a-z0-9-]*)$/iu.exec(before);
  if (slash) return { kind: 'slash', query: slash[1]!.toLowerCase(), start: 0, end: caret + tokenRest(text, caret) };
  const mention = /(?:^|[\s([{"'`])@([^\s@]*)$/u.exec(before);
  if (mention) {
    const query = mention[1]!;
    return { kind: 'mention', query, start: caret - query.length - 1, end: caret + tokenRest(text, caret) };
  }
  return null;
}
/** The part of the token after the caret, so a pick replaces the whole word. */
function tokenRest(text: string, caret: number): number {
  const rest = /^[^\s]*/u.exec(text.slice(caret));
  return rest ? rest[0].length : 0;
}

/**
 * Replaces the trigger's token with `insert` and returns the new text and caret. A folder (`@src/`)
 * gets no trailing space, so typing continues inside it.
 */
export function replaceTrigger(text: string, trigger: Trigger, insert: string): { text: string; caret: number } {
  const after = text.slice(trigger.end);
  const gap = insert.endsWith('/') || /^\s/u.test(after) ? '' : ' ';
  return { text: text.slice(0, trigger.start) + insert + gap + after, caret: trigger.start + insert.length + gap.length };
}

/** `/plan add tests` → plan, "add tests". Only a whole-draft command counts. */
export function parseSlash(text: string): { name: string; args: string } | null {
  const match = /^\/([a-z0-9][a-z0-9-]{0,47})(?:\s+([\s\S]*))?$/u.exec(text.trim());
  return match ? { name: match[1]!, args: (match[2] ?? '').trim() } : null;
}

/** `!npm test` runs in the host's terminal instead of being sent. */
export function shellCommand(text: string): string | null {
  const match = /^!\s*([\s\S]+)$/u.exec(text.trim());
  return match ? match[1]!.trim() : null;
}

/** Folders implied by a file list, so `@src/` can be picked too. */
export function withFolders(files: readonly string[], limit = 2000): string[] {
  const folders = new Set<string>();
  for (const file of files) {
    const parts = file.split('/');
    for (let index = 1; index < parts.length && folders.size < limit; index++) folders.add(`${parts.slice(0, index).join('/')}/`);
  }
  return [...folders, ...files];
}
