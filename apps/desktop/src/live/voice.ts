// Voice instructions: record from the microphone as 24 kHz mono PCM16, then the host's Meta or OpenAI
// connection transcribes it (see electron/inference/voice.ts). The text lands in the composer to review.
import { create } from 'zustand';
import { getBridge } from '../bridge/client';
import { useApp } from '../model/store';
import { describe } from './controller';

export const SAMPLE_RATE = 24_000;
export const MAX_SECONDS = 90;

interface VoiceState { starting: string | null; recording: string | null; startedAt: number; busy: string | null }
export const useVoice = create<VoiceState>(() => ({ starting: null, recording: null, startedAt: 0, busy: null }));

let stream: MediaStream | null = null;
let context: AudioContext | null = null;
let chunks: Float32Array[] = [];
let limit: ReturnType<typeof setTimeout> | null = null;
let generation = 0;

/** Float samples in [-1, 1] as little-endian 16-bit PCM, base64. */
export function toPcm16Base64(parts: readonly Float32Array[]): string {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const bytes = new Uint8Array(total * 2);
  const view = new DataView(bytes.buffer);
  let offset = 0;
  for (const part of parts) for (const sample of part) {
    const clamped = Math.max(-1, Math.min(1, sample));
    view.setInt16(offset, clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff, true);
    offset += 2;
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function release(): void {
  if (limit) clearTimeout(limit);
  limit = null;
  stream?.getTracks().forEach((track) => track.stop());
  void context?.close().catch(() => undefined);
  stream = null; context = null;
}

async function start(draftKey: string): Promise<void> {
  const current = ++generation;
  const toast = useApp.getState().toast;
  useVoice.setState({ starting: draftKey });
  try {
    const acquired = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
    if (current !== generation) { acquired.getTracks().forEach((track) => track.stop()); return; }
    stream = acquired;
    context = new AudioContext({ sampleRate: SAMPLE_RATE });
    const source = context.createMediaStreamSource(stream);
    // ScriptProcessor needs no worklet module, which the app's content policy wouldn't load.
    const node = context.createScriptProcessor(4096, 1, 1);
    chunks = [];
    node.onaudioprocess = (event) => { if (current === generation) chunks.push(new Float32Array(event.inputBuffer.getChannelData(0))); };
    source.connect(node);
    node.connect(context.destination);
    useVoice.setState({ starting: null, recording: draftKey, startedAt: Date.now() });
    limit = setTimeout(() => void stop(), MAX_SECONDS * 1000);
  } catch {
    if (current !== generation) return;
    cancelVoice();
    toast('MultAI can’t start the microphone. Check microphone access and your audio device, then try again.', 'error');
  }
}

async function stop(): Promise<void> {
  const draftKey = useVoice.getState().recording;
  if (!draftKey) return;
  const currentGeneration = generation;
  const recorded = chunks; chunks = [];
  release();
  useVoice.setState({ recording: null, busy: draftKey });
  try {
    const result = await getBridge()?.inference.transcribe(toPcm16Base64(recorded));
    if (!result || currentGeneration !== generation) return;
    if (!result.ok) { useApp.getState().toast(describe(result.error), 'error'); return; }
    const app = useApp.getState();
    const current = app.drafts[draftKey]?.text ?? '';
    app.setDraft(draftKey, { text: current.trim() ? `${current.replace(/\s+$/u, '')} ${result.value.text}` : result.value.text });
    document.querySelector<HTMLTextAreaElement>('.composer-input')?.focus();
  } catch {
    if (currentGeneration === generation) useApp.getState().toast('Transcription failed. Please try again.', 'error');
  } finally {
    if (currentGeneration === generation) useVoice.setState({ busy: null });
  }
}

/** Starts recording into this draft, or stops and transcribes. */
export function toggleVoice(draftKey: string): void {
  const { starting, recording, busy } = useVoice.getState();
  if (starting || busy) return;
  if (recording) void stop();
  else void start(draftKey);
}

/** Drops a recording without transcribing it (Escape, or leaving the chat). */
export function cancelVoice(): void {
  generation++;
  chunks = [];
  release();
  useVoice.setState({ starting: null, recording: null, busy: null });
}

// A late permission grant or transcript must never reach a different account's draft.
useApp.subscribe((state, previous) => {
  if (state.account?.id !== previous.account?.id) cancelVoice();
});
