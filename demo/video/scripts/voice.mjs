// Narration for the demo video in the HeyGen voice from script.json.
// The API key is read from ~/.heygen/key and never written anywhere else.
// Writes public/media/voice/<beat>.wav and <beat>.json (duration and word timings).
// Usage: node scripts/voice.mjs [beat-id ...]   (no ids = every beat)
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const out = path.join(root, 'public', 'media', 'voice');
const key = (await readFile(path.join(homedir(), '.heygen', 'key'), 'utf8')).trim();
const script = JSON.parse(await readFile(path.join(root, 'script.json'), 'utf8'));
const only = process.argv.slice(2);
const model = process.env.HEYGEN_MODEL ?? 'heygen-voice-1-turbo-free';

/** Characters with times, grouped into words. */
function words(characters) {
  const list = [];
  let current = null;
  for (const c of characters) {
    if (/\s/u.test(c.text)) { current = null; continue; }
    if (!current) { current = { word: '', start: c.start_time, end: c.end_time }; list.push(current); }
    current.word += c.text;
    current.end = c.end_time;
  }
  return list;
}

async function speak(text) {
  for (let attempt = 1; ; attempt++) {
    const response = await fetch('https://api.heygen.com/v3/models/audio/tts', {
      method: 'POST',
      headers: { 'X-Api-Key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ voice_id: script.voiceId, model, language: 'en', text, with_timestamps: true }),
    });
    if (response.ok) return (await response.json()).data;
    const body = await response.text();
    if (attempt < 4 && [429, 500, 503].includes(response.status)) {
      await new Promise((r) => setTimeout(r, attempt * 5000));
      continue;
    }
    throw new Error(`HeyGen ${response.status}: ${body.slice(0, 300)}`);
  }
}

await mkdir(out, { recursive: true });
let total = 0;
for (const beat of script.beats) {
  if (only.length && !only.includes(beat.id)) continue;
  const data = await speak(beat.text);
  const audio = await fetch(data.audio_url);
  if (!audio.ok) throw new Error(`download ${audio.status} for ${beat.id}`);
  await writeFile(path.join(out, `${beat.id}.wav`), Buffer.from(await audio.arrayBuffer()));
  await writeFile(path.join(out, `${beat.id}.json`), JSON.stringify({ id: beat.id, text: beat.text, duration: data.duration, words: words(data.original_characters ?? []) }, null, 1));
  total += data.duration;
  console.log(`${beat.id}  ${data.duration.toFixed(2)} s`);
}
console.log(`total ${total.toFixed(1)} s`);
