export type ProviderKind = 'builtin' | 'openai-compatible';

/** 渲染进程看到的厂商配置，永远不含明文 key */
export interface ProviderConfig {
  id: string;                 // uuid
  name: string;               // 显示名
  kind: ProviderKind;
  builtinProvider?: string;   // kind=builtin 时为 pi-ai 的 provider id，如 'anthropic' | 'openai' | 'deepseek'
  baseUrl?: string;           // openai-compatible 必填；builtin 可选覆盖
  hasApiKey: boolean;
  enabled: boolean;           // 关闭后其模型不出现在模型选择器
  customModels: string[];     // openai-compatible：用户手填的模型 id
  createdAt: number;
}

export interface ProviderInput {
  id?: string;                // 有 id 为更新，否则新建
  name: string;
  kind: ProviderKind;
  builtinProvider?: string;
  baseUrl?: string;
  apiKey?: string | null;     // undefined=保持不变；null=清除；字符串=设置
  enabled: boolean;
  customModels: string[];
}

export interface CatalogProvider { id: string; name: string; modelCount: number }  // pi-ai 内置厂商目录

export interface ModelRef { providerId: string; modelId: string }

export interface ModelInfo {
  providerId: string;
  modelId: string;
  name: string;
  reasoning: boolean;
  contextWindow?: number;
}

export type MessageStatus = 'streaming' | 'done' | 'error' | 'aborted';

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
  createdAt: number;
  model?: ModelRef;           // assistant 消息记录所用模型
  status?: MessageStatus;     // assistant 消息
  error?: string;
}

export interface Conversation {
  id: string;
  title: string;              // 默认取首条用户消息前 30 字，无则 "新对话"
  createdAt: number;
  updatedAt: number;
  model: ModelRef | null;
  messages: ChatMessage[];
}

export interface ConversationSummary { id: string; title: string; updatedAt: number }

export type ChatEvent =
  | { type: 'delta'; conversationId: string; messageId: string; delta: string }
  | { type: 'done'; conversationId: string; message: ChatMessage }
  | { type: 'error'; conversationId: string; message: ChatMessage };   // message.status 为 'error' 或 'aborted'

export interface AppSettings {
  defaultModel: ModelRef | null;
  theme: 'system' | 'light' | 'dark';
}

export interface TestResult { ok: boolean; latencyMs?: number; error?: string }

export interface AsiApi {
  providers: {
    catalog(): Promise<CatalogProvider[]>;
    list(): Promise<ProviderConfig[]>;
    save(input: ProviderInput): Promise<ProviderConfig>;
    remove(id: string): Promise<void>;
    models(providerId: string): Promise<ModelInfo[]>;     // builtin=pi-ai getModels；compatible=customModels
    allModels(): Promise<ModelInfo[]>;                    // 所有 enabled 厂商的模型
    test(providerId: string, modelId: string): Promise<TestResult>; // 发一条 "ping"，maxTokens 很小，15s 超时
  };
  conversations: {
    list(): Promise<ConversationSummary[]>;               // updatedAt 倒序
    get(id: string): Promise<Conversation | null>;
    create(): Promise<Conversation>;                      // model 取 settings.defaultModel
    rename(id: string, title: string): Promise<void>;
    remove(id: string): Promise<void>;
    setModel(id: string, model: ModelRef): Promise<void>;
  };
  chat: {
    /** 追加用户消息 + 一条 status=streaming 的 assistant 占位消息，立即返回两者；随后通过 onEvent 推送增量 */
    send(conversationId: string, text: string): Promise<{ user: ChatMessage; assistant: ChatMessage }>;
    abort(conversationId: string): Promise<void>;
    onEvent(cb: (e: ChatEvent) => void): () => void;      // 返回取消订阅函数
  };
  settings: {
    get(): Promise<AppSettings>;
    set(patch: Partial<AppSettings>): Promise<AppSettings>;
  };
}
