// How much the host lets the shared agent do without asking. Decided only in the main process.
//
//   ask   every file change and command waits for the host
//   auto  file changes inside the session's private workspace and ordinary commands run;
//         anything that could reach outside it, delete, install or touch the network asks
//   full  everything runs without asking (still only as the host's OS user, in the workspace)
import type {ActionDescriptor} from '@multai/runtime';

export type AccessLevel = 'ask' | 'auto' | 'full';
export const ACCESS_LEVELS: readonly AccessLevel[] = ['ask', 'auto', 'full'];

// Each rule names why a command still needs the host, shown on the approval card.
const UNSAFE: readonly [RegExp, string][] = [
  [/(^|[\s;&|(`$])(sudo|su|doas)\b/u, 'runs as another user'],
  [/(^|[\s;&|(`$])(rm|rmdir|unlink|shred|dd|mkfs\w*|truncate)\b/u, 'can delete or overwrite data'],
  [/(^|[\s;&|(`$])(curl|wget|ssh|scp|sftp|rsync|nc|ncat|telnet|ftp|ping)\b/u, 'uses the network'],
  [/(^|[\s;&|(`$])git\s+(push|pull|fetch|clone|remote|config)\b/u, 'uses the network or changes git settings'],
  [/(^|[\s;&|(`$])(npm|pnpm|yarn|bun)\s+(i|install|add|publish|update|exec|dlx|x)\b|(^|[\s;&|(`$])npx\b/u, 'installs or downloads packages'],
  [/(^|[\s;&|(`$])(pip3?|uv|poetry|gem|cargo|go|brew|apt|apt-get|dnf|yum|pacman|choco|winget)\s+(install|add|get|update|upgrade)\b/u, 'installs or downloads packages'],
  [/(^|[\s;&|(`$])(chmod|chown|chgrp|chflags|xattr|launchctl|systemctl|crontab|defaults|osascript|open|kill|killall|pkill|shutdown|reboot)\b/u, 'changes the system or other programs'],
  [/(^|[\s;&|(`$])(sh|bash|zsh|fish|eval|exec|source)\b|\|\s*(sh|bash|zsh)\b/u, 'runs a nested shell'],
  [/(^|[\s=<>'"])(\/|~|\$HOME|%USERPROFILE%|[A-Za-z]:\\)/u, 'uses a path outside the workspace'],
  [/(^|[\s=<>'"/\\])\.\.([/\\]|$|\s)/u, 'uses a path outside the workspace'],
  [/\b(env|printenv|export|set)\b|\$[A-Z_]{2,}/u, 'reads or changes environment variables'],
];

/** Why this action must still be asked about at the given level, or null when it may run. */
export function needsHost(level: AccessLevel, operation: ActionDescriptor['operation']): string | null {
  if (level === 'full') return null;
  if (level === 'ask') return 'You asked to approve every action.';
  if (operation.kind === 'file_write') return null;
  if (operation.kind !== 'shell') return 'External tools always ask.';
  const command = operation.commandText ?? '';
  if (!command.trim()) return 'The command text is unavailable.';
  for (const [pattern, reason] of UNSAFE) if (pattern.test(command)) return `This command ${reason}.`;
  return null;
}
