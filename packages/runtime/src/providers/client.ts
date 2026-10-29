import {canonicalJson, type JsonValue} from '../policy.js';
import {readSse, streamLimits} from './sse.js';
import {ProviderError} from './types.js';
import type {AgentEvent, Completion, ConversationState, ModelInfo, ProviderCredentials, ProviderDependencies, ToolCall, ToolDefinition, Usage} from './types.js';

const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProviderError('invalid_response', 'The provider sent an invalid response.');
  return value as Record<string, unknown>;
};
const array = (value: unknown): unknown[] => {
  if (!Array.isArray(value)) throw new ProviderError('invalid_response', 'The provider sent an invalid response.');
  return value;
};
const boundedId = (value: unknown): string => {
  if (typeof value !== 'string' || value.length < 1 || value.length > 512 || /[\u0000-\u001f]/u.test(value)) throw new ProviderError('invalid_response', 'The provider returned an invalid identifier.');
  return value;
};
const number = (value: unknown) => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;

export function providerBase(credentials: ProviderCredentials): URL {
  if (!credentials.apiKey || credentials.apiKey.length > 16_384 || /[\r\n\0]/u.test(credentials.apiKey)) throw new ProviderError('invalid_credentials', 'Connect an inference account or API key first.');
  const expected = credentials.kind === 'anthropic' ? 'https://api.anthropic.com/v1' : 'https://api.openai.com/v1';
  const selected = credentials.baseUrl ?? expected;
  let url: URL;
  try {url = new URL(selected);} catch {throw new ProviderError('invalid_endpoint', 'Provider endpoint must be an HTTPS API base URL.');}
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || !url.hostname || /(?:^|\.)localhost$/iu.test(url.hostname)) throw new ProviderError('invalid_endpoint', 'Provider endpoint must be an HTTPS API base URL.');
  if (credentials.kind !== 'compatible' && selected.replace(/\/$/u, '') !== expected) throw new ProviderError('invalid_endpoint', 'This provider uses its fixed official API endpoint.');
  url.pathname = `${url.pathname.replace(/\/$/u, '')}/`;
  return url;
}

function headers(credentials: ProviderCredentials): Record<string, string> {
  return credentials.kind === 'anthropic'
    ? {'content-type': 'application/json', 'x-api-key': credentials.apiKey, 'anthropic-version': '2023-06-01'}
    : {'content-type': 'application/json', authorization: `Bearer ${credentials.apiKey}`};
}

async function boundedJson(response: Response, maximum = 1_048_576): Promise<unknown> {
  const reader = response.body?.getReader();
  if (!reader) throw new ProviderError('invalid_response', 'The provider returned no response.');
  let bytes = 0;
  const chunks: Uint8Array[] = [];
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximum) throw new ProviderError('response_limit', 'The provider response exceeded its byte limit.');
      chunks.push(chunk.value);
    }
    try {return JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(Buffer.concat(chunks)));}
    catch {throw new ProviderError('invalid_response', 'The provider response was not valid JSON.');}
  } finally {await reader.cancel().catch(() => undefined); reader.releaseLock();}
}

const knownProviderCodes = new Set(['subscription_sharing_usage_limit_exceeded', 'subscription_sharing_usage_unavailable', 'rate_limit_exceeded', 'insufficient_quota', 'server_error']);

/** Only documented, app-handled error codes may cross this boundary. */
function knownErrorCode(input: unknown): string | undefined {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return undefined;
  const value = input as Record<string, unknown>;
  if (typeof value.code === 'string' && knownProviderCodes.has(value.code)) return value.code;
  for (const key of ['error', 'response'] as const) {
    const child = value[key];
    if (!child || typeof child !== 'object' || Array.isArray(child)) continue;
    const nested = child as Record<string, unknown>;
    if (typeof nested.code === 'string' && knownProviderCodes.has(nested.code)) return nested.code;
    if (key === 'response' && nested.error && typeof nested.error === 'object' && !Array.isArray(nested.error)) {
      const code = (nested.error as Record<string, unknown>).code;
      if (typeof code === 'string' && knownProviderCodes.has(code)) return code;
    }
  }
  return undefined;
}

function safeFailureMessage(code: string | undefined, fallback: string): string {
  if (code === 'subscription_sharing_usage_limit_exceeded') return 'The connected ChatGPT account reached its plan usage limit. Manage usage or choose another connection.';
  if (code === 'subscription_sharing_usage_unavailable') return 'ChatGPT plan usage is temporarily unavailable. Try again later or choose another connection.';
  return fallback;
}

