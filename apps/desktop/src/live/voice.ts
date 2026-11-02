// Voice instructions: record from the microphone as 24 kHz mono PCM16, then the host's Meta or OpenAI
// connection transcribes it (see electron/inference/voice.ts). The text lands in the composer to review.
import { create } from 'zustand';
import { getBridge } from '../bridge/client';
import { useApp } from '../model/store';
import { describe } from './controller';

export const SAMPLE_RATE = 24_000;
export const MAX_SECONDS = 90;

interface VoiceState { recording: string | null; startedAt: number; busy: string | null }
export const useVoice = create<VoiceState>(() => ({ recording: null, startedAt: 0, busy: null }));

let stream: MediaStream | null = null;
let context: AudioContext | null = null;
let chunks: Float32Array[] = [];
let limit: ReturnType<typeof setTimeout> | null = null;

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
  const toast = useApp.getState().toast;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true } });
  } catch {
    toast('MultAI can’t use the microphone. Allow it in System Settings → Privacy & Security → Microphone, then try again.', 'error');
    return;
  }
  context = new AudioContext({ sampleRate: SAMPLE_RATE });
  const source = context.createMediaStreamSource(stream);
  // ScriptProcessor needs no worklet module, which the app's content policy wouldn't load.
  const node = context.createScriptProcessor(4096, 1, 1);
  chunks = [];
  node.onaudioprocess = (event) => { chunks.push(new Float32Array(event.inputBuffer.getChannelData(0))); };
  source.connect(node);
  node.connect(context.destination);
  useVoice.setState({ recording: draftKey, startedAt: Date.now() });
  limit = setTimeout(() => void stop(), MAX_SECONDS * 1000);
}

async function stop(): Promise<void> {
  const draftKey = useVoice.getState().recording;
  if (!draftKey) return;
  const recorded = chunks; chunks = [];
  release();
  useVoice.setState({ recording: null, busy: draftKey });
  try {
    const result = await getBridge()?.inference.transcribe(toPcm16Base64(recorded));
    if (!result) return;
    if (!result.ok) { useApp.getState().toast(describe(result.error), 'error'); return; }
    const app = useApp.getState();
    const current = app.drafts[draftKey]?.text ?? '';
    app.setDraft(draftKey, { text: current.trim() ? `${current.replace(/\s+$/u, '')} ${result.value.text}` : result.value.text });
    document.querySelector<HTMLTextAreaElement>('.composer-input')?.focus();
  } finally {
    useVoice.setState({ busy: null });
  }
}

/** Starts recording into this draft, or stops and transcribes. */
export function toggleVoice(draftKey: string): void {
  const { recording, busy } = useVoice.getState();
  if (busy) return;
  if (recording) void stop();
  else void start(draftKey);
}

/** Drops a recording without transcribing it (Escape, or leaving the chat). */
export function cancelVoice(): void {
  if (!useVoice.getState().recording) return;
  chunks = [];
  release();
  useVoice.setState({ recording: null });
}
