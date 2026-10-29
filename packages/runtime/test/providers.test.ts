import assert from 'node:assert/strict';
import {test} from 'node:test';
import {runAgent} from '../src/agent.js';
import {discoverModels} from '../src/providers/client.js';
import {readSse} from '../src/providers/sse.js';
import {ProviderError, type ProviderCredentials} from '../src/providers/types.js';

const signal = () => new AbortController().signal;
const tools = [{name: 'read_file', description: 'Read a selected controlled file.', parameters: {type: 'object', properties: {path: {type: 'string'}}, required: ['path'], additionalProperties: false}}] as const;
const credentials: ProviderCredentials = {kind: 'openai', apiKey: 'synthetic-key-never-valid'};
const frames = (events: unknown[]) => events.map(event => event === '[DONE]' ? 'data: [DONE]\n\n' : `data: ${JSON.stringify(event)}\n\n`).join('');
const stream = (events: unknown[]) => new Response(frames(events), {headers: {'content-type': 'text/event-stream'}});
const done = (text: string) => ({type: 'response.completed', response: {status: 'completed', output: [{type: 'message', role: 'assistant', content: [{type: 'output_text', text}]}], usage: {input_tokens: 7, output_tokens: 3, total_tokens: 10}}});

test('SSE decodes split UTF-8 and CR/LF frames with multiline data', async () => {
  const input = Buffer.from('event: greeting\r\ndata: hello 🌍\r\ndata: second\r\n\r\ndata: tail\r\r');
  const body = new ReadableStream<Uint8Array>({start(controller) {for (const byte of input) controller.enqueue(Uint8Array.of(byte)); controller.close();}});
  const events = [];
  for await (const event of readSse(new Response(body), signal())) events.push(event);
  assert.deepEqual(events, [{event: 'greeting', data: 'hello 🌍\nsecond'}, {event: 'message', data: 'tail'}]);
});

test('SSE enforces idle, framing and byte limits and cancels its reader', async () => {
  let canceled = false;
  const hung = new Response(new ReadableStream({cancel() {canceled = true;}}));
  await assert.rejects(async () => {for await (const _event of readSse(hung, signal(), {idleMs: 10, deadlineMs: 100})) {}}, /stopped responding/);
  assert.equal(canceled, true);
  await assert.rejects(async () => {for await (const _event of readSse(new Response(`data: ${'x'.repeat(100)}\n\n`), signal(), {maxBytes: 40})) {}}, /byte limit/);
  await assert.rejects(async () => {for await (const _event of readSse(new Response(Uint8Array.of(0xff, 10, 10)), signal())) {}}, /UTF-8/);
});

test('Responses loop preserves reasoning and exact function outputs before the next turn', async () => {
  const bodies: Record<string, unknown>[] = [];
  let calls = 0;
  const fakeFetch: typeof fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    return bodies.length === 1 ? stream([{type: 'response.completed', response: {status: 'completed', output: [
      {type: 'reasoning', id: 'reason_1', encrypted_content: 'synthetic-encrypted-state', summary: []},
      {type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}'},
    ]}}]) : stream([{type: 'response.output_text.delta', delta: 'Verified.'}, done('Verified.')]);
  };
  const events: string[] = [];
  const result = await runAgent({credentials, model: 'synthetic-model', messages: [{role: 'user', content: 'Read a.ts'}], tools: [...tools], signal: signal(), fetch: fakeFetch,
    executeTool: async call => {calls++; assert.deepEqual(call.arguments, {path: 'a.ts'}); return {text: 'const a=1;'};},
    onEvent: event => {events.push(event.type);},
  });
  assert.equal(calls, 1);
  assert.equal(result.text, 'Verified.');
  assert.equal(result.iterations, 2);
  assert.deepEqual((bodies[1]?.input as Record<string, unknown>[]).slice(1), [
    {type: 'reasoning', id: 'reason_1', encrypted_content: 'synthetic-encrypted-state', summary: []},
    {type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}'},
    {type: 'function_call_output', call_id: 'call_1', output: '{"text":"const a=1;"}'},
  ]);
  assert.equal(bodies[0]?.store, false);
  assert.ok(events.includes('turn.completed'));
});