function responseError(response: Response, knownCode?: string): ProviderError {
  const code = response.status === 401 ? 'provider_credentials_invalid' : response.status === 403 ? 'provider_access_denied' : response.status === 429 ? 'provider_rate_limited' : 'provider_request_failed';
  const message = response.status === 401 ? 'This inference connection needs fresh credentials.' : response.status === 429 ? 'The provider rejected this request because of a rate or usage limit.' : 'The inference provider could not complete this request.';
  return new ProviderError(knownCode ?? code, safeFailureMessage(knownCode, message), response.status);
}

async function send(credentials: ProviderCredentials, path: string, body: unknown | undefined, deps: ProviderDependencies): Promise<Response> {
  deps.signal.throwIfAborted();
  const deadline = AbortSignal.timeout(streamLimits(deps.limits).deadlineMs);
  const signal = AbortSignal.any([deps.signal, deadline]);
  const serialized = body === undefined ? undefined : JSON.stringify(body);
  if (serialized && Buffer.byteLength(serialized) > 1_048_576) throw new ProviderError('input_limit', 'Inference context exceeded its byte limit.');
  const endpoint = new URL(path, providerBase(credentials));
  const requestHeaders = headers(credentials);
  let response: Response;
  try {
    response = await (deps.fetch ?? globalThis.fetch)(endpoint, {
      method: serialized === undefined ? 'GET' : 'POST', headers: requestHeaders, signal, redirect: 'error',
      ...(serialized === undefined ? {} : {body: serialized}),
    });
  } catch {
    deps.signal.throwIfAborted();
    if (deadline.aborted) throw new ProviderError('provider_timeout', 'The inference provider exceeded its deadline.');
    throw new ProviderError('provider_unavailable', 'The inference provider is unreachable. No request was retried.');
  }
  if (!response.ok) {
    let knownCode: string | undefined;
    try {knownCode = knownErrorCode(await boundedJson(response, 16_384));} catch { /* Unknown, oversized or malformed bodies are never exposed. */ }
    await response.body?.cancel().catch(() => undefined);
    throw responseError(response, knownCode);
  }
  return response;
}

/** Uses only the connected account's live catalog; no invented names or capacities. */
export async function discoverModels(credentials: ProviderCredentials, deps: ProviderDependencies): Promise<ModelInfo[]> {
  const result: ModelInfo[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < (credentials.kind === 'anthropic' ? 10 : 1); page++) {
    const path = credentials.kind === 'anthropic' ? `models?limit=100${cursor ? `&after_id=${encodeURIComponent(cursor)}` : ''}` : 'models';
    const response = await send(credentials, path, undefined, deps);
    const body = record(await boundedJson(response));
    const rows = array(credentials.kind === 'chatgpt' ? body.models : body.data);
    if (rows.length > 1000) throw new ProviderError('model_catalog_limit', 'The provider model catalog exceeded its limit.');
    for (const raw of rows) {
      const row = record(raw);
      if (credentials.kind === 'chatgpt' && row.visibility !== 'list') continue;
      const id = boundedId(credentials.kind === 'chatgpt' ? row.slug : row.id);
      const name = typeof row.display_name === 'string' && row.display_name.length <= 512 ? row.display_name : id;
      if (!result.some(model => model.id === id)) result.push({id, name});
    }
    if (credentials.kind !== 'anthropic' || body.has_more !== true) return result;
    cursor = boundedId(body.last_id);
  }
  throw new ProviderError('model_catalog_limit', 'The provider model catalog exceeded its page limit.');
}

function parseCall(id: unknown, name: unknown, argumentsText: unknown, namespace?: unknown): ToolCall {
  let selectedName = boundedId(name);
  if (namespace !== undefined && namespace !== 'multai') throw new ProviderError('unsupported_tool', 'The provider requested an unknown tool namespace.');
  if (selectedName.startsWith('multai.')) selectedName = selectedName.slice('multai.'.length);
  let args: unknown;
  if (typeof argumentsText === 'string') {
    if (Buffer.byteLength(argumentsText) > 65_536) throw new ProviderError('tool_limit', 'Tool arguments exceeded their byte limit.');
    try {args = JSON.parse(argumentsText);} catch {throw new ProviderError('invalid_tool_arguments', 'The provider returned incomplete or invalid tool arguments.');}
  } else args = argumentsText;
  canonicalJson(args);
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new ProviderError('invalid_tool_arguments', 'Tool arguments must be an object.');
  return {id: boundedId(id), name: selectedName, arguments: args as JsonValue};
}

