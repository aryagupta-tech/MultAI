import type {Result} from './contract';

export type InferenceProvider = 'openai' | 'anthropic' | 'kimi' | 'compatible' | 'chatgpt';
export interface ConnectionSummary {
  id: string;
  name: string;
  provider: InferenceProvider;
  status: 'ready' | 'sign-in-required' | 'plan-permission-required';
  baseUrl: string;
  accountLabel?: string;
  /** First eligible sign-in acknowledgement; no tokens or account identifiers. */
  needsPlanWelcome?: boolean;
}
export interface InferenceModel {id: string; name: string}
export interface AddConnectionInput {
  provider: Exclude<InferenceProvider, 'chatgpt'>;
  name?: string;
  apiKey: string;
  baseUrl?: string;
}
/** Keys and OAuth credentials are accepted once, never returned by this surface. */
export interface InferenceConnectionsApi {
  list(): Promise<Result<ConnectionSummary[]>>;
  add(input: AddConnectionInput): Promise<Result<ConnectionSummary>>;
  remove(id: string): Promise<Result<null>>;
  models(id: string): Promise<Result<InferenceModel[]>>;
  connectChatGPT(connectionId?: string): Promise<Result<ConnectionSummary>>;
  cancelChatGPT(): Promise<void>;
  manageChatGPTUsage(): Promise<Result<null>>;
  acknowledgeChatGPTPlan(connectionId: string): Promise<Result<null>>;
  onConnectionsChange(listener: (connections: ConnectionSummary[]) => void): () => void;
}
