import type {
  AppSettings,
  AsiApi,
  CatalogProvider,
  ChatEvent,
  ChatMessage,
  Conversation,
  ConversationSummary,
  ModelInfo,
  ProviderConfig,
  ProviderInput,
  TestResult,
} from '../../shared/types';

const REPLY = [
  '收到！我是本地模拟模型，这里是一段 **Markdown** 示例：',
  '',
  '- 支持列表、**加粗** 和 `行内代码`',
  '- 输入 `/slow` 可以观察长时间流式输出并随时中止',
  '- 输入 `/error` 可以触发一次固定错误',
  '',
  '```ts',
  'const greeting: string = "你好，ASI";',
  'console.log(greeting);',
  '```',
].join('\n');

const SLOW_REPLY = Array.from({ length: 8 }, (_, i) =>
  [
    `第 ${i + 1} 段：这是一条刻意放慢的回复，用来验证流式渲染、切换会话与中止。`,
    '',
    `- 要点 ${i + 1}.1：界面应该持续追加文本，而不是一次性出现`,
    `- 要点 ${i + 1}.2：切走再切回来后，已生成的内容应当完整保留`,
  ].join('\n'),
).join('\n\n');

const ERROR_PARTIAL = '正在生成回复，但';

const DELTA_MS = 25;
const SLOW_DELTA_MS = 60;

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${(++seq).toString(36)}-${Date.now().toString(36)}`;

const clone = <T>(v: T): T => structuredClone(v);

interface Stream {
  timer: ReturnType<typeof setTimeout> | null;
  messageId: string;
}

type ModelTemplate = Omit<ModelInfo, 'providerId'>;

// pi-ai 内置厂商的演示模型；catalog 的 modelCount 必须与这里一致
const BUILTIN_MODELS: Record<string, ModelTemplate[]> = {
  anthropic: [
    { modelId: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', reasoning: true, contextWindow: 200000 },
    { modelId: 'claude-haiku-4-5', name: 'Claude Haiku 4.5', reasoning: false, contextWindow: 200000 },
  ],
  openai: [
    { modelId: 'gpt-5.2', name: 'GPT-5.2', reasoning: true, contextWindow: 400000 },
    { modelId: 'gpt-5-mini', name: 'GPT-5 mini', reasoning: false, contextWindow: 400000 },
    { modelId: 'gpt-4o-mini', name: 'GPT-4o mini', reasoning: false, contextWindow: 128000 },
  ],
  deepseek: [
    { modelId: 'deepseek-chat', name: 'DeepSeek Chat', reasoning: false, contextWindow: 128000 },
    { modelId: 'deepseek-reasoner', name: 'DeepSeek Reasoner', reasoning: true, contextWindow: 128000 },
  ],
};

const modelsFor = (cfg: ProviderConfig): ModelInfo[] => {
  if (cfg.kind === 'builtin') {
    return (BUILTIN_MODELS[cfg.builtinProvider ?? ''] ?? []).map((m) => ({ ...m, providerId: cfg.id }));
  }
  return cfg.customModels.map((modelId) => ({
    providerId: cfg.id,
    modelId,
    name: modelId,
    reasoning: false,
    contextWindow: 128000,
  }));
};

export function createMockApi(): AsiApi {
  const t0 = Date.now();

  const providers: ProviderConfig[] = [
    {
      id: 'p-anthropic',
      name: 'Anthropic',
      kind: 'builtin',
      builtinProvider: 'anthropic',
      hasApiKey: true,
      enabled: true,
      customModels: [],
      createdAt: t0,
    },
    {
      id: 'p-demo',
      name: 'Demo (OpenAI 兼容)',
      kind: 'openai-compatible',
      baseUrl: 'http://localhost:11434/v1',
      hasApiKey: false,
      enabled: true,
      customModels: ['demo-7b'],
      createdAt: t0,
    },
  ];

  const conversations = new Map<string, Conversation>();
  const streams = new Map<string, Stream>();
  const listeners = new Set<(e: ChatEvent) => void>();

  const settings: AppSettings = {
    defaultModel: { providerId: 'p-anthropic', modelId: 'claude-sonnet-4-5' },
    theme: 'system',
  };

  const seed = (conv: Conversation) => conversations.set(conv.id, conv);
  seed({
    id: 'c-welcome',
    title: '欢迎使用 ASI',
    createdAt: t0 - 60_000,
    updatedAt: t0 - 60_000,
    model: { providerId: 'p-anthropic', modelId: 'claude-sonnet-4-5' },
    messages: [
      { id: 'm-seed-1', role: 'user', text: '你好', createdAt: t0 - 60_000, status: 'done' },
      {
        id: 'm-seed-2',
        role: 'assistant',
        text: '你好！我是模拟助手，很高兴见到你。',
        createdAt: t0 - 59_000,
        model: { providerId: 'p-anthropic', modelId: 'claude-sonnet-4-5' },
        status: 'done',
      },
    ],
  });
  seed({
    id: 'c-empty',
    title: '新对话',
    createdAt: t0 - 30_000,
    updatedAt: t0 - 30_000,
    model: null,
    messages: [],
  });

  const emit = (e: ChatEvent) => {
    for (const cb of listeners) cb(e);
  };

  const cancelStream = (conversationId: string) => {
    const stream = streams.get(conversationId);
    if (stream?.timer) clearTimeout(stream.timer);
    streams.delete(conversationId);
  };

  const getConv = (id: string): Conversation => {
    const conv = conversations.get(id);
    if (!conv) throw new Error('会话不存在');
    return conv;
  };

  return {
    providers: {
      catalog: async (): Promise<CatalogProvider[]> =>
        clone([
          { id: 'anthropic', name: 'Anthropic', modelCount: 2 },
          { id: 'openai', name: 'OpenAI', modelCount: 3 },
          { id: 'deepseek', name: 'DeepSeek', modelCount: 2 },
        ]),
      list: async () => clone(providers),
      save: async (input: ProviderInput) => {
        let cfg: ProviderConfig | undefined;
        if (input.id) {
          cfg = providers.find((p) => p.id === input.id);
          if (!cfg) throw new Error('厂商不存在');
          cfg.name = input.name;
          cfg.kind = input.kind;
          cfg.builtinProvider = input.builtinProvider;
          cfg.baseUrl = input.baseUrl;
          cfg.enabled = input.enabled;
          cfg.customModels = [...input.customModels];
        } else {
          cfg = {
            id: nextId('p'),
            name: input.name,
            kind: input.kind,
            builtinProvider: input.builtinProvider,
            baseUrl: input.baseUrl,
            hasApiKey: false,
            enabled: input.enabled,
            customModels: [...input.customModels],
            createdAt: Date.now(),
          };
          providers.push(cfg);
        }
        // 只保留 hasApiKey：undefined 不变 / null 清除 / 字符串视为已设置，绝不保存明文
        if (input.apiKey === null) cfg.hasApiKey = false;
        else if (typeof input.apiKey === 'string') cfg.hasApiKey = input.apiKey.length > 0;
        return clone(cfg);
      },
      remove: async (id: string) => {
        const i = providers.findIndex((p) => p.id === id);
        if (i >= 0) providers.splice(i, 1);
      },
      models: async (providerId: string) => {
        const cfg = providers.find((p) => p.id === providerId);
        return clone(cfg ? modelsFor(cfg) : []);
      },
      allModels: async () => clone(providers.filter((p) => p.enabled).flatMap(modelsFor)),
      test: async (providerId: string): Promise<TestResult> => {
        if (!providers.some((p) => p.id === providerId)) {
          return { ok: false, error: '厂商不存在' };
        }
        return { ok: true, latencyMs: 120 };
      },
    },
    conversations: {
      list: async (): Promise<ConversationSummary[]> =>
        clone(
          [...conversations.values()]
            .sort((a, b) => b.updatedAt - a.updatedAt)
            .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt })),
        ),
      get: async (id: string) => {
        const conv = conversations.get(id);
        return conv ? clone(conv) : null;
      },
      create: async () => {
        const now = Date.now();
        const conv: Conversation = {
          id: nextId('c'),
          title: '新对话',
          createdAt: now,
          updatedAt: now,
          model: settings.defaultModel ? clone(settings.defaultModel) : null,
          messages: [],
        };
        conversations.set(conv.id, conv);
        return clone(conv);
      },
      rename: async (id: string, title: string) => {
        const conv = getConv(id);
        conv.title = title;
        conv.updatedAt = Date.now();
      },
      remove: async (id: string) => {
        cancelStream(id);
        conversations.delete(id);
      },
      setModel: async (id: string, model) => {
        const conv = getConv(id);
        conv.model = clone(model);
        conv.updatedAt = Date.now();
      },
    },
    chat: {
      send: async (conversationId: string, text: string) => {
        const conv = getConv(conversationId);
        if (streams.has(conversationId)) {
          throw new Error('该会话已有正在进行的回复');
        }
        if (!conv.model) {
          throw new Error('请先为会话选择模型');
        }
        const provider = providers.find((p) => p.id === conv.model?.providerId);
        if (!provider) {
          throw new Error('该会话绑定的厂商已不存在，请重新选择模型');
        }
        if (!provider.enabled) {
          throw new Error('该会话绑定的厂商已停用，请重新选择模型');
        }
        if (!modelsFor(provider).some((m) => m.modelId === conv.model?.modelId)) {
          throw new Error('该会话绑定的模型已不存在，请重新选择模型');
        }
        const now = Date.now();
        const user: ChatMessage = { id: nextId('m'), role: 'user', text, createdAt: now, status: 'done' };
        const assistant: ChatMessage = {
          id: nextId('m'),
          role: 'assistant',
          text: '',
          createdAt: now,
          model: clone(conv.model),
          status: 'streaming',
        };
        conv.messages.push(user, assistant);
        conv.updatedAt = now;
        // 模拟真实后端的标题策略：空会话（默认标题）的首条消息自动生成标题
        if (conv.title === '新对话' && conv.messages.filter((m) => m.role === 'user').length === 1) {
          conv.title = [...text.trim()].slice(0, 30).join('') || '新对话';
        }

        const trimmed = text.trim();
        const mode = trimmed.startsWith('/slow') ? 'slow' : trimmed.startsWith('/error') ? 'error' : 'normal';
        const chars = [...(mode === 'slow' ? SLOW_REPLY : mode === 'error' ? ERROR_PARTIAL : REPLY)];
        const deltaMs = mode === 'slow' ? SLOW_DELTA_MS : DELTA_MS;
        const stream: Stream = { timer: null, messageId: assistant.id };
        streams.set(conversationId, stream);
        let i = 0;
        const tick = () => {
          if (!streams.has(conversationId)) return;
          if (i < chars.length) {
            const delta = chars[i++];
            assistant.text += delta;
            emit({ type: 'delta', conversationId, messageId: assistant.id, delta });
            stream.timer = setTimeout(tick, deltaMs);
          } else if (mode === 'error') {
            assistant.status = 'error';
            assistant.text += '，模拟厂商返回错误。';
            assistant.error = '模拟厂商返回错误：上游服务不可用（mock 固定错误）';
            streams.delete(conversationId);
            emit({ type: 'error', conversationId, message: clone(assistant) });
          } else {
            assistant.status = 'done';
            streams.delete(conversationId);
            emit({ type: 'done', conversationId, message: clone(assistant) });
          }
        };
        stream.timer = setTimeout(tick, deltaMs);

        return clone({ user, assistant });
      },
      abort: async (conversationId: string) => {
        const stream = streams.get(conversationId);
        if (!stream) return;
        cancelStream(conversationId);
        const conv = conversations.get(conversationId);
        const msg = conv?.messages.find((m) => m.id === stream.messageId);
        if (msg) {
          msg.status = 'aborted';
          emit({ type: 'error', conversationId, message: clone(msg) });
        }
      },
      onEvent: (cb) => {
        listeners.add(cb);
        return () => {
          listeners.delete(cb);
        };
      },
    },
    settings: {
      get: async () => clone(settings),
      set: async (patch) => {
        Object.assign(settings, clone(patch));
        return clone(settings);
      },
    },
  };
}

export function installMockApi(): void {
  const g = globalThis as { asi?: AsiApi };
  if (!g.asi) {
    g.asi = createMockApi();
  }
}