test('ChatGPT uses OAuth public Responses constraints and namespaces local functions', async () => {
  let body: Record<string, unknown> | undefined;
  const fakeFetch: typeof fetch = async (url, init) => {
    assert.equal(String(url), 'https://api.openai.com/v1/responses');
    assert.deepEqual(init?.headers, {'content-type': 'application/json', authorization: 'Bearer synthetic-oauth-access'});
    body = JSON.parse(String(init?.body));
    return stream([done('Hello')]);
  };
  await runAgent({credentials: {kind: 'chatgpt', apiKey: 'synthetic-oauth-access'}, model: 'synthetic-account-model', messages: [{role: 'user', content: 'Hello'}], tools: [...tools], executeTool: async () => null, signal: signal(), fetch: fakeFetch});
  assert.equal(body?.store, false);
  assert.equal(body?.stream, true);
  assert.equal(Object.hasOwn(body!, 'max_output_tokens'), false);
  assert.equal(Object.hasOwn(body!, 'previous_response_id'), false);
  assert.equal((body?.tools as Record<string, unknown>[])[0]?.type, 'namespace');
  assert.equal((body?.tools as Record<string, unknown>[])[0]?.name, 'multai');
});

test('partial, failed, unknown and aborted provider turns dispatch no tools or automatic retry', async () => {
  for (const events of [
    [{type: 'response.output_item.done', item: {type: 'function_call', call_id: 'late', name: 'read_file', arguments: '{"path":"a.ts"}'}}],
    [{type: 'response.output_text.delta', delta: 'partial'}, {type: 'response.failed', response: {error: {code: 'subscription_sharing_usage_limit_exceeded'}}}],
    [{type: 'response.completed', response: {output: [{type: 'function_call', call_id: 'bad', name: 'unmanaged_shell', arguments: '{}'}]}}],
  ]) {
    let network = 0;
    let effects = 0;
    await assert.rejects(runAgent({credentials, model: 'synthetic', messages: [{role: 'user', content: 'test'}], tools: [...tools], signal: signal(), fetch: async () => {network++; return stream(events);}, executeTool: async () => {effects++; return null;}}));
    assert.equal(network, 1);
    assert.equal(effects, 0);
  }
  const canceled = new AbortController(); canceled.abort();
  let network = 0;
  await assert.rejects(runAgent({credentials, model: 'synthetic', messages: [{role: 'user', content: 'test'}], signal: canceled.signal, fetch: async () => {network++; return stream([]);}}));
  assert.equal(network, 0);
});

test('Stop during a live provider stream cancels the reader before any tool dispatch', async () => {
  const controller = new AbortController();
  let canceled = false;
  let effects = 0;
  let checks = 0;
  const body = new ReadableStream<Uint8Array>({
    start(streamController) {streamController.enqueue(Buffer.from(frames([{type: 'response.output_text.delta', delta: 'Partial'}])));},
    cancel() {canceled = true;},
  });
  await assert.rejects(runAgent({credentials, model: 'synthetic', messages: [{role: 'user', content: 'test'}], tools: [...tools], signal: controller.signal,
    fetch: async () => new Response(body, {headers: {'content-type': 'text/event-stream'}}),
    beforeRequest: async () => {checks++;},
    onEvent: event => {if (event.type === 'text.delta') controller.abort();},
    executeTool: async () => {effects++; return null;},
  }));
  assert.equal(checks, 1);
  assert.equal(canceled, true);
  assert.equal(effects, 0);
});

test('Anthropic loop retains signed thinking and serial tool results', async () => {
  const bodies: Record<string, unknown>[] = [];
  const fakeFetch: typeof fetch = async (url, init) => {
    assert.equal(String(url), 'https://api.anthropic.com/v1/messages');
    bodies.push(JSON.parse(String(init?.body)));
    return bodies.length === 1 ? stream([
      {type: 'message_start', message: {usage: {input_tokens: 10}}},
      {type: 'content_block_start', index: 0, content_block: {type: 'thinking', thinking: '', signature: ''}},
      {type: 'content_block_delta', index: 0, delta: {type: 'thinking_delta', thinking: 'Synthetic reasoning'}},
      {type: 'content_block_delta', index: 0, delta: {type: 'signature_delta', signature: 'signed-synthetic'}},
      {type: 'content_block_stop', index: 0},
      {type: 'content_block_start', index: 1, content_block: {type: 'tool_use', id: 'tool_1', name: 'read_file', input: {}}},
      {type: 'content_block_delta', index: 1, delta: {type: 'input_json_delta', partial_json: '{"path":"a.ts"}'}},
      {type: 'content_block_stop', index: 1},
      {type: 'message_delta', delta: {stop_reason: 'tool_use'}, usage: {output_tokens: 20}},
      {type: 'message_stop'},
    ]) : stream([
      {type: 'message_start', message: {usage: {input_tokens: 30}}},
      {type: 'content_block_start', index: 0, content_block: {type: 'text', text: ''}},
      {type: 'content_block_delta', index: 0, delta: {type: 'text_delta', text: 'Read.'}},
      {type: 'content_block_stop', index: 0},
      {type: 'message_delta', delta: {stop_reason: 'end_turn'}, usage: {output_tokens: 2}},
      {type: 'message_stop'},
    ]);
  };
  const result = await runAgent({credentials: {kind: 'anthropic', apiKey: 'synthetic-claude-key'}, model: 'synthetic-claude', messages: [{role: 'user', content: 'Read'}], tools: [...tools], executeTool: async () => ({text: 'hello'}), signal: signal(), fetch: fakeFetch});
  assert.equal(result.text, 'Read.');
  assert.deepEqual(result.usage, {inputTokens: 40, outputTokens: 22, totalTokens: 62});
  const history = bodies[1]?.messages as Record<string, unknown>[];
  assert.deepEqual((history[1]?.content as Record<string, unknown>[])[0], {type: 'thinking', thinking: 'Synthetic reasoning', signature: 'signed-synthetic'});
  assert.equal((history[2]?.content as Record<string, unknown>[])[0]?.type, 'tool_result');
});