function usageFrom(input: unknown, protocol: ConversationState['protocol']): Usage | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const value = input as Record<string, unknown>;
  const inputTokens = number(protocol === 'chat' ? value.prompt_tokens : value.input_tokens);
  const outputTokens = number(protocol === 'chat' ? value.completion_tokens : value.output_tokens);
  const totalTokens = number(value.total_tokens) ?? (inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined);
  if (inputTokens === undefined && outputTokens === undefined && totalTokens === undefined) return undefined;
  return {...(inputTokens === undefined ? {} : {inputTokens}), ...(outputTokens === undefined ? {} : {outputTokens}), ...(totalTokens === undefined ? {} : {totalTokens})};
}

interface CompleteInput extends ProviderDependencies {
  credentials: ProviderCredentials;
  model: string;
  system: string;
  state: ConversationState;
  tools: ToolDefinition[];
  maxOutputTokens: number;
  onEvent: (event: AgentEvent) => void | Promise<void>;
}

/** One provider turn. It never dispatches a tool; calls are returned only after a terminal success. */
export async function complete(input: CompleteInput): Promise<Completion> {
  const {credentials, model, system, state, tools, maxOutputTokens} = input;
  let body: Record<string, unknown>;
  const functions = tools.map(tool => ({type: 'function', name: tool.name, description: tool.description, parameters: tool.parameters, strict: false}));
  let path: string;
  if (state.protocol === 'responses') {
    path = 'responses';
    body = {model, input: state.items, store: false, stream: true, instructions: system, include: ['reasoning.encrypted_content']};
    if (credentials.kind !== 'chatgpt') body.max_output_tokens = maxOutputTokens;
    if (functions.length) body.tools = credentials.kind === 'chatgpt' ? [{type: 'namespace', name: 'multai', description: 'App-controlled workspace tools. Every effect requires host authority.', tools: functions}] : functions;
  } else if (state.protocol === 'anthropic') {
    path = 'messages';
    body = {model, messages: state.items, system, stream: true, max_tokens: maxOutputTokens};
    if (tools.length) body.tools = tools.map(tool => ({name: tool.name, description: tool.description, input_schema: tool.parameters}));
  } else {
    path = 'chat/completions';
    body = {model, messages: [{role: 'system', content: system}, ...state.items], stream: true, max_tokens: maxOutputTokens, stream_options: {include_usage: true}};
    if (functions.length) body.tools = functions.map(({type, ...fn}) => ({type, function: fn}));
  }
  const response = await send(credentials, path, body, input);
  const mime = response.headers.get('content-type')?.split(';')[0]?.trim();
  if (mime !== 'text/event-stream') {await response.body?.cancel().catch(() => undefined); throw new ProviderError('invalid_stream', 'The provider did not return an event stream.');}
  const bounds = streamLimits(input.limits);
  let text = '';
  let textBytes = 0;
  let output: Record<string, unknown>[] = [];
  let calls: ToolCall[] = [];
  let usage: Usage | undefined;
  let terminal = false;
  const claudeBlocks = new Map<number, Record<string, unknown>>();
  const claudeClosed = new Set<number>();
  let claudeStarted = false;
  const argumentParts = new Map<number, string>();
  const chatCalls = new Map<number, {id: string; name: string; arguments: string}>();
  let claudeInputTokens: number | undefined;
  let chatReasoning = '';
  let finishReason: string | null = null;
  const emitText = async (delta: unknown) => {
    if (typeof delta !== 'string') throw new ProviderError('invalid_stream', 'The provider sent an invalid text delta.');
    textBytes += Buffer.byteLength(delta);
    if (textBytes > bounds.maxTextBytes) throw new ProviderError('output_limit', 'The provider output exceeded its text limit.');
    text += delta;
    if (delta) await input.onEvent({type: 'text.delta', text: delta});
  };
  for await (const frame of readSse(response, input.signal, input.limits)) {
    input.signal.throwIfAborted();
    if (frame.data === '[DONE]') {
      if (state.protocol !== 'chat' || !finishReason) throw new ProviderError('incomplete_stream', 'The provider stream ended without a completed response.');
      terminal = true;
      break;
    }
    let raw: unknown;
    try {raw = JSON.parse(frame.data);} catch {throw new ProviderError('invalid_stream', 'The provider stream contained invalid JSON.');}
    const event = record(raw);
    if (event.error || event.type === 'error') {
      const code = knownErrorCode(event);
      throw new ProviderError(code ?? 'provider_stream_failed', safeFailureMessage(code, 'The provider reported an error during inference.'));
    }
    if (state.protocol === 'responses') {
      if (event.type === 'response.output_text.delta') await emitText(event.delta);
      else if (event.type === 'response.failed' || event.type === 'response.incomplete') {
        const code = knownErrorCode(event);
        throw new ProviderError(code ?? 'provider_incomplete', safeFailureMessage(code, 'The inference provider did not complete this response.'));
      } else if (event.type === 'response.completed') {
        const completed = record(event.response);
        if (completed.status !== undefined && completed.status !== 'completed') throw new ProviderError('provider_incomplete', 'The inference provider did not complete this response.');
        output = array(completed.output).map(record);
        calls = output.filter(item => item.type === 'function_call').map(item => parseCall(item.call_id, item.name, item.arguments, item.namespace));
        if (output.some(item => item.type !== 'message' && item.type !== 'function_call' && item.type !== 'reasoning')) throw new ProviderError('unsupported_tool', 'The provider returned an unsupported hosted tool or output type.');
        usage = usageFrom(completed.usage, 'responses');
        if (!text) {
          const terminalText = output.filter(item => item.type === 'message').flatMap(item => array(item.content)).map(record).filter(part => part.type === 'output_text').map(part => typeof part.text === 'string' ? part.text : '').join('');
          if (terminalText) await emitText(terminalText);
        }
        terminal = true;
        break;
      }
    } else if (state.protocol === 'anthropic') {
      if (event.type === 'message_start') {
        if (claudeStarted) throw new ProviderError('invalid_stream', 'The provider started this message more than once.');
        claudeStarted = true;
        claudeInputTokens = number(record(record(event.message).usage).input_tokens);
      }
      else if (event.type === 'content_block_start') {
        const index = number(event.index);
        if (!claudeStarted || index === undefined || claudeBlocks.has(index) || claudeBlocks.size >= 64) throw new ProviderError('invalid_stream', 'The provider sent an invalid content block.');
        const block = record(event.content_block);
        if (!['text', 'tool_use', 'thinking', 'redacted_thinking'].includes(String(block.type))) throw new ProviderError('unsupported_tool', 'The provider returned an unsupported content type.');
        claudeBlocks.set(index, {...block});
      } else if (event.type === 'content_block_delta') {
        const index = number(event.index);
        const block = index === undefined ? undefined : claudeBlocks.get(index);
        if (!block || claudeClosed.has(index!)) throw new ProviderError('invalid_stream', 'The provider streamed a missing or completed content block.');
        const delta = record(event.delta);
        if (delta.type === 'text_delta') {
          if (block.type !== 'text') throw new ProviderError('invalid_stream', 'The provider streamed text into another content type.');
          await emitText(delta.text); block.text = String(block.text ?? '') + String(delta.text);
        }
        else if (delta.type === 'input_json_delta') {
          if (block.type !== 'tool_use') throw new ProviderError('invalid_stream', 'The provider streamed tool arguments into another content type.');
          const part = typeof delta.partial_json === 'string' ? delta.partial_json : '';
          const previous = argumentParts.get(index!) ?? '';
          if (Buffer.byteLength(previous) + Buffer.byteLength(part) > 65_536) throw new ProviderError('tool_limit', 'Tool arguments exceeded their byte limit.');
          argumentParts.set(index!, previous + part);
        } else if (delta.type === 'thinking_delta') {
          if (block.type !== 'thinking' || typeof delta.thinking !== 'string') throw new ProviderError('invalid_stream', 'The provider sent invalid reasoning state.');
          block.thinking = String(block.thinking ?? '') + delta.thinking;
        } else if (delta.type === 'signature_delta') {
          if (block.type !== 'thinking' || typeof delta.signature !== 'string') throw new ProviderError('invalid_stream', 'The provider sent invalid reasoning state.');
          block.signature = String(block.signature ?? '') + delta.signature;
        }
        else throw new ProviderError('invalid_stream', 'The provider sent an unsupported content delta.');
      } else if (event.type === 'content_block_stop') {
        const index = number(event.index);
        const block = index === undefined ? undefined : claudeBlocks.get(index);
        if (!block || claudeClosed.has(index!)) throw new ProviderError('invalid_stream', 'The provider completed a missing or completed content block.');
        claudeClosed.add(index!);
        if (block.type === 'tool_use') {
          const call = parseCall(block.id, block.name, argumentParts.get(index!) ?? JSON.stringify(block.input));
          block.input = call.arguments;
          calls.push(call);
        }
      } else if (event.type === 'message_delta') {
        finishReason = typeof record(event.delta).stop_reason === 'string' ? String(record(event.delta).stop_reason) : finishReason;
        usage = usageFrom({...record(event.usage), ...(claudeInputTokens === undefined ? {} : {input_tokens: claudeInputTokens})}, 'anthropic');
      } else if (event.type === 'message_stop') {
        if (!claudeStarted || claudeClosed.size !== claudeBlocks.size || (finishReason === 'tool_use') !== (calls.length > 0)) throw new ProviderError('invalid_stream', 'The provider terminated before its content and tool blocks agreed.');
        if (finishReason !== 'end_turn' && finishReason !== 'tool_use' && finishReason !== 'stop_sequence') throw new ProviderError('provider_incomplete', 'The provider stopped before completing this turn.');
        output = [{role: 'assistant', content: [...claudeBlocks.entries()].sort(([a], [b]) => a - b).map(([, block]) => block)}];
        terminal = true;
        break;
      }
    } else {
      if (event.usage) usage = usageFrom(event.usage, 'chat');
      const choices = array(event.choices);
      if (choices.length > 1) throw new ProviderError('invalid_stream', 'Only one provider completion is supported.');
      for (const rawChoice of choices) {
        const choice = record(rawChoice);
        const delta = record(choice.delta);
        if (finishReason !== null && Object.keys(delta).length) throw new ProviderError('invalid_stream', 'The provider streamed content after its completion marker.');
        if (delta.content !== undefined && delta.content !== null) await emitText(delta.content);
        if (typeof delta.reasoning_content === 'string') chatReasoning += delta.reasoning_content;
        if (delta.tool_calls !== undefined) for (const rawCall of array(delta.tool_calls)) {
          const part = record(rawCall);
          const index = number(part.index);
          if (index === undefined || index > 63) throw new ProviderError('tool_limit', 'The provider returned too many tool calls.');
          const call = chatCalls.get(index) ?? {id: '', name: '', arguments: ''};
          const fn = record(part.function ?? {});
          if (typeof part.id === 'string') call.id += part.id;
          if (typeof fn.name === 'string') call.name += fn.name;
          if (typeof fn.arguments === 'string') call.arguments += fn.arguments;
          if (call.id.length > 512 || call.name.length > 512 || Buffer.byteLength(call.arguments) > 65_536) throw new ProviderError('tool_limit', 'Tool arguments exceeded their limit.');
          chatCalls.set(index, call);
        }
        if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
          if (choice.finish_reason !== 'stop' && choice.finish_reason !== 'tool_calls') throw new ProviderError('provider_incomplete', 'The provider stopped before completing this turn.');
          finishReason = String(choice.finish_reason);
        }
      }
    }
  }
  if (!terminal) throw new ProviderError('incomplete_stream', 'The provider stream ended without a completed response.');
  if (state.protocol === 'chat') {
    calls = [...chatCalls.entries()].sort(([a], [b]) => a - b).map(([, call]) => parseCall(call.id, call.name, call.arguments));
    if ((finishReason === 'tool_calls') !== (calls.length > 0)) throw new ProviderError('invalid_stream', 'The provider completion marker does not match its tool calls.');
    output = [{role: 'assistant', content: text || null, ...(chatReasoning ? {reasoning_content: chatReasoning} : {}), ...(calls.length ? {tool_calls: calls.map(call => ({id: call.id, type: 'function', function: {name: call.name, arguments: canonicalJson(call.arguments)}}))} : {})}];
  }
  if (calls.length > 32 || new Set(calls.map(call => call.id)).size !== calls.length) throw new ProviderError('tool_limit', 'The provider returned too many or duplicate tool calls.');
  return {text, calls, output, ...(usage ? {usage} : {})};
}
