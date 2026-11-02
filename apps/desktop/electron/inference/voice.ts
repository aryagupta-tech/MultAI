// Voice instructions: the composer records 24 kHz mono PCM, and the host's own connection turns it into
// text. A Meta connection uses Muse Voice Transcribe (Meta's realtime transcription), an OpenAI key uses
// OpenAI's transcription endpoint. The audio goes to that provider only and is never stored.
import {randomUUID} from 'node:crypto';
import WebSocket from 'ws';
import type {ConnectionSummary} from '../../src/bridge/inference';

export const SAMPLE_RATE = 24_000;
export const MAX_SECONDS = 90;
export const MAX_PCM_BYTES = SAMPLE_RATE * 2 * MAX_SECONDS;
export const META_TRANSCRIBE_MODEL = 'muse-voice-transcribe-1.0';
export const OPENAI_TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe';

export class VoiceError extends Error {
  constructor(readonly code:string, message:string) {super(message); this.name = 'VoiceError';}
}

/** The selected connection when it can transcribe, otherwise the first Meta, then OpenAI connection. */
export function chooseVoiceConnection(connections:readonly ConnectionSummary[], selectedId:string|null):ConnectionSummary|null {
  const ready = connections.filter(item => item.status === 'ready' && (item.provider === 'meta' || item.provider === 'openai'));
  return ready.find(item => item.id === selectedId) ?? ready.find(item => item.provider === 'meta') ?? ready[0] ?? null;
}

