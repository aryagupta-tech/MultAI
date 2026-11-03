// Builds src/timeline.json from src/edit.json, the cut shots' real durations and the narration
// timings, so the composition never guesses a length. Run after voice.mjs and cut.mjs.
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const read = (file) => JSON.parse(readFileSync(path.join(root, file), 'utf8'));
const edit = read('src/edit.json');
const durations = read('public/media/clips/durations.json');
const VOICE_LEAD = 0.45; // narration starts a beat after the cut

let start = 0;
const beats = edit.beats.map((beat) => {
  const voice = read(`public/media/voice/${beat.id}.json`);
  let at = 0;
  const shots = (beat.shots ?? []).map((shot) => {
    const duration = durations[shot.id];
    if (!duration) throw new Error(`No cut for ${shot.id}; run cut.mjs`);
    const placed = { ...shot, start: at, duration };
    at += duration;
    return placed;
  });
  const length = Math.max(beat.length, at, voice.duration + VOICE_LEAD + 0.6);
  // The last shot holds its final frame if the beat runs longer than the footage.
  const placed = { id: beat.id, scene: beat.scene ?? 'shots', start, length, voice: { file: `voice/${beat.id}.wav`, at: VOICE_LEAD, duration: voice.duration, words: voice.words }, shots };
  start += length;
  return placed;
});
writeFileSync(path.join(root, 'src', 'timeline.json'), JSON.stringify({ fps: edit.fps, total: start, beats }, null, 1));
for (const beat of beats) console.log(`${beat.id.padEnd(10)} ${beat.start.toFixed(1).padStart(6)}  +${beat.length.toFixed(1)}`);
console.log(`total ${start.toFixed(1)} s`);
