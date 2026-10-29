import {shell} from 'electron';
import {randomUUID} from 'node:crypto';
import {z} from 'zod';
import type {AddConnectionInput, ConnectionSummary, InferenceModel, InferenceProvider} from '../../src/bridge/inference';
import {ChatGptOAuth, type ChatGptRegistration} from './chatgpt';
import {ConnectionError, requestJson, validateBaseUrl, type JsonTransport} from './network';
import {SecureConnectionStore} from './secure-store';

export interface ConnectionAccount {
  readonly origin: string;
  readonly accountGeneration: number;
  identitySnapshot(): Promise<{userId: string; deviceId: string; generation: number}>;
}
export interface ProviderCredentials {
  kind: 'openai' | 'anthropic' | 'compatible' | 'chatgpt';
  apiKey: string;
  baseUrl?: string;
  accountId?: string;
}
interface SecretConnection {
  id: string;
  name: string;
  provider: InferenceProvider;
  baseUrl: string;
  apiKey?: string;
  registration?: ChatGptRegistration;
}
export interface ConnectionRecord {hostId: string; connections: SecretConnection[]; chatgptPlanAcknowledgedSubjects?: string[]}
interface Store {load(): Promise<ConnectionRecord>; save(value: ConnectionRecord): Promise<void>}
interface ManagerOptions {
  account: ConnectionAccount;
  onChange?(connections: ConnectionSummary[]): void;
  transport?: JsonTransport;
  oauth?: ChatGptOAuth;
  storeFactory?(scope: string): Store;
  openExternal?(url: string): Promise<void>;
}
const baseUrls = {openai: 'https://api.openai.com/v1', anthropic: 'https://api.anthropic.com/v1', kimi: 'https://api.moonshot.ai/v1', chatgpt: 'https://api.openai.com/v1'} as const;
const keySchema = z.string().trim().min(1).max(8192).regex(/^[^\s\u0000-\u001f\u007f]+$/u);
const nameSchema = z.string().trim().min(1).max(80).regex(/^[^\u0000-\u001f\u007f]+$/u);
const addSchema = z.object({provider: z.enum(['openai', 'anthropic', 'kimi', 'compatible']), name: nameSchema.optional(), apiKey: keySchema, baseUrl: z.string().max(1024).optional()}).strict();

function summary(connection: SecretConnection, acknowledgedSubjects: readonly string[] = []): ConnectionSummary {
  const registration = connection.registration;
  const status = connection.provider !== 'chatgpt' ? 'ready' :
    (!registration?.accessToken || registration.reauthorizationRequired ? 'sign-in-required' :
      registration.scopes.includes('chatgpt.tokens.use.direct') ? 'ready' : 'plan-permission-required');
  return {id: connection.id, name: connection.name, provider: connection.provider, baseUrl: connection.baseUrl, status,
    ...(registration?.email ? {accountLabel: registration.email} : {}),
    ...(connection.provider === 'chatgpt' && status === 'ready' && registration?.subject && !acknowledgedSubjects.includes(registration.subject) ? {needsPlanWelcome:true} : {})};
}