/** A WAV file around 16-bit little-endian mono PCM. */
export function wav(pcm:Buffer, rate = SAMPLE_RATE):Buffer {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(rate, 24); header.writeUInt32LE(rate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

export function checkAudio(pcm:Buffer):void {
  if (pcm.length < SAMPLE_RATE * 2 * 0.3) throw new VoiceError('VOICE_TOO_SHORT', 'That recording was too short. Hold on a little longer.');
  if (pcm.length > MAX_PCM_BYTES) throw new VoiceError('VOICE_TOO_LONG', `Recordings can be up to ${MAX_SECONDS} seconds.`);
  if (pcm.length % 2) throw new VoiceError('VOICE_INVALID', 'The recording was damaged. Try again.');
}

const clean = (text:unknown) => typeof text === 'string' ? text.replace(/\s+/gu, ' ').trim().slice(0, 8000) : '';

/** A multipart/form-data body as bytes, for transports that send a fixed byte body. */
export function multipart(fields:Record<string, string>, file:{name:string; filename:string; type:string; data:Buffer}):{body:Uint8Array<ArrayBuffer>; contentType:string} {
  const boundary = `multai-${randomUUID()}`;
  const parts:Buffer[] = [];
  for (const [name, value] of Object.entries(fields)) parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
  parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${file.name}"; filename="${file.filename}"\r\nContent-Type: ${file.type}\r\n\r\n`), file.data, Buffer.from(`\r\n--${boundary}--\r\n`));
  return {body: new Uint8Array(Buffer.concat(parts)), contentType: `multipart/form-data; boundary=${boundary}`};
}

/** OpenAI: one multipart request with the recording as a WAV file. */
export async function transcribeOpenAI(credentials:{apiKey:string; baseUrl?:string}, pcm:Buffer, fetcher:typeof fetch, signal:AbortSignal):Promise<string> {
  checkAudio(pcm);
  const {body, contentType} = multipart({model: OPENAI_TRANSCRIBE_MODEL, response_format: 'json'}, {name: 'file', filename: 'voice.wav', type: 'audio/wav', data: wav(pcm)});
  const base = (credentials.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/u, '');
  const response = await fetcher(`${base}/audio/transcriptions`, {method: 'POST', headers: {authorization: `Bearer ${credentials.apiKey}`, 'content-type': contentType}, body, signal, redirect: 'error'});
  if (response.status === 401) throw new VoiceError('provider_credentials_invalid', 'This OpenAI key was refused. Check it in Settings.');
  if (!response.ok) throw new VoiceError('VOICE_FAILED', `OpenAI couldn’t transcribe that (HTTP ${response.status}).`);
  const text = clean(((await response.json().catch(() => null)) as {text?:unknown} | null)?.text);
  if (!text) throw new VoiceError('VOICE_EMPTY', 'No speech was heard. Try again a little closer to the microphone.');
  return text;
}

export type SocketFactory = (url:string, headers:Record<string, string>) => WebSocket;
const defaultSocket:SocketFactory = (url, headers) => new WebSocket(url, {headers, handshakeTimeout: 10_000, maxPayload: 1024 * 1024});

/**
 * Meta: Muse Voice Transcribe is realtime only, so the recording is streamed over Meta's realtime
 * WebSocket in chunks, committed, and the finished transcript is read back.
 */
export function transcribeMeta(credentials:{apiKey:string}, pcm:Buffer, signal:AbortSignal, socketFactory:SocketFactory = defaultSocket, timeoutMs = 45_000):Promise<string> {
  checkAudio(pcm);
  return new Promise((resolve, reject) => {
    const url = `wss://api.meta.ai/v1/realtime?model=${encodeURIComponent(META_TRANSCRIBE_MODEL)}&intent=transcription`;
    const socket = socketFactory(url, {authorization: `Bearer ${credentials.apiKey}`, 'openai-beta': 'realtime=v1'});
    let partial = '';
    let settled = false;
    const finish = (error:Error | null, text = '') => {
      if (settled) return; settled = true;
      clearTimeout(timer); signal.removeEventListener('abort', abort);
      try {socket.close();} catch {/* already closed */}
      if (error) reject(error); else resolve(text);
    };
    const abort = () => finish(new VoiceError('VOICE_CANCELED', 'Transcription was canceled.'));
    const timer = setTimeout(() => finish(partial ? null : new VoiceError('VOICE_TIMEOUT', 'Muse Voice Transcribe didn’t answer in time. Try again.'), partial), timeoutMs);
    signal.addEventListener('abort', abort, {once: true});
    socket.on('open', () => {
      socket.send(JSON.stringify({type: 'transcription_session.update', session: {input_audio_format: 'pcm16', input_audio_transcription: {model: META_TRANSCRIBE_MODEL}, turn_detection: null}}));
      for (let offset = 0; offset < pcm.length; offset += 48_000) socket.send(JSON.stringify({type: 'input_audio_buffer.append', audio: pcm.subarray(offset, offset + 48_000).toString('base64')}));
      socket.send(JSON.stringify({type: 'input_audio_buffer.commit'}));
    });
    socket.on('message', data => {
      let event:{type?:string; delta?:unknown; transcript?:unknown; error?:{message?:unknown}};
      try {event = JSON.parse(String(data));} catch {return;}
      if (event.type === 'conversation.item.input_audio_transcription.delta' && typeof event.delta === 'string') partial += event.delta;
      else if (event.type === 'conversation.item.input_audio_transcription.completed') {
        const text = clean(event.transcript) || clean(partial);
        finish(text ? null : new VoiceError('VOICE_EMPTY', 'No speech was heard. Try again a little closer to the microphone.'), text);
      } else if (event.type === 'error' || event.type === 'conversation.item.input_audio_transcription.failed') {
        finish(new VoiceError('VOICE_FAILED', 'Muse Voice Transcribe couldn’t transcribe that. Try again.'));
      }
    });
    socket.on('unexpected-response', (_request, response) => finish(new VoiceError(response.statusCode === 401 ? 'provider_credentials_invalid' : 'VOICE_FAILED', response.statusCode === 401 ? 'This Meta key was refused. Check it in Settings.' : `Meta’s realtime transcription refused the connection (HTTP ${response.statusCode ?? '?'}).`)));
    socket.on('error', () => finish(new VoiceError('VOICE_FAILED', 'Couldn’t reach Muse Voice Transcribe. Check your connection.')));
    socket.on('close', () => finish(partial ? null : new VoiceError('VOICE_FAILED', 'Muse Voice Transcribe closed the connection before answering.'), clean(partial)));
  });
}