test('compatible Chat Completions accumulates split tool arguments and keeps reasoning state', async () => {
  const bodies: Record<string, unknown>[] = [];
  const fakeFetch: typeof fetch = async (url, init) => {
    assert.equal(String(url), 'https://api.moonshot.ai/v1/chat/completions');
    bodies.push(JSON.parse(String(init?.body)));
    return bodies.length === 1 ? stream([
      {choices: [{delta: {reasoning_content: 'Synthetic thought', tool_calls: [{index: 0, id: 'call_', function: {name: 'read_', arguments: '{"path":'}}]}, finish_reason: null}]},
      {choices: [{delta: {tool_calls: [{index: 0, id: '1', function: {name: 'file', arguments: '"a.ts"}'}}]}, finish_reason: 'tool_calls'}]},
      '[DONE]',
    ]) : stream([{choices: [{delta: {content: 'Done'}, finish_reason: null}]}, {choices: [{delta: {}, finish_reason: 'stop'}]}, '[DONE]']);
  };
  const result = await runAgent({credentials: {kind: 'compatible', apiKey: 'synthetic-kimi', baseUrl: 'https://api.moonshot.ai/v1'}, model: 'synthetic-kimi', messages: [{role: 'user', content: 'Read'}], tools: [...tools], executeTool: async () => ({text: 'hello'}), signal: signal(), fetch: fakeFetch});
  assert.equal(result.text, 'Done');
  const history = bodies[1]?.messages as Record<string, unknown>[];
  assert.equal(history[2]?.reasoning_content, 'Synthetic thought');
  assert.equal(history[3]?.tool_call_id, 'call_1');
});

test('live model discovery preserves ChatGPT account ordering and filters hidden models', async () => {
  const models = await discoverModels({kind: 'chatgpt', apiKey: 'synthetic-token'}, {signal: signal(), fetch: async () => new Response(JSON.stringify({models: [
    {slug: 'z', display_name: 'Zed', visibility: 'list'}, {slug: 'hidden', visibility: 'hide'}, {slug: 'a', display_name: 'Aye', visibility: 'list'},
  ]}))});
  assert.deepEqual(models, [{id: 'z', name: 'Zed'}, {id: 'a', name: 'Aye'}]);
});

test('provider endpoint and error handling never redirects or exposes credentials', async () => {
  let requests = 0;
  await assert.rejects(discoverModels({...credentials, baseUrl: 'https://untrusted.example/v1'}, {signal: signal(), fetch: async () => {requests++; return new Response('{}');}}), /fixed official/);
  assert.equal(requests, 0);
  await assert.rejects(discoverModels(credentials, {signal: signal(), fetch: async (_url, init) => {assert.equal(init?.redirect, 'error'); return new Response('secret-body-must-not-escape', {status: 401});}}), error => error instanceof Error && !error.message.includes('secret-body') && error.message.includes('fresh credentials'));
});

