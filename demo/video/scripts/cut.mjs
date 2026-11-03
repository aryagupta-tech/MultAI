// Cuts every shot in src/edit.json out of the raw takes: trimmed, sped up, 30 fps, no audio.
// Browser takes lose the browser's own toolbar (URL, tabs, bookmarks); phone takes are scaled down.
// Usage: node scripts/cut.mjs [shot-id ...]
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const edit = JSON.parse(readFileSync(path.join(root, 'src', 'edit.json'), 'utf8'));
const takes = edit.takes.replace(/^~/, homedir());
const out = path.join(root, 'public', 'media', 'clips');
mkdirSync(out, { recursive: true });
const only = process.argv.slice(2);
const durations = {};

const filters = (kind, speed) => {
  const crop = kind === 'browser' ? 'crop=iw*0.9:ih*0.9:iw*0.1:ih*0.1,' : '';
  const scale = kind === 'phone' ? 'scale=720:-2,' : kind === 'browser' ? 'scale=1920:-2,' : '';
  return `${crop}${scale}setpts=(PTS-STARTPTS)/${speed},fps=${edit.fps}`;
};
const cut = (id, src, from, to, speed, kind) => {
  const file = path.join(out, `${id}.mp4`);
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-ss', String(from), '-to', String(to), '-i', path.join(takes, src),
    '-vf', filters(kind, speed), '-an', '-c:v', 'libx264', '-preset', 'medium', '-crf', '17', '-pix_fmt', 'yuv420p', file]);
  const seconds = Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).toString());
  durations[id] = seconds;
  console.log(`${id.padEnd(16)} ${seconds.toFixed(2)} s`);
};

for (const beat of edit.beats) for (const shot of beat.shots ?? []) {
  if (only.length && !only.includes(shot.id)) continue;
  cut(shot.id, shot.src, shot.in, shot.out, shot.speed, shot.kind);
  if (shot.mac) cut(`${shot.id}-mac`, shot.mac.src, shot.mac.in, shot.mac.out, (shot.mac.out - shot.mac.in) / ((shot.out - shot.in) / shot.speed), 'mac');
}
const index = path.join(out, 'durations.json');
let previous = {};
try { previous = JSON.parse(readFileSync(index, 'utf8')); } catch { /* first run */ }
writeFileSync(index, JSON.stringify({ ...previous, ...durations }, null, 1));
