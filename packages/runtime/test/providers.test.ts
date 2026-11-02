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

test('a stream without a Content-Type is read; an explicit non-stream type or a non-SSE body is refused', async () => {
  // The ChatGPT plan's Responses endpoint streams SSE with no Content-Type header.
  const bare = (text: string) => {const response = new Response(text); response.headers.delete('content-type'); return response;};
  const untyped = async () => bare(frames([done('ok')]));
  const result = await runAgent({credentials: {kind: 'chatgpt', apiKey: 'synthetic-oauth-access'}, model: 'synthetic-account-model', messages: [{role: 'user', content: 'Hi'}], signal: signal(), fetch: untyped});
  assert.equal(result.text, 'ok');
  const json = async () => new Response('{"ok":true}', {headers: {'content-type': 'application/json'}});
  await assert.rejects(runAgent({credentials, model: 'synthetic-model', messages: [{role: 'user', content: 'Hi'}], signal: signal(), fetch: json}), (error: unknown) => error instanceof ProviderError && error.code === 'invalid_stream');
  const plain = async () => bare('not an event stream');
  await assert.rejects(runAgent({credentials, model: 'synthetic-model', messages: [{role: 'user', content: 'Hi'}], signal: signal(), fetch: plain}), (error: unknown) => error instanceof ProviderError);
});

test('ChatGPT items that arrive only while streaming are kept when the final output list is empty', async () => {
  // Observed from the ChatGPT plan backend: response.completed carries output: [] and the items come earlier.
  const call = {type: 'function_call', call_id: 'c1', name: 'read_file', namespace: 'multai', arguments: '{"path":"a.txt"}'};
  const message = {type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'It says hi.'}]};
  const turns = [
    [{type: 'response.output_item.done', item: {type: 'reasoning', id: 'r1', encrypted_content: 'opaque', summary: []}}, {type: 'response.output_item.done', item: call}, {type: 'response.completed', response: {status: 'completed', output: [], usage: {input_tokens: 5, output_tokens: 2}}}],
    [{type: 'response.output_item.done', item: message}, {type: 'response.completed', response: {status: 'completed', output: []}}],
  ];
  const sent: Record<string, unknown>[] = [];
  let turn = 0;
  const fakeFetch: typeof fetch = async (_url, init) => {sent.push(JSON.parse(String(init?.body))); return stream(turns[turn++]!);};
  const seen: unknown[] = [];
  const result = await runAgent({credentials: {kind: 'chatgpt', apiKey: 'synthetic-oauth-access'}, model: 'm', messages: [{role: 'user', content: 'Read a.txt'}], tools: [...tools], executeTool: async (toolCall) => {seen.push(toolCall.arguments); return 'hi';}, signal: signal(), fetch: fakeFetch});
  assert.deepEqual(seen, [{path: 'a.txt'}]);
  assert.equal(result.text, 'It says hi.');
  const secondInput = sent[1]?.input as Record<string, unknown>[];
  assert.ok(secondInput.some(item => item.type === 'reasoning' && item.encrypted_content === 'opaque'));
  assert.ok(secondInput.some(item => item.type === 'function_call_output' && item.call_id === 'c1'));
});