test('known HTTP ChatGPT usage errors survive bounded sanitization without raw provider messages', async () => {
  for (const [status, code] of [[429, 'subscription_sharing_usage_limit_exceeded'], [403, 'subscription_sharing_usage_unavailable']] as const) {
    let effects = 0;
    await assert.rejects(runAgent({credentials: {kind: 'chatgpt', apiKey: 'synthetic-oauth'}, model: 'synthetic', messages: [{role: 'user', content: 'test'}], signal: signal(), tools: [...tools],
      fetch: async () => new Response(JSON.stringify({error: {code, message: 'raw-provider-secret-must-not-escape'}}), {status}),
      executeTool: async () => {effects++; return null;},
    }), error => error instanceof ProviderError && error.code === code && error.status === status && !error.message.includes('raw-provider-secret'));
    assert.equal(effects, 0);
  }
  await assert.rejects(discoverModels(credentials, {signal: signal(), fetch: async () => new Response(JSON.stringify({error: {code: 'opaque_private_secret_code', message: 'do-not-return'}}), {status: 403})}), error => error instanceof ProviderError && error.code === 'provider_access_denied' && !error.message.includes('do-not-return'));
  await assert.rejects(discoverModels(credentials, {signal: signal(), fetch: async () => new Response(JSON.stringify({error: {code: 'subscription_sharing_usage_unavailable'}, padding: 'x'.repeat(16384)}), {status: 403})}), error => error instanceof ProviderError && error.code === 'provider_access_denied');
});

test('known SSE usage errors retain only allowlisted codes and never dispatch pending calls', async () => {
  for (const code of ['subscription_sharing_usage_limit_exceeded', 'subscription_sharing_usage_unavailable']) {
    let effects = 0;
    await assert.rejects(runAgent({credentials: {kind: 'chatgpt', apiKey: 'synthetic-oauth'}, model: 'synthetic', messages: [{role: 'user', content: 'test'}], signal: signal(), tools: [...tools],
      fetch: async () => stream([{type: 'response.output_text.delta', delta: 'Partial'}, {type: 'error', error: {code, message: 'raw-secret-provider-body'}}]),
      executeTool: async () => {effects++; return null;},
    }), error => error instanceof ProviderError && error.code === code && !error.message.includes('raw-secret-provider-body'));
    assert.equal(effects, 0);
  }
});

test('inconsistent Claude and compatible terminal markers dispatch no tool calls', async () => {
  const start = {type: 'message_start', message: {usage: {input_tokens: 1}}};
  const block = {type: 'content_block_start', index: 0, content_block: {type: 'tool_use', id: 'tool_1', name: 'read_file', input: {path: 'a.ts'}}};
  const stop = {type: 'content_block_stop', index: 0};
  const malformed: {kind: 'anthropic' | 'compatible'; events: unknown[]}[] = [
    {kind: 'anthropic', events: [start, block, {type: 'message_delta', delta: {stop_reason: 'tool_use'}, usage: {output_tokens: 1}}, {type: 'message_stop'}]},
    {kind: 'anthropic', events: [start, block, stop, {type: 'message_delta', delta: {stop_reason: 'end_turn'}, usage: {output_tokens: 1}}, {type: 'message_stop'}]},
    {kind: 'anthropic', events: [start, block, stop, {type: 'content_block_delta', index: 0, delta: {type: 'input_json_delta', partial_json: '{}'}}, {type: 'message_stop'}]},
    {kind: 'compatible', events: [{choices: [{delta: {tool_calls: [{index: 0, id: 'call_1', function: {name: 'read_file', arguments: '{"path":"a.ts"}'}}]}, finish_reason: 'stop'}]}, '[DONE]']},
  ];
  for (const input of malformed) {
    let effects = 0;
    await assert.rejects(runAgent({credentials: {kind: input.kind, apiKey: 'synthetic-key'}, model: 'synthetic', messages: [{role: 'user', content: 'test'}], signal: signal(), tools: [...tools], fetch: async () => stream(input.events), executeTool: async () => {effects++; return null;}}), error => error instanceof ProviderError && error.code === 'invalid_stream');
    assert.equal(effects, 0);
  }
});

test('buffered SSE frames honor cancellation and deadline before releasing the next event', async () => {
  const controller = new AbortController();
  const aborted = readSse(new Response('data: one\n\ndata: two\n\n'), controller.signal);
  assert.equal((await aborted.next()).value?.data, 'one');
  controller.abort();
  await assert.rejects(aborted.next());
  const expires = readSse(new Response('data: one\n\ndata: two\n\n'), signal(), {deadlineMs: 100});
  assert.equal((await expires.next()).value?.data, 'one');
  await new Promise(resolve => setTimeout(resolve, 120));
  await assert.rejects(expires.next(), error => error instanceof ProviderError && error.code === 'provider_timeout');
});