/** Host-only secret owner. Renderer APIs receive only summary projections. */
export class ConnectionManager {
  private readonly stores = new Map<string, Store>();
  private readonly transport: JsonTransport;
  private readonly oauth: ChatGptOAuth;
  private tail: Promise<void> = Promise.resolve();
  private pending: AbortController | null = null;
  private readonly requests = new Set<AbortController>();
  private lifecycle = 0;
  constructor(private readonly options: ManagerOptions) {
    this.transport = options.transport ?? requestJson;
    this.oauth = options.oauth ?? new ChatGptOAuth({openExternal: url => shell.openExternal(url), transport: this.transport});
  }
  private serial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.tail.then(operation);
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }
  private async scope() {
    const snapshot = await this.options.account.identitySnapshot();
    const key = `${new URL(this.options.account.origin).origin}\n${snapshot.userId}\n${snapshot.deviceId}`;
    let store = this.stores.get(key);
    if (!store) {
      store = this.options.storeFactory?.(key) ?? new SecureConnectionStore<ConnectionRecord>(key, () => ({hostId: `urn:uuid:${randomUUID()}`, connections: []}));
      this.stores.set(key, store);
    }
    return {snapshot, store, lifecycle: this.lifecycle};
  }
  private fresh(scope: Awaited<ReturnType<ConnectionManager['scope']>>): void {
    if (this.options.account.accountGeneration !== scope.snapshot.generation || this.lifecycle !== scope.lifecycle) throw new ConnectionError('stale_account', 'The account or connection changed. Try again.');
  }
  private emit(record: ConnectionRecord): void {this.options.onChange?.(record.connections.map(connection=>summary(connection,record.chatgptPlanAcknowledgedSubjects)));}

  /** Call on sign-out/account switch/sleep/Quit; pending OAuth cannot activate afterward. */
  invalidate(): void {
    this.lifecycle++; this.cancelChatGPT();
    for (const controller of this.requests) controller.abort();
    this.requests.clear();
  }

  list(): Promise<ConnectionSummary[]> {
    return this.serial(async () => {
      const scope = await this.scope();
      const record = await scope.store.load();
      this.fresh(scope);
      return record.connections.map(connection=>summary(connection,record.chatgptPlanAcknowledgedSubjects));
    });
  }
  add(input: AddConnectionInput): Promise<ConnectionSummary> {
    const parsed = addSchema.parse(input);
    return this.serial(async () => {
      const scope = await this.scope();
      const record = await scope.store.load();
      if (record.connections.length >= 32) throw new ConnectionError('connection_capacity', 'Remove a connection before adding another.');
      const baseUrl = parsed.provider === 'compatible' ? validateBaseUrl(parsed.baseUrl ?? '') : baseUrls[parsed.provider];
      if (parsed.provider !== 'compatible' && parsed.baseUrl && validateBaseUrl(parsed.baseUrl) !== baseUrl) throw new ConnectionError('invalid_provider_url', 'Choose the compatible provider option for a custom API endpoint.');
      const connection: SecretConnection = {id: randomUUID(), name: parsed.name ?? (parsed.provider === 'kimi' ? 'Kimi' : parsed.provider === 'anthropic' ? 'Claude' : parsed.provider === 'openai' ? 'OpenAI' : 'Compatible API'), provider: parsed.provider, baseUrl, apiKey: parsed.apiKey};
      this.fresh(scope);
      record.connections.push(connection);
      await scope.store.save(record);
      this.fresh(scope);
      this.emit(record);
      return summary(connection,record.chatgptPlanAcknowledgedSubjects);
    });
  }

  /** Fixed official target only. It intentionally carries no token, client or account ID. */
  async manageChatGPTUsage():Promise<null> {
    await (this.options.openExternal ?? (url=>shell.openExternal(url)))('https://chatgpt.com/settings/usage');
    return null;
  }

  acknowledgeChatGPTPlan(connectionId:string):Promise<null> {
    z.uuid().parse(connectionId);
    return this.serial(async()=>{
      const scope=await this.scope(),record=await scope.store.load();
      const connection=record.connections.find(value=>value.id===connectionId&&value.provider==='chatgpt');
      const registration=connection?.registration;
      if(!registration?.subject||!registration.accessToken||registration.reauthorizationRequired||!registration.scopes.includes('chatgpt.tokens.use.direct'))throw new ConnectionError('chatgpt_plan_permission_required','ChatGPT plan usage is not enabled for this connection.');
      const acknowledged=record.chatgptPlanAcknowledgedSubjects??[];
      this.fresh(scope);
      if(!acknowledged.includes(registration.subject)){
        if(acknowledged.length>=256)throw new ConnectionError('connection_capacity','The saved ChatGPT account acknowledgement limit was reached.');
        record.chatgptPlanAcknowledgedSubjects=[...acknowledged,registration.subject];
        this.fresh(scope);await scope.store.save(record);this.fresh(scope);this.emit(record);
      }
      return null;
    });
  }
  remove(id: string): Promise<null> {
    z.uuid().parse(id);
    return this.serial(async () => {
      const scope = await this.scope();
      const record = await scope.store.load();
      const connection = record.connections.find(item => item.id === id);
      if (!connection) throw new ConnectionError('connection_not_found', 'This AI connection is unavailable.');
      let remoteRevoked = true;
      if (connection.registration) remoteRevoked = await this.oauth.revoke(connection.registration);
      this.fresh(scope);
      record.connections = record.connections.filter(item => item.id !== id);
      await scope.store.save(record);
      this.fresh(scope);
      this.emit(record);
      if (!remoteRevoked) throw new ConnectionError('remote_revocation_unconfirmed', 'The connection was removed locally. Remote ChatGPT revocation could not be confirmed; disconnect MultAI in ChatGPT Settings.');
      return null;
    });
  }

  private async resolved(scope: Awaited<ReturnType<ConnectionManager['scope']>>, record: ConnectionRecord, id: string, signal?: AbortSignal): Promise<ProviderCredentials> {
    const connection = record.connections.find(item => item.id === id);
    if (!connection) throw new ConnectionError('connection_not_found', 'This AI connection is unavailable.');
    this.fresh(scope);
    if (connection.provider !== 'chatgpt') {
      if (!connection.apiKey) throw new ConnectionError('connection_not_found', 'This AI connection is incomplete.');
      return {kind: connection.provider === 'kimi' ? 'compatible' : connection.provider, apiKey: connection.apiKey, baseUrl: connection.baseUrl};
    }
    let registration = connection.registration;
    if (!registration?.accessToken || registration.reauthorizationRequired) throw new ConnectionError('chatgpt_sign_in_required', 'Sign in to this ChatGPT connection again.');
    if (!registration.scopes.includes('chatgpt.tokens.use.direct')) throw new ConnectionError('chatgpt_plan_permission_required', 'ChatGPT plan usage was not granted. Reconnect this account and enable plan usage.');
    if (registration.expiresAt <= Date.now() + 60_000) {
      try {
        registration = await this.oauth.refresh(registration, signal);
        this.fresh(scope);
        connection.registration = registration;
        await scope.store.save(record);
        this.fresh(scope);
      } catch (error) {
        this.fresh(scope);
        if (error instanceof ConnectionError && error.code === 'chatgpt_refresh_not_ready') throw error;
        // A possibly-consumed rotating refresh token is never automatically retried.
        connection.registration = {clientId: registration.clientId, hostId: registration.hostId, subject: registration.subject, ...(registration.email ? {email: registration.email} : {}), scopes: [], expiresAt: 0, reauthorizationRequired: true};
        await scope.store.save(record);
        this.emit(record);
        throw error instanceof ConnectionError ? error : new ConnectionError('chatgpt_sign_in_required', 'ChatGPT renewal could not be confirmed. Sign in again.');
      }
    }
    if (!registration.scopes.includes('chatgpt.tokens.use.direct') || !registration.accessToken) throw new ConnectionError('chatgpt_plan_permission_required', 'This ChatGPT connection has no plan usage permission.');
    return {kind: 'chatgpt', apiKey: registration.accessToken, baseUrl: baseUrls.chatgpt, ...(registration.subject ? {accountId: registration.subject} : {})};
  }

  /** Trusted native execution only. Never expose this method through preload IPC. */
  resolve(id: string): Promise<ProviderCredentials> {
    z.uuid().parse(id);
    return this.serial(async () => {
      const scope = await this.scope();
      const controller = new AbortController(); this.requests.add(controller);
      try {
        const credentials = await this.resolved(scope, await scope.store.load(), id, controller.signal);
        this.fresh(scope);
        return credentials;
      } finally {this.requests.delete(controller);}
    });
  }

  models(id: string): Promise<InferenceModel[]> {
    z.uuid().parse(id);
    return this.serial(async () => {
      const scope = await this.scope();
      const record = await scope.store.load();
      const controller = new AbortController(); this.requests.add(controller);
      try {
      const credentials = await this.resolved(scope, record, id, controller.signal);
      const headers = credentials.kind === 'anthropic' ? {'x-api-key': credentials.apiKey, 'anthropic-version': '2023-06-01'} : {authorization: `Bearer ${credentials.apiKey}`};
      const raw = await this.transport(`${credentials.baseUrl}/models`, {headers, signal: controller.signal});
      this.fresh(scope);
      if (credentials.kind === 'chatgpt') {
        const data = z.object({models: z.array(z.object({slug: z.string().min(1).max(200), display_name: z.string().min(1).max(200), visibility: z.string()})).max(2000)}).parse(raw);
        return data.models.filter(model => model.visibility === 'list').map(model => ({id: model.slug, name: model.display_name}));
      }
      const schema = z.object({data: z.array(z.object({id: z.string().min(1).max(200), display_name: z.string().min(1).max(200).optional()})).max(2000), has_more: z.boolean().optional(), last_id: z.string().min(1).max(200).optional()});
      let page = schema.parse(raw);
      const all = [...page.data];
      const cursors = new Set<string>();
      for (let index = 1; page.has_more; index++) {
        const cursor = page.last_id ?? page.data.at(-1)?.id;
        if (!cursor || cursors.has(cursor) || index >= 10 || all.length >= 2000) throw new ConnectionError('model_catalog_truncated', 'The provider model catalog exceeded the supported bound. No partial catalog was selected.');
        cursors.add(cursor);
        page = schema.parse(await this.transport(`${credentials.baseUrl}/models?after_id=${encodeURIComponent(cursor)}`, {headers, signal: controller.signal}));
        this.fresh(scope);
        all.push(...page.data);
        if (all.length > 2000) throw new ConnectionError('model_catalog_truncated', 'The provider model catalog exceeded the supported bound.');
      }
      return [...new Map(all.map(model => [model.id,{id: model.id, name: model.display_name ?? model.id}])).values()];
      } finally {this.requests.delete(controller);}
    });
  }

  cancelChatGPT(): void {this.pending?.abort(); this.pending = null;}
  async connectChatGPT(connectionId?: string): Promise<ConnectionSummary> {
    if (connectionId) z.uuid().parse(connectionId);
    this.cancelChatGPT();
    const controller = new AbortController();
    this.pending = controller;
    const prepared = await this.serial(async () => {
      const scope = await this.scope();
      const record = await scope.store.load();
      const previous = connectionId ? record.connections.find(item => item.id === connectionId && item.provider === 'chatgpt') : undefined;
      if (connectionId && !previous) throw new ConnectionError('connection_not_found', 'This ChatGPT registration is unavailable.');
      if (!previous && record.connections.length >= 32) throw new ConnectionError('connection_capacity', 'Remove a connection before adding another.');
      this.fresh(scope);
      await scope.store.save(record); // Persist this host ID before first authorization.
      return {scope, hostId: record.hostId, previous: previous?.registration, id: previous?.id ?? randomUUID()};
    });
    const saveRegistration = (registration: ChatGptRegistration) => this.serial(async () => {
      controller.signal.throwIfAborted();
      this.fresh(prepared.scope);
      const record = await prepared.scope.store.load();
      this.fresh(prepared.scope);
      const existing = record.connections.find(item => item.id === prepared.id);
      const connection: SecretConnection = {id: prepared.id, name: existing?.name ?? 'ChatGPT', provider: 'chatgpt', baseUrl: baseUrls.chatgpt, registration};
      record.connections = record.connections.filter(item => item.id !== prepared.id);
      record.connections.push(connection);
      await prepared.scope.store.save(record);
      this.fresh(prepared.scope);
      this.emit(record);
      return summary(connection,record.chatgptPlanAcknowledgedSubjects);
    });
    try {
      const registration = await this.oauth.signIn({
        hostId: prepared.hostId,
        ...(prepared.previous ? {previous: prepared.previous} : {}),
        ...(prepared.previous&&!prepared.previous.scopes.includes('chatgpt.tokens.use.direct')?{requestPlanConsent:true}:{}),
        onRegistered: async clientId => {await saveRegistration(prepared.previous ?? {clientId, hostId: prepared.hostId, subject: null, scopes: [], expiresAt: 0});},
      }, controller.signal);
      return await saveRegistration(registration);
    } finally {if (this.pending === controller) this.pending = null;}
  }
}