test('reasoning effort is sent in each protocol\'s own field, and never to Messages', async () => {
  const bodies: Record<string, unknown>[] = [];
  const capture: typeof fetch = async (_url, init) => {bodies.push(JSON.parse(String(init?.body))); return stream([done('ok')]);};
  await runAgent({credentials, model: 'm', messages: [{role: 'user', content: 'Hi'}], signal: signal(), fetch: capture, reasoningEffort: 'high'});
  assert.deepEqual(bodies.at(-1)?.reasoning, {effort: 'high'});
  const chat: typeof fetch = async (_url, init) => {bodies.push(JSON.parse(String(init?.body))); return stream([{choices: [{index: 0, delta: {content: 'ok'}, finish_reason: 'stop'}]}, '[DONE]']);};
  await runAgent({credentials: {kind: 'compatible', apiKey: 'k', baseUrl: 'https://api.meta.ai/v1'}, model: 'm', messages: [{role: 'user', content: 'Hi'}], signal: signal(), fetch: chat, reasoningEffort: 'low'});
  assert.equal(bodies.at(-1)?.reasoning_effort, 'low');
  await assert.rejects(runAgent({credentials, model: 'm', messages: [{role: 'user', content: 'Hi'}], signal: signal(), fetch: capture, reasoningEffort: 'HIGH; drop'}), ProviderError);
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

test('a screenshot reaches the model as an image part, and malformed images are refused', async () => {
  const image = 'data:image/jpeg;base64,/9j/4AAQSkZJRg==';
  let body: Record<string, unknown> | undefined;
  const fakeFetch: typeof fetch = async (_url, init) => {body = JSON.parse(String(init?.body)); return stream([{choices: [{delta: {content: 'I see the overlap.'}, finish_reason: null}]}, {choices: [{delta: {}, finish_reason: 'stop'}]}, '[DONE]']);};
  const meta = {kind: 'compatible' as const, apiKey: 'synthetic-meta', baseUrl: 'https://api.meta.ai/v1'};
  const result = await runAgent({credentials: meta, model: 'muse-spark-1.3', messages: [{role: 'user', content: 'What is wrong here?', images: [image]}], signal: signal(), fetch: fakeFetch});
  assert.equal(result.text, 'I see the overlap.');
  const messages = body?.messages as {content: unknown}[];
  assert.deepEqual(messages.at(-1)?.content, [{type: 'text', text: 'What is wrong here?'}, {type: 'image_url', image_url: {url: image}}]);
  for (const bad of ['data:image/svg+xml;base64,PHN2Zz4=', 'https://example.com/a.png']) {
    await assert.rejects(runAgent({credentials: meta, model: 'muse-spark-1.3', messages: [{role: 'user', content: 'x', images: [bad]}], signal: signal(), fetch: fakeFetch}), /context is invalid/);
  }
});

test('text from separate agent turns keeps a paragraph break, in the stream and the result', async () => {
  let calls = 0;
  const fakeFetch: typeof fetch = async () => ++calls === 1 ? stream([
    {choices: [{delta: {content: 'Checking the workspace.', tool_calls: [{index: 0, id: 'call_1', function: {name: 'read_file', arguments: '{"path":"a.ts"}'}}]}, finish_reason: null}]},
    {choices: [{delta: {}, finish_reason: 'tool_calls'}]}, '[DONE]',
  ]) : stream([{choices: [{delta: {content: 'Found it.'}, finish_reason: null}]}, {choices: [{delta: {}, finish_reason: 'stop'}]}, '[DONE]']);
  let streamed = '';
  const result = await runAgent({credentials: {kind: 'compatible', apiKey: 'synthetic-meta', baseUrl: 'https://api.meta.ai/v1'}, model: 'muse-spark-1.3', messages: [{role: 'user', content: 'Read'}], tools: [...tools], executeTool: async () => ({text: 'hello'}), signal: signal(), fetch: fakeFetch, onEvent: event => {if (event.type === 'text.delta') streamed += event.text;}});
  assert.equal(result.text, 'Checking the workspace.\n\nFound it.');
  assert.equal(streamed, result.text);
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

test('directions sent while the agent works reach the next turn in each protocol, and a late one keeps the run going', async () => {
  const toolTurn: Record<string, unknown[]> = {
    chat: [{choices: [{delta: {tool_calls: [{index: 0, id: 'call_1', function: {name: 'read_file', arguments: '{"path":"a.ts"}'}}]}, finish_reason: null}]}, {choices: [{delta: {}, finish_reason: 'tool_calls'}]}, '[DONE]'],
    responses: [{type: 'response.completed', response: {status: 'completed', output: [{type: 'function_call', call_id: 'call_1', name: 'read_file', arguments: '{"path":"a.ts"}'}]}}],
    anthropic: [{type: 'message_start', message: {usage: {input_tokens: 1}}}, {type: 'content_block_start', index: 0, content_block: {type: 'tool_use', id: 'call_1', name: 'read_file', input: {}}}, {type: 'content_block_delta', index: 0, delta: {type: 'input_json_delta', partial_json: '{"path":"a.ts"}'}}, {type: 'content_block_stop', index: 0}, {type: 'message_delta', delta: {stop_reason: 'tool_use'}, usage: {output_tokens: 1}}, {type: 'message_stop'}],
  };
  const textTurn: Record<string, (text: string) => unknown[]> = {
    chat: text => [{choices: [{delta: {content: text}, finish_reason: null}]}, {choices: [{delta: {}, finish_reason: 'stop'}]}, '[DONE]'],
    responses: text => [done(text)],
    anthropic: text => [{type: 'message_start', message: {usage: {input_tokens: 1}}}, {type: 'content_block_start', index: 0, content_block: {type: 'text', text: ''}}, {type: 'content_block_delta', index: 0, delta: {type: 'text_delta', text}}, {type: 'content_block_stop', index: 0}, {type: 'message_delta', delta: {stop_reason: 'end_turn'}, usage: {output_tokens: 1}}, {type: 'message_stop'}],
  };
  const kinds: [string, ProviderCredentials][] = [
    ['chat', {kind: 'compatible', apiKey: 'synthetic-meta', baseUrl: 'https://api.meta.ai/v1'}],
    ['responses', credentials],
    ['anthropic', {kind: 'anthropic', apiKey: 'synthetic-claude'}],
  ];
  for (const [protocol, creds] of kinds) {
    const bodies: Record<string, unknown>[] = [];
    const fakeFetch: typeof fetch = async (_url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return stream(bodies.length === 1 ? toolTurn[protocol]! : textTurn[protocol]!(bodies.length === 2 ? 'Using floats.' : 'Switched to cents.'));
    };
    // After the tool round: a direction. As the model finishes: a late one, which keeps the run going. Then none.
    const queue = [['Use cents, not floats.'], ['Also keep it short.'], []];
    let steered = 0;
    const result = await runAgent({credentials: creds, model: 'synthetic', messages: [{role: 'user', content: 'Add discount'}], tools: [...tools], executeTool: async () => ({text: 'x'}), signal: signal(), fetch: fakeFetch, steer: async () => queue.shift() ?? [], onEvent: event => {if (event.type === 'steer') steered += event.count;}});
    assert.equal(bodies.length, 3, protocol);
    assert.equal(steered, 2, protocol);
    assert.match(result.text, /Switched to cents\.$/u, protocol);
    const second = JSON.stringify(bodies[1]);
    assert.match(second, /Use cents, not floats\./u, protocol);
    assert.match(JSON.stringify(bodies[2]), /Also keep it short\./u, protocol);
    if (protocol === 'anthropic') {
      // One user turn holding the tool result and the direction.
      const last = (bodies[1]!.messages as {role: string; content: {type: string}[]}[]).at(-1)!;
      assert.deepEqual(last.content.map(part => part.type), ['tool_result', 'text']);
    }
  }
});

test('the provider\'s own web search is requested only when allowed, reported, and kept for the next turn', async () => {
  // Responses: a hosted web_search_call before the answer.
  const bodies: Record<string, unknown>[] = [];
  const searched: string[] = [];
  const responsesFetch: typeof fetch = async (_url, init) => {
    bodies.push(JSON.parse(String(init?.body)));
    const call = {type: 'web_search_call', id: 'ws_1', status: 'completed', action: {type: 'search', query: 'node 24 release date'}};
    return stream([{type: 'response.output_item.done', item: call}, {type: 'response.completed', response: {status: 'completed', output: [call, {type: 'message', role: 'assistant', content: [{type: 'output_text', text: 'April 2025 ([nodejs.org](https://nodejs.org)).'}]}]}}]);
  };
  const answer = await runAgent({credentials, model: 'synthetic', messages: [{role: 'user', content: 'When was Node 24 released?'}], hostedSearch: true, signal: signal(), fetch: responsesFetch, onEvent: event => {if (event.type === 'web.search') searched.push(event.query);}});
  assert.match(answer.text, /nodejs\.org/u);
  assert.deepEqual(bodies[0]?.tools, [{type: 'web_search'}]);
  assert.deepEqual(searched, ['node 24 release date']);
  // Without permission the same hosted item is refused.
  await assert.rejects(runAgent({credentials, model: 'synthetic', messages: [{role: 'user', content: 'x'}], signal: signal(), fetch: responsesFetch}), /unsupported hosted tool/u);
  // Chat Completions providers never get it.
  let chatBody: Record<string, unknown> | undefined;
  await runAgent({credentials: {kind: 'compatible', apiKey: 'synthetic-compatible', baseUrl: 'https://api.example.com/v1'}, model: 'synthetic', messages: [{role: 'user', content: 'x'}], hostedSearch: true, signal: signal(),
    fetch: async (_url, init) => {chatBody = JSON.parse(String(init?.body)); return stream([{choices: [{delta: {content: 'ok'}, finish_reason: null}]}, {choices: [{delta: {}, finish_reason: 'stop'}]}, '[DONE]']);}});
  assert.equal(chatBody?.tools, undefined);

  // Claude: server_tool_use + results, a pause, then a cited answer.
  const claude: Record<string, unknown>[] = [];
  const claudeFetch: typeof fetch = async (_url, init) => {
    claude.push(JSON.parse(String(init?.body)));
    if (claude.length === 1) return stream([
      {type: 'message_start', message: {usage: {input_tokens: 5}}},
      {type: 'content_block_start', index: 0, content_block: {type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: {}}},
      {type: 'content_block_delta', index: 0, delta: {type: 'input_json_delta', partial_json: '{"query":"vitest 5 release"}'}},
      {type: 'content_block_stop', index: 0},
      {type: 'content_block_start', index: 1, content_block: {type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [{type: 'web_search_result', url: 'https://vitest.dev', title: 'Vitest', encrypted_content: 'x'}]}},
      {type: 'content_block_stop', index: 1},
      {type: 'message_delta', delta: {stop_reason: 'pause_turn'}, usage: {output_tokens: 3}},
      {type: 'message_stop'},
    ]);
    return stream([
      {type: 'message_start', message: {usage: {input_tokens: 9}}},
      {type: 'content_block_start', index: 0, content_block: {type: 'text', text: ''}},
      {type: 'content_block_delta', index: 0, delta: {type: 'text_delta', text: 'Vitest 5 is out.'}},
      {type: 'content_block_delta', index: 0, delta: {type: 'citations_delta', citation: {type: 'web_search_result_location', url: 'https://vitest.dev', title: 'Vitest', cited_text: 'Vitest 5'}}},
      {type: 'content_block_stop', index: 0},
      {type: 'message_delta', delta: {stop_reason: 'end_turn'}, usage: {output_tokens: 4}},
      {type: 'message_stop'},
    ]);
  };
  const claudeSearched: string[] = [];
  const cited = await runAgent({credentials: {kind: 'anthropic', apiKey: 'synthetic-claude'}, model: 'synthetic-claude', messages: [{role: 'user', content: 'Is Vitest 5 out?'}], hostedSearch: true, signal: signal(), fetch: claudeFetch, onEvent: event => {if (event.type === 'web.search') claudeSearched.push(event.query);}});
  assert.equal(cited.text, 'Vitest 5 is out.');
  assert.deepEqual(claudeSearched, ['vitest 5 release']);
  assert.deepEqual((claude[0]?.tools as unknown[]).at(-1), {type: 'web_search_20250305', name: 'web_search', max_uses: 5});
  // The paused turn goes back as-is so Claude can continue from its own search.
  const resent = (claude[1]?.messages as {role: string; content: {type: string; input?: unknown}[]}[]).at(-1)!;
  assert.equal(resent.role, 'assistant');
  assert.deepEqual(resent.content.map(block => block.type), ['server_tool_use', 'web_search_tool_result']);
  assert.deepEqual(resent.content[0]?.input, {query: 'vitest 5 release'});
});

test('Muse runs on Meta\'s Responses API with its web search, and falls back to Chat Completions if refused', async () => {
  const meta: ProviderCredentials = {kind: 'meta', apiKey: 'synthetic-meta'};
  const urls: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  const reasoning = {type: 'reasoning', id: 'rs_1', summary: []};
  const call = {type: 'function_call', call_id: 'c1', name: 'read_file', arguments: '{"path":"a.txt"}'};
  let turn = 0;
  const responses: typeof fetch = async (url, init) => {
    urls.push(String(url)); bodies.push(JSON.parse(String(init?.body)));
    if (++turn === 1) return stream([{type: 'response.completed', response: {status: 'completed', output: [reasoning, call]}}]);
    const search = {type: 'web_search_call', id: 'ws_1', status: 'completed', action: {type: 'search', query: 'muse spark'}};
    return stream([{type: 'response.output_item.done', item: search}, done('Found it.')]);
  };
  const searched: string[] = [];
  const answer = await runAgent({credentials: meta, model: 'muse-spark-1.3', messages: [{role: 'user', content: 'Look it up'}], tools, hostedSearch: true, signal: signal(), fetch: responses,
    executeTool: async () => ({text: 'hello'}), onEvent: event => {if (event.type === 'web.search') searched.push(event.query);}});
  assert.equal(answer.text, 'Found it.');
  assert.equal(urls[0], 'https://api.meta.ai/v1/responses');
  assert.equal(bodies[0]?.include, undefined, 'encrypted reasoning is not asked of Meta');
  assert.deepEqual((bodies[0]?.tools as {type: string}[]).map(tool => tool.type), ['function', 'web_search']);
  // The reasoning item is not sent back; the call and its result are.
  const carried = bodies[1]?.input as {type?: string}[];
  assert.equal(carried.some(item => item.type === 'reasoning'), false);
  assert.deepEqual(carried.filter(item => item.type).map(item => item.type), ['function_call', 'function_call_output']);
  assert.deepEqual(searched, ['muse spark']);
  // Another endpoint is refused for Meta credentials.
  await assert.rejects(runAgent({credentials: {...meta, baseUrl: 'https://api.example.com/v1'}, model: 'muse-spark-1.3', messages: [{role: 'user', content: 'x'}], signal: signal(), fetch: responses}), /fixed official API endpoint/u);

  // A refused Responses request: this run and later ones use Chat Completions.
  const fallbackUrls: string[] = [];
  const fallback: typeof fetch = async url => {
    fallbackUrls.push(String(url));
    if (String(url).endsWith('/responses')) return new Response(JSON.stringify({error: {message: 'unknown parameter'}}), {status: 400, headers: {'content-type': 'application/json'}});
    return stream([{choices: [{delta: {content: 'ok'}, finish_reason: null}]}, {choices: [{delta: {}, finish_reason: 'stop'}]}, '[DONE]']);
  };
  const first = await runAgent({credentials: meta, model: 'muse-fallback-test', messages: [{role: 'user', content: 'x'}], signal: signal(), fetch: fallback});
  assert.equal(first.text, 'ok');
  await runAgent({credentials: meta, model: 'muse-fallback-test', messages: [{role: 'user', content: 'y'}], signal: signal(), fetch: fallback});
  assert.deepEqual(fallbackUrls, ['https://api.meta.ai/v1/responses', 'https://api.meta.ai/v1/chat/completions', 'https://api.meta.ai/v1/chat/completions']);
  // Credentials and rate limits are not protocol problems: no fallback.
  await assert.rejects(runAgent({credentials: meta, model: 'muse-auth-test', messages: [{role: 'user', content: 'x'}], signal: signal(),
    fetch: async () => new Response('{}', {status: 401, headers: {'content-type': 'application/json'}})}), (error: unknown) => error instanceof ProviderError && error.status === 401);
});

test('a local model is reached over Chat Completions on this computer only', async () => {
  const urls: string[] = [];
  const local: typeof fetch = async url => {urls.push(String(url)); return stream([{choices: [{delta: {content: 'hi from glimmer'}, finish_reason: null}]}, {choices: [{delta: {}, finish_reason: 'stop'}]}, '[DONE]']);};
  const answer = await runAgent({credentials: {kind: 'local', apiKey: 'not-needed', baseUrl: 'http://localhost:11434/v1'}, model: 'muse-glimmer', messages: [{role: 'user', content: 'hi'}], signal: signal(), fetch: local});
  assert.equal(answer.text, 'hi from glimmer');
  assert.deepEqual(urls, ['http://localhost:11434/v1/chat/completions']);
  for (const baseUrl of ['http://192.168.1.5:11434/v1', 'http://example.com/v1', 'ftp://localhost/v1', 'http://user:pw@localhost:1234/v1']) {
    await assert.rejects(runAgent({credentials: {kind: 'local', apiKey: 'x', baseUrl}, model: 'm', messages: [{role: 'user', content: 'hi'}], signal: signal(), fetch: local}), /served on this computer/u, baseUrl);
  }
  // Other providers still refuse plain http and localhost.
  await assert.rejects(runAgent({credentials: {kind: 'compatible', apiKey: 'x', baseUrl: 'http://localhost:11434/v1'}, model: 'm', messages: [{role: 'user', content: 'hi'}], signal: signal(), fetch: local}), /HTTPS/u);
});

test('separate text blocks in one Responses turn become separate paragraphs', async () => {
  const fetcher: typeof fetch = async () => stream([
    {type: 'response.output_text.delta', output_index: 0, content_index: 0, delta: 'I will search.'},
    {type: 'response.output_text.delta', output_index: 2, content_index: 0, delta: 'Found '},
    {type: 'response.output_text.delta', output_index: 2, content_index: 0, delta: 'it.'},
    {type: 'response.completed', response: {status: 'completed', output: []}},
  ]);
  const answer = await runAgent({credentials, model: 'synthetic', messages: [{role: 'user', content: 'x'}], signal: signal(), fetch: fetcher});
  assert.equal(answer.text, 'I will search.\n\nFound it.');
});
