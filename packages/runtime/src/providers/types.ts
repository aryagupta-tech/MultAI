import type {JsonValue} from '../policy.js';

export interface ProviderCredentials {
  kind: 'openai' | 'anthropic' | 'compatible' | 'chatgpt' | 'meta' | 'local';
  apiKey: string;
  baseUrl?: string;
  accountId?: string;
}

export interface ModelInfo {id: string; name: string}
/** images: base64 data URLs (png, jpeg or webp), user messages only. */
export interface AgentMessage {role: 'user' | 'assistant'; content: string; images?: string[]}
export interface ToolDefinition {name: string; description: string; parameters: JsonValue}
export interface ToolCall {id: string; name: string; arguments: JsonValue}
export interface Usage {inputTokens?: number; outputTokens?: number; totalTokens?: number}
export type AgentEvent =
  | {type: 'text.delta'; text: string}
  | {type: 'tool.call'; call: ToolCall}
  | {type: 'tool.result'; callId: string; result: JsonValue}
  | {type: 'usage'; usage: Usage}
  | {type: 'turn.completed'; iterations: number}
  | {type: 'steer'; count: number}
  | {type: 'web.search'; query: string};

export interface StreamLimits {
  maxBytes?: number;
  maxEventBytes?: number;
  maxEvents?: number;
  maxTextBytes?: number;
  deadlineMs?: number;
  idleMs?: number;
}

export interface AgentLimits extends StreamLimits {
  maxIterations?: number;
  maxToolCalls?: number;
  maxOutputTokens?: number;
  maxInputBytes?: number;
}

export interface ProviderDependencies {
  signal: AbortSignal;
  fetch?: typeof globalThis.fetch;
  limits?: StreamLimits;
}

export class ProviderError extends Error {
  constructor(readonly code: string, message: string, readonly status?: number) {
    super(message);
    this.name = 'ProviderError';
  }
}

/** Internal protocol state, retained in the host process, never a renderer contract. */
export interface ConversationState {
  protocol: 'responses' | 'anthropic' | 'chat';
  items: Record<string, unknown>[];
}

export interface Completion {
  text: string;
  calls: ToolCall[];
  output: Record<string, unknown>[];
  usage?: Usage;
  /** Claude paused a long server-tool turn; send the conversation again to let it finish. */
  paused?: boolean;
}
