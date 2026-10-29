import {ProviderError, type StreamLimits} from './types.js';

export interface SseEvent {event: string; data: string}

function limit(value: number | undefined, fallback: number, maximum: number): number {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < 1 || selected > maximum) throw new ProviderError('invalid_limits', 'Provider stream limits are invalid.');
  return selected;
}

export function streamLimits(input: StreamLimits = {}) {
  return {
    maxBytes: limit(input.maxBytes, 8_388_608, 16_777_216),
    maxEventBytes: limit(input.maxEventBytes, 262_144, 1_048_576),
    maxEvents: limit(input.maxEvents, 20_000, 50_000),
    maxTextBytes: limit(input.maxTextBytes, 262_144, 1_048_576),
    deadlineMs: limit(input.deadlineMs, 120_000, 300_000),
    idleMs: limit(input.idleMs, 20_000, 60_000),
  };
}

/** Strict UTF-8 SSE framing supports split bytes, CR/LF/CRLF and multiline data. */
export async function* readSse(response: Response, signal: AbortSignal, limits: StreamLimits = {}): AsyncGenerator<SseEvent> {
  const bounds = streamLimits(limits);
  const reader = response.body?.getReader();
  if (!reader) throw new ProviderError('empty_response', 'The provider returned no stream.');
  const decoder = new TextDecoder('utf-8', {fatal: true});
  const started = Date.now();
  let totalBytes = 0;
  let eventBytes = 0;
  let events = 0;
  let line = '';
  let event = '';
  let data: string[] = [];
  let afterCR = false;
  const ready: SseEvent[] = [];
  function finishLine() {
    if (line === '') {
      if (data.length) {
        if (++events > bounds.maxEvents) throw new ProviderError('stream_limit', 'The provider stream exceeded its event limit.');
        ready.push({event: event || 'message', data: data.join('\n')});
      }
      event = '';
      data = [];
      eventBytes = 0;
    } else if (!line.startsWith(':')) {
      const colon = line.indexOf(':');
      const field = colon < 0 ? line : line.slice(0, colon);
      let value = colon < 0 ? '' : line.slice(colon + 1);
      if (value.startsWith(' ')) value = value.slice(1);
      if (field === 'data') {
        eventBytes += Buffer.byteLength(value) + 1;
        if (eventBytes > bounds.maxEventBytes) throw new ProviderError('stream_limit', 'A provider event exceeded its byte limit.');
        data.push(value);
      } else if (field === 'event') event = value;
    }
    line = '';
  }
  function accept(text: string) {
    for (const character of text) {
      if (afterCR) {
        afterCR = false;
        if (character === '\n') continue;
      }
      if (character === '\r') {finishLine(); afterCR = true;}
      else if (character === '\n') finishLine();
      else {
        line += character;
        if (line.length > bounds.maxEventBytes) throw new ProviderError('stream_limit', 'A provider stream line exceeded its byte limit.');
      }
    }
  }
  try {
    while (true) {
      signal.throwIfAborted();
      const remaining = bounds.deadlineMs - (Date.now() - started);
      if (remaining <= 0) throw new ProviderError('provider_timeout', 'The provider request exceeded its deadline.');
      let timer: NodeJS.Timeout | undefined;
      const timeout = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new ProviderError('provider_timeout', 'The provider stream stopped responding.')), Math.min(bounds.idleMs, remaining));
      });
      let onAbort: (() => void) | undefined;
      const aborted = new Promise<never>((_resolve, reject) => {
        onAbort = () => reject(signal.reason ?? new DOMException('Aborted', 'AbortError'));
        signal.addEventListener('abort', onAbort, {once: true});
      });
      const chunk = await Promise.race([reader.read(), timeout, aborted]).finally(() => {
        if (timer) clearTimeout(timer);
        if (onAbort) signal.removeEventListener('abort', onAbort);
      });
      if (chunk.done) {
        accept(decoder.decode());
        // A final SSE frame must have its terminating blank line. A partial
        // terminal frame is not success and is checked by each protocol.
        while (ready.length) {signal.throwIfAborted(); if (Date.now() - started >= bounds.deadlineMs) throw new ProviderError('provider_timeout', 'The provider request exceeded its deadline.'); yield ready.shift()!;}
        break;
      }
      totalBytes += chunk.value.byteLength;
      if (totalBytes > bounds.maxBytes) throw new ProviderError('stream_limit', 'The provider response exceeded its byte limit.');
      accept(decoder.decode(chunk.value, {stream: true}));
      while (ready.length) {signal.throwIfAborted(); if (Date.now() - started >= bounds.deadlineMs) throw new ProviderError('provider_timeout', 'The provider request exceeded its deadline.'); yield ready.shift()!;}
    }
  } catch (error) {
    if (error instanceof TypeError) throw new ProviderError('invalid_stream', 'The provider sent invalid UTF-8.');
    throw error;
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
