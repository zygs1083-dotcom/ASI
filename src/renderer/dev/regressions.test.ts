/// <reference lib="dom" />
import { createElement, type ReactNode } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  AppSettings,
  AsiApi,
  ChatEvent,
  ChatMessage,
  Conversation,
  ModelRef,
  ProviderConfig,
  ProviderInput,
} from '../../shared/types';
import { devCspPlugin, relaxCspForDev } from './csp';
import { createMockApi } from './mockApi';

// ---------- 可控 AsiApi stub：事件手动 emit，响应可注入/挂起 ----------

const MODEL: ModelRef = { providerId: 'p1', modelId: 'm1' };
const MODEL2: ModelRef = { providerId: 'p1', modelId: 'm2' };

let seq = 0;
const nid = (p: string) => `${p}-${++seq}`;

const clone = <T>(v: T): T => structuredClone(v);

function userMsg(text: string, over: Partial<ChatMessage> = {}): ChatMessage {
  return { id: nid('u'), role: 'user', text, createdAt: Date.now(), status: 'done', ...over };
}

function asstMsg(over: Partial<ChatMessage> = {}): ChatMessage {
  return { id: nid('a'), role: 'assistant', text: '', createdAt: Date.now(), status: 'streaming', ...over };
}

function conv(id: string, over: Partial<Conversation> = {}): Conversation {
  const now = Date.now();
  return { id, title: '新对话', createdAt: now, updatedAt: now, model: MODEL, messages: [], ...over };
}

interface SendResult {
  user: ChatMessage;
  assistant: ChatMessage;
}

interface ApiHooks {
  conversations?: Conversation[];
  settings?: AppSettings;
  onSend?: (convId: string, text: string) => SendResult | Promise<SendResult>;
  onRetry?: (convId: string) => { assistant: ChatMessage } | Promise<{ assistant: ChatMessage }>;
  onGet?: (id: string) => Conversation | null | Promise<Conversation | null>;
  onCreate?: () => Conversation | Promise<Conversation>;
  onSettingsSet?: (patch: Partial<AppSettings>) => AppSettings | Promise<AppSettings>;
}

function makeApi(hooks: ApiHooks = {}) {
  const convs = new Map((hooks.conversations ?? []).map((c) => [c.id, c]));
  const listeners = new Set<(e: ChatEvent) => void>();
  const settings: AppSettings = hooks.settings ?? { defaultModel: null, theme: 'system' };
  const calls = {
    send: [] as { convId: string; text: string }[],
    retry: [] as string[],
    get: [] as string[],
    create: 0,
    settingsSet: [] as Partial<AppSettings>[],
  };
  const emit = (e: ChatEvent) => {
    for (const cb of listeners) cb(e);
  };
  const provider: ProviderConfig = {
    id: 'p1',
    name: 'Provider One',
    kind: 'openai-compatible',
    baseUrl: 'http://localhost:9/v1',
    hasApiKey: true,
    enabled: true,
    customModels: ['m1', 'm2'],
    createdAt: 0,
  };
  const models = [
    { providerId: 'p1', modelId: 'm1', name: 'M One', reasoning: false },
    { providerId: 'p1', modelId: 'm2', name: 'M Two', reasoning: false },
  ];
  const api: AsiApi = {
    providers: {
      catalog: async () => [],
      list: async () => [clone(provider)],
      save: async () => clone(provider),
      remove: async () => {},
      models: async () => clone(models),
      allModels: async () => clone(models),
      test: async () => ({ ok: true, latencyMs: 1 }),
    },
    conversations: {
      list: async () =>
        [...convs.values()]
          .sort((a, b) => b.updatedAt - a.updatedAt)
          .map((c) => ({ id: c.id, title: c.title, updatedAt: c.updatedAt })),
      get: async (id) => {
        calls.get.push(id);
        if (hooks.onGet) return hooks.onGet(id);
        const c = convs.get(id);
        return c ? clone(c) : null;
      },
      create: async () => {
        calls.create += 1;
        const c = hooks.onCreate ? await hooks.onCreate() : conv(nid('c'));
        convs.set(c.id, clone(c));
        return clone(c);
      },
      rename: async (id, title) => {
        const c = convs.get(id);
        if (c) {
          c.title = title;
          c.updatedAt = Date.now();
        }
      },
      remove: async (id) => {
        convs.delete(id);
      },
      setModel: async (id, model) => {
        const c = convs.get(id);
        if (c) {
          c.model = clone(model);
          c.updatedAt = Date.now();
        }
      },
    },
    chat: {
      send: async (convId, text) => {
        calls.send.push({ convId, text });
        if (hooks.onSend) return hooks.onSend(convId, text);
        const c = convs.get(convId);
        if (!c) throw new Error('会话不存在');
        const user = userMsg(text);
        const assistant = asstMsg({ model: c.model ?? undefined });
        c.messages.push(user, assistant);
        c.updatedAt = Date.now();
        return clone({ user, assistant });
      },
      retry: async (convId) => {
        calls.retry.push(convId);
        if (hooks.onRetry) return hooks.onRetry(convId);
        const c = convs.get(convId);
        if (!c) throw new Error('会话不存在');
        const assistant = asstMsg({ model: c.model ?? undefined });
        c.messages[c.messages.length - 1] = assistant;
        c.updatedAt = Date.now();
        return clone({ assistant });
      },
      abort: async () => {},
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
        calls.settingsSet.push(patch);
        if (hooks.onSettingsSet) return hooks.onSettingsSet(patch);
        Object.assign(settings, clone(patch));
        return clone(settings);
      },
    },
  };
  return { api, emit, calls, convs };
}

type Store = typeof import('../store');

async function boot(api: AsiApi): Promise<Store> {
  vi.stubGlobal('window', { asi: api });
  vi.stubGlobal('document', { documentElement: { dataset: {} } });
  vi.resetModules();
  return import('../store');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const lastMsg = (s: Store, convId: string) => {
  const cd = s.getState().conversations[convId];
  return cd.messages[cd.messages.length - 1];
};

// ---------- delta.text 是权威完整正文，绝不拼接 ----------

describe('authoritative delta text', () => {
  it('applies e.text verbatim, including text that shrinks (redaction)', async () => {
    const c = conv('c1', { messages: [userMsg('hi')] });
    const { api, emit } = makeApi({ conversations: [c] });
    const store = await boot(api);
    await store.actions.init();

    await store.actions.send('c1', 'hello');
    const aId = lastMsg(store, 'c1').id;
    emit({ type: 'delta', conversationId: 'c1', messageId: aId, delta: 'abc', text: 'abc' });
    emit({ type: 'delta', conversationId: 'c1', messageId: aId, delta: 'def', text: 'abcdef' });
    expect(lastMsg(store, 'c1').text).toBe('abcdef');
    // 后端脱敏/重写后正文变短：直接采用 text，不拼接 delta
    emit({ type: 'delta', conversationId: 'c1', messageId: aId, delta: '', text: 'ab' });
    expect(lastMsg(store, 'c1').text).toBe('ab');
  });

  it('uses e.text for deltas that arrive before send resolves', async () => {
    const c = conv('c1');
    const { api, emit, convs } = makeApi({
      conversations: [c],
      onSend: (convId, text) => {
        const target = convs.get(convId);
        if (!target) throw new Error('会话不存在');
        const user = userMsg(text);
        const assistant = asstMsg({ model: target.model ?? undefined });
        target.messages.push(user, assistant);
        // 事件先于 send 返回到达：正文以 text 为准而不是 delta 的拼接
        emit({ type: 'delta', conversationId: convId, messageId: assistant.id, delta: 'lo', text: 'hello' });
        return clone({ user, assistant });
      },
    });
    const store = await boot(api);
    await store.actions.init();
    await store.actions.send('c1', 'hi');
    expect(lastMsg(store, 'c1').text).toBe('hello');
  });

  it('uses e.text for deltas that arrive before the conversation is loaded', async () => {
    const streaming = asstMsg();
    const c1 = conv('c1', { messages: [userMsg('a')] });
    const c2 = conv('c2', { messages: [userMsg('b'), streaming], updatedAt: Date.now() - 1000 });
    const { api, emit } = makeApi({ conversations: [c1, c2] });
    const store = await boot(api);
    await store.actions.init();
    // c2 未加载时先到 delta
    emit({ type: 'delta', conversationId: 'c2', messageId: streaming.id, delta: 'x', text: 'streamed' });
    await store.actions.selectConversation('c2');
    const m = store.getState().conversations.c2.messages.find((x) => x.id === streaming.id);
    expect(m?.text).toBe('streamed');
  });

  it('keeps terminal message when an old snapshot arrives after done', async () => {
    const a1 = asstMsg();
    const c = conv('c1', { messages: [userMsg('hi')] });
    let staleGet = false;
    const { api, emit, convs } = makeApi({
      conversations: [c],
      onSend: (convId, text) => {
        const target = convs.get(convId);
        if (!target) throw new Error('会话不存在');
        const user = userMsg(text);
        target.messages.push(user, a1);
        return clone({ user, assistant: a1 });
      },
      onGet: (id) => {
        const target = convs.get(id);
        if (!target) return null;
        const snap = clone(target);
        if (staleGet) {
          const m = snap.messages.find((x) => x.id === a1.id);
          if (m) {
            m.status = 'streaming';
            m.text = 'fin';
          }
        }
        return snap;
      },
    });
    const store = await boot(api);
    await store.actions.init();
    await store.actions.send('c1', 'hi');
    emit({
      type: 'done',
      conversationId: 'c1',
      message: { ...a1, text: 'final', status: 'done' },
    });
    staleGet = true;
    await store.actions.selectConversation('c2-does-not-exist').catch(() => {});
    await store.actions.selectConversation('c1');
    const m = store.getState().conversations.c1.messages.find((x) => x.id === a1.id);
    expect(m?.status).toBe('done');
    expect(m?.text).toBe('final');
  });
});

// ---------- chat.retry ----------

describe('actions.retry', () => {
  it('calls chat.retry, replaces only the failed assistant id, adds no user message', async () => {
    const u = userMsg('hi');
    const failed = asstMsg({ status: 'error', text: '半截', error: '厂商错误' });
    const c = conv('c1', { messages: [u, failed] });
    const { api, calls } = makeApi({ conversations: [c] });
    const store = await boot(api);
    await store.actions.init();

    await store.actions.retry('c1');
    expect(calls.retry).toEqual(['c1']);
    expect(calls.send).toEqual([]);
    const msgs = store.getState().conversations.c1.messages;
    expect(msgs).toHaveLength(2);
    expect(msgs[0].id).toBe(u.id);
    expect(msgs[1].role).toBe('assistant');
    expect(msgs[1].status).toBe('streaming');
    expect(msgs[1].id).not.toBe(failed.id);
    expect(store.getState().pendingSend.c1).toBeUndefined();
  });

  it('retries an aborted last assistant too', async () => {
    const u = userMsg('hi');
    const failed = asstMsg({ status: 'aborted', text: '半截' });
    const c = conv('c1', { messages: [u, failed] });
    const { api, calls } = makeApi({ conversations: [c] });
    const store = await boot(api);
    await store.actions.init();
    await store.actions.retry('c1');
    expect(calls.retry).toEqual(['c1']);
  });

  it('does nothing unless the last message is a failed/aborted assistant', async () => {
    const cases: ChatMessage[][] = [
      [userMsg('hi'), asstMsg({ status: 'done', text: 'ok' })],
      [userMsg('hi'), asstMsg({ status: 'streaming' })],
      [userMsg('hi'), asstMsg({ status: 'error' }), userMsg('again'), asstMsg({ status: 'done' })],
      [userMsg('hi')],
    ];
    for (const [i, messages] of cases.entries()) {
      const c = conv(`cc-${i}`, { messages });
      const { api, calls } = makeApi({ conversations: [c] });
      const store = await boot(api);
      await store.actions.init();
      await store.actions.retry(`cc-${i}`);
      expect(calls.retry).toEqual([]);
      expect(calls.send).toEqual([]);
    }
  });

  it('does nothing while a send is pending', async () => {
    const u = userMsg('hi');
    const failed = asstMsg({ status: 'error' });
    const c = conv('c1', { messages: [u, failed] });
    let release: (r: SendResult) => void = () => {};
    const gate = new Promise<SendResult>((res) => {
      release = res;
    });
    const { api, calls } = makeApi({ conversations: [c], onSend: () => gate });
    const store = await boot(api);
    await store.actions.init();
    const sending = store.actions.send('c1', 'later');
    await store.actions.retry('c1');
    expect(calls.retry).toEqual([]);
    release({ user: userMsg('later'), assistant: asstMsg() });
    await sending;
  });

  it('applies deltas that arrive before chat.retry resolves to the new placeholder', async () => {
    const u = userMsg('hi');
    const failed = asstMsg({ status: 'error' });
    const c = conv('c1', { messages: [u, failed] });
    const { api, emit, convs } = makeApi({
      conversations: [c],
      onRetry: (convId) => {
        const target = convs.get(convId);
        if (!target) throw new Error('会话不存在');
        const assistant = asstMsg({ model: target.model ?? undefined });
        target.messages[target.messages.length - 1] = assistant;
        emit({ type: 'delta', conversationId: convId, messageId: assistant.id, delta: 'lo', text: 'hello' });
        return clone({ assistant });
      },
    });
    const store = await boot(api);
    await store.actions.init();
    await store.actions.retry('c1');
    const m = lastMsg(store, 'c1');
    expect(m.id).not.toBe(failed.id);
    expect(m.text).toBe('hello');
  });

  it('a stale get snapshot cannot resurrect the removed failed message', async () => {
    const u = userMsg('hi');
    const failed = asstMsg({ status: 'error', text: 'bad', error: 'e' });
    const c = conv('c1', { messages: [u, failed] });
    const stale = clone(c);
    let gateGet = false;
    let releaseGet: (c: Conversation | null) => void = () => {};
    const { api, convs } = makeApi({
      conversations: [c],
      onGet: (id) => {
        if (id === 'c1' && gateGet) {
          return new Promise((res) => {
            releaseGet = res;
          });
        }
        const target = convs.get(id);
        return target ? clone(target) : null;
      },
    });
    const store = await boot(api);
    await store.actions.init();

    gateGet = true;
    const selecting = store.actions.selectConversation('c1');
    await store.actions.retry('c1'); // 移除 failed、换上新占位
    const replacement = lastMsg(store, 'c1');
    releaseGet(clone(stale)); // 迟到的旧快照仍包含 failed
    await selecting;

    const msgs = store.getState().conversations.c1.messages;
    expect(msgs.find((m) => m.id === failed.id)).toBeUndefined();
    expect(msgs[msgs.length - 1].id).toBe(replacement.id);
  });

  it('keeps the failed message when chat.retry rejects', async () => {
    const u = userMsg('hi');
    const failed = asstMsg({ status: 'error', text: 'bad', error: 'e' });
    const c = conv('c1', { messages: [u, failed] });
    const { api } = makeApi({
      conversations: [c],
      onRetry: () => Promise.reject(new Error('模型不可用')),
    });
    const store = await boot(api);
    await store.actions.init();
    await store.actions.retry('c1');
    const msgs = store.getState().conversations.c1.messages;
    expect(msgs[msgs.length - 1].id).toBe(failed.id);
    expect(store.getState().notice).toBe('模型不可用');
    expect(store.getState().pendingSend.c1).toBeUndefined();
  });

  it('does not resurrect a conversation deleted while retry is in flight', async () => {
    const u = userMsg('hi');
    const failed = asstMsg({ status: 'error' });
    const c = conv('c1', { messages: [u, failed] });
    let release: (r: { assistant: ChatMessage }) => void = () => {};
    const gate = new Promise<{ assistant: ChatMessage }>((res) => {
      release = res;
    });
    const { api } = makeApi({ conversations: [c], onRetry: () => gate });
    const store = await boot(api);
    await store.actions.init();
    const retrying = store.actions.retry('c1');
    await store.actions.deleteConversation('c1');
    release({ assistant: asstMsg() });
    await retrying;
    expect(store.getState().conversations.c1).toBeUndefined();
  });
});

// ---------- newConversation 复用空会话 ----------

describe('actions.newConversation', () => {
  it('reuses the current conversation when it is truly empty', async () => {
    const c = conv('c1');
    const { api, calls } = makeApi({ conversations: [c] });
    const store = await boot(api);
    await store.actions.init();
    store.actions.setDraft('c1', '未发出的草稿');
    await store.actions.newConversation();
    expect(calls.create).toBe(0);
    expect(store.getState().currentId).toBe('c1');
    expect(store.getState().drafts.c1).toBe('未发出的草稿');
  });

  it('reuses an unloaded empty conversation from the list, even if renamed', async () => {
    const c1 = conv('c1', { messages: [userMsg('hi'), asstMsg({ status: 'done', text: 'ok' })] });
    const c2 = conv('c2', { title: '改过名的空会话', model: null, updatedAt: Date.now() - 5000 });
    const { api, calls } = makeApi({ conversations: [c1, c2] });
    const store = await boot(api);
    await store.actions.init();
    expect(store.getState().currentId).toBe('c1');
    await store.actions.newConversation();
    expect(calls.create).toBe(0);
    expect(store.getState().currentId).toBe('c2');
    expect(store.getState().conversations.c2.loaded).toBe(true);
  });

  it('collapses rapid repeated clicks into a single in-flight create', async () => {
    const c1 = conv('c1', { messages: [userMsg('hi'), asstMsg({ status: 'done', text: 'ok' })] });
    const { api, calls, convs } = makeApi({ conversations: [c1] });
    const store = await boot(api);
    await store.actions.init();
    await Promise.all([store.actions.newConversation(), store.actions.newConversation()]);
    expect(calls.create).toBe(1);
    expect(convs.size).toBe(2);
  });

  it('a later selection wins over an in-flight new conversation', async () => {
    const c1 = conv('c1', { messages: [userMsg('hi'), asstMsg({ status: 'done', text: 'ok' })] });
    let release: (c: Conversation) => void = () => {};
    const gate = new Promise<Conversation>((res) => {
      release = res;
    });
    const { api } = makeApi({ conversations: [c1], onCreate: () => gate });
    const store = await boot(api);
    await store.actions.init();
    const creating = store.actions.newConversation();
    // 模拟用户在创建完成前做了别的选择使 selectionGen 前进
    await store.actions.selectConversation('c1');
    release(conv('c-new'));
    await creating;
    expect(store.getState().currentId).toBe('c1');
  });
});

// ---------- setConversationModel 自动写入默认模型 ----------

describe('actions.setConversationModel auto default', () => {
  it('sets settings.defaultModel when it is null', async () => {
    const c = conv('c1', { messages: [userMsg('hi')] });
    const { api, calls } = makeApi({
      conversations: [c],
      settings: { defaultModel: null, theme: 'system' },
    });
    const store = await boot(api);
    await store.actions.init();
    await store.actions.setConversationModel('c1', MODEL2);
    expect(store.getState().conversations.c1.model).toEqual(MODEL2);
    expect(calls.settingsSet).toEqual([{ defaultModel: MODEL2 }]);
    expect(store.getState().settings?.defaultModel).toEqual(MODEL2);
  });

  it('does not override an existing default model', async () => {
    const c = conv('c1', { messages: [userMsg('hi')] });
    const { api, calls } = makeApi({
      conversations: [c],
      settings: { defaultModel: MODEL, theme: 'system' },
    });
    const store = await boot(api);
    await store.actions.init();
    await store.actions.setConversationModel('c1', MODEL2);
    expect(store.getState().conversations.c1.model).toEqual(MODEL2);
    expect(calls.settingsSet).toEqual([]);
    expect(store.getState().settings?.defaultModel).toEqual(MODEL);
  });

  it('keeps the per-conversation model when saving the default fails', async () => {
    const c = conv('c1', { messages: [userMsg('hi')] });
    const { api } = makeApi({
      conversations: [c],
      settings: { defaultModel: null, theme: 'system' },
      onSettingsSet: () => Promise.reject(new Error('设置写入失败')),
    });
    const store = await boot(api);
    await store.actions.init();
    await store.actions.setConversationModel('c1', MODEL2);
    expect(store.getState().conversations.c1.model).toEqual(MODEL2);
    expect(store.getState().notice).toContain('设置写入失败');
  });
});

// ---------- dev mock ----------

describe('mockApi chat contract', () => {
  it('delta events carry the cumulative authoritative text', async () => {
    vi.useFakeTimers();
    const api = createMockApi();
    const events: ChatEvent[] = [];
    const off = api.chat.onEvent((e) => events.push(e));
    const { assistant } = await api.chat.send('c-welcome', '你好');
    await vi.advanceTimersByTimeAsync(60_000);
    off();
    const deltas = events.filter((e) => e.type === 'delta');
    expect(deltas.length).toBeGreaterThan(3);
    let acc = '';
    for (const d of deltas) {
      if (d.type !== 'delta') continue;
      acc += d.delta;
      expect(d.messageId).toBe(assistant.id);
      expect(d.text).toBe(acc);
    }
    const done = events.find((e) => e.type === 'done');
    expect(done?.type === 'done' && done.message.text === acc).toBe(true);
  });

  it('retry replaces the failed assistant in place without a new user message', async () => {
    vi.useFakeTimers();
    const api = createMockApi();
    const events: ChatEvent[] = [];
    api.chat.onEvent((e) => events.push(e));
    const before = await api.conversations.get('c-welcome');
    const userCount = before?.messages.filter((m) => m.role === 'user').length ?? 0;

    await api.chat.send('c-welcome', '/error 触发');
    await vi.advanceTimersByTimeAsync(60_000);
    const failed = (await api.conversations.get('c-welcome'))?.messages.at(-1);
    expect(failed?.status).toBe('error');

    const { assistant } = await api.chat.retry('c-welcome');
    expect(assistant.status).toBe('streaming');
    expect(assistant.id).not.toBe(failed?.id);

    const mid = await api.conversations.get('c-welcome');
    expect(mid?.messages.filter((m) => m.role === 'user')).toHaveLength(userCount + 1);
    expect(mid?.messages.at(-1)?.id).toBe(assistant.id);
    expect(mid?.messages.find((m) => m.id === failed?.id)).toBeUndefined();

    await vi.advanceTimersByTimeAsync(60_000);
    const after = await api.conversations.get('c-welcome');
    expect(after?.messages.at(-1)?.id).toBe(assistant.id);
    expect(after?.messages.at(-1)?.status).toBe('error'); // /error 确定性再次失败
  });

  it('retry after abort keeps the preceding user and history', async () => {
    vi.useFakeTimers();
    const api = createMockApi();
    await api.chat.send('c-welcome', '/slow 长文');
    await vi.advanceTimersByTimeAsync(200);
    await api.chat.abort('c-welcome');
    const aborted = (await api.conversations.get('c-welcome'))?.messages.at(-1);
    expect(aborted?.status).toBe('aborted');

    const { assistant } = await api.chat.retry('c-welcome');
    const mid = await api.conversations.get('c-welcome');
    const lastUser = [...(mid?.messages ?? [])].reverse().find((m) => m.role === 'user');
    expect(lastUser?.text).toBe('/slow 长文');
    expect(mid?.messages.at(-1)?.id).toBe(assistant.id);
    await vi.advanceTimersByTimeAsync(120_000);
    const done = (await api.conversations.get('c-welcome'))?.messages.at(-1);
    expect(done?.status).toBe('done');
    expect(done?.text.length).toBeGreaterThan(0);
  });

  it('retry rejects when the last message is not a failed assistant', async () => {
    vi.useFakeTimers();
    const api = createMockApi();
    await expect(api.chat.retry('c-welcome')).rejects.toThrow();
  });
});

// ---------- Markdown streaming 光标标记 ----------

// node tsconfig 没有 jsx 标记，.tsx 模块不能用静态 import；
// 用变量构造说明符让 tsc 放弃解析（运行时由 vitest 正常解析）。
const markdownModulePath = '../components/Markdown';
const { Markdown } = (await import(markdownModulePath)) as {
  Markdown: (props: { text: string; streaming?: boolean }) => ReactNode;
};

describe('Markdown streaming cursor markup', () => {
  it('marks the container as streaming so CSS can attach the cursor', () => {
    const html = renderToString(createElement(Markdown, { text: 'hi', streaming: true }));
    expect(html).toContain('md streaming');
  });

  it('renders the streaming container even for an empty message', () => {
    const html = renderToString(createElement(Markdown, { text: '', streaming: true }));
    expect(html).toContain('md streaming');
  });

  it('does not mark non-streaming content', () => {
    const html = renderToString(createElement(Markdown, { text: 'hi' }));
    expect(html).not.toContain('streaming');
  });

  it('keeps target=_blank rel=noreferrer noopener on links', () => {
    const html = renderToString(createElement(Markdown, { text: '[x](https://example.com)' }));
    expect(html).toContain('target="_blank"');
    expect(html).toContain('noreferrer');
    expect(html).toContain('noopener');
  });
});

// ---------- stream-tail：每条流式消息有且仅有一个光标标记 ----------

const tailCount = (html: string) => (html.match(/stream-tail/g) ?? []).length;
const renderMd = (text: string, streaming = true) =>
  renderToString(createElement(Markdown, { text, streaming }));

describe('Markdown stream-tail marker', () => {
  it.each([
    ['paragraph', 'hello'],
    ['paragraph after heading', '## t\n\nhello'],
    ['blockquote', '> quoted'],
    ['tight list', '- a\n- b'],
    ['nested list', '- a\n  - b'],
    ['loose list', '- a\n\n- b'],
    ['list after paragraph', 'para\n\n- a'],
    ['code block', '```ts\nconst x = 1;\n```'],
    ['table', '| a | b |\n| - | - |\n| 1 | 2 |'],
  ])('marks exactly one tail block for %s', (_label, text) => {
    const html = renderMd(text);
    expect(html).toContain('md streaming');
    expect(tailCount(html)).toBe(1);
  });

  it('marks the code inside pre so the custom block keeps the marker', () => {
    const html = renderMd('```ts\nconst x = 1;\n```');
    expect(html).toMatch(/code class="[^"]*stream-tail/);
  });

  it.each([
    ['trailing bold', '- a **bold** tail'],
    ['trailing inline code', '- a `code`'],
    ['trailing link', '- a [link](https://example.com)'],
    ['text after nested list', '- a\n  - b\n  tail'],
  ])('tight list ending in phrasing content marks the last li (%s)', (_label, text) => {
    const html = renderMd(text);
    expect(tailCount(html)).toBe(1);
    expect(html).toContain('<li class="stream-tail"');
    expect(html).not.toContain('<ul class="stream-tail"');
    expect(html).not.toContain('<p class="stream-tail"');
  });

  it('keeps link rels when the cursor lands on its li', () => {
    const html = renderMd('- a [link](https://example.com)');
    expect(html).toContain('target="_blank"');
    expect(html).toContain('noreferrer');
  });

  it('leaves the tail unmarked when the last block cannot hold a cursor', () => {
    const html = renderMd('para\n\n---');
    expect(tailCount(html)).toBe(0);
    expect(html).toContain('md streaming'); // 容器兜底光标
  });

  it('marks nothing when not streaming', () => {
    const html = renderMd('- a\n- b', false);
    expect(tailCount(html)).toBe(0);
  });
});

// ---------- dev CSP 插件 ----------

const PROD_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'self'";
const htmlWithCsp = (csp: string) =>
  `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="${csp}" /></head></html>`;

describe('dev CSP plugin', () => {
  it('only applies to the dev server, never to build output', () => {
    const plugin = devCspPlugin();
    expect(plugin.apply).toBe('serve');
    expect(plugin.transformIndexHtml).toMatchObject({ order: 'pre' });
  });

  it('relaxes only script-src and connect-src for dev', () => {
    const out = relaxCspForDev(htmlWithCsp(PROD_CSP));
    expect(out).toContain("script-src 'self' 'unsafe-inline'");
    expect(out).toContain(
      "connect-src 'self' http://localhost:* ws://localhost:* http://127.0.0.1:* ws://127.0.0.1:*",
    );
    expect(out).toContain("default-src 'self';");
    expect(out).toContain("style-src 'self' 'unsafe-inline'");
    expect(out).toContain("img-src 'self' data:;");
    expect(out).not.toContain('unsafe-eval');
  });

  it('changes nothing beyond the two dev directives', () => {
    const strict = htmlWithCsp(PROD_CSP);
    const reStrict = relaxCspForDev(strict)
      .replace("script-src 'self' 'unsafe-inline'", "script-src 'self'")
      .replace(
        "connect-src 'self' http://localhost:* ws://localhost:* http://127.0.0.1:* ws://127.0.0.1:*",
        "connect-src 'self'",
      );
    expect(reStrict).toBe(strict);
  });
});

// ---------- ProviderEditor：key 草稿与 payload 脱敏 ----------
// node 环境没有 DOM/test-renderer：用最小 mock-hooks 装置直接调用 ProviderEditor，
// 记录 hook 槽位并重渲染元素树；断言行为而非源码文本。

const editorModulePath = '../views/ProviderEditor';
const reactModulePath = 'react';
const storeModulePath = '../store';

type ElProps = Record<string, unknown> & { children?: unknown };

function findProps(node: unknown, key: string): ElProps | undefined {
  if (node === null || node === undefined || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findProps(child, key);
      if (found) return found;
    }
    return undefined;
  }
  const el = node as { props?: ElProps };
  if (el.props?.['data-testid'] === key || el.props?.id === key) return el.props;
  return findProps(el.props?.children, key);
}

function sameDeps(a: unknown[] | undefined, b: unknown[] | undefined): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((d, i) => Object.is(d, b[i]));
}

interface EditorHarness {
  store: Store;
  byTestId: (key: string) => ElProps | undefined;
  unmount: () => void;
}

function must(h: EditorHarness, key: string): ElProps {
  const props = h.byTestId(key);
  if (!props) throw new Error(`missing element ${key}`);
  return props;
}

/** 挂载 ProviderEditor：doMock react 的四个 hooks 走自记账槽位，useAppState 直连 store */
async function mountEditor(target: { id: string | null }): Promise<EditorHarness> {
  interface Slot {
    v?: unknown;
    current?: unknown;
    fn?: unknown;
    deps?: unknown[];
    cleanup?: unknown;
    effect?: () => unknown;
  }
  const slots: Slot[] = [];
  const slotOf = (i: number): Slot => {
    let slot = slots[i];
    if (!slot) {
      slot = {};
      slots[i] = slot;
    }
    return slot;
  };
  const pendingEffects: number[] = [];
  let cursor = 0;
  let mounted = true;
  let rendering = false;
  let flushing = false;
  let dirty = false;
  let tree: unknown;
  let editorFn: (props: { target: { id: string | null } }) => unknown = () => null;

  const rerender = () => {
    if (!mounted) return;
    render();
    while (dirty && mounted) {
      dirty = false;
      render();
    }
  };
  const render = () => {
    rendering = true;
    cursor = 0;
    pendingEffects.length = 0;
    tree = editorFn({ target });
    rendering = false;
    flushing = true;
    while (pendingEffects.length > 0) {
      const i = pendingEffects.shift() as number;
      const slot = slots[i];
      if (typeof slot.cleanup === 'function') (slot.cleanup as () => void)();
      slot.cleanup = slot.effect?.();
    }
    flushing = false;
  };

  vi.doMock(reactModulePath, async (importOriginal) => {
    const actual = await importOriginal<typeof import('react')>();
    return {
      ...actual,
      useState: (init: unknown) => {
        const i = cursor++;
        const slot = slotOf(i);
        if (!('v' in slot)) slot.v = typeof init === 'function' ? (init as () => unknown)() : init;
        const set = (v: unknown) => {
          slot.v = typeof v === 'function' ? (v as (p: unknown) => unknown)(slot.v) : v;
          if (!mounted) return;
          if (rendering || flushing) dirty = true;
          else rerender();
        };
        return [slot.v, set];
      },
      useRef: (init: unknown) => {
        const i = cursor++;
        const slot = slotOf(i);
        if (!('current' in slot)) slot.current = init;
        return slot;
      },
      useCallback: (fn: unknown, deps: unknown[]) => {
        const i = cursor++;
        const slot = slotOf(i);
        if (!sameDeps(slot.deps, deps)) {
          slot.fn = fn;
          slot.deps = deps;
        }
        return slot.fn;
      },
      useEffect: (fn: () => unknown, deps?: unknown[]) => {
        const i = cursor++;
        const slot = slotOf(i);
        if (!sameDeps(slot.deps, deps)) {
          slot.effect = fn;
          pendingEffects.push(i);
        }
        slot.deps = deps;
      },
    };
  });
  vi.doMock(storeModulePath, async (importOriginal) => {
    const actual = await importOriginal<typeof import('../store')>();
    return { ...actual, useAppState: () => actual.getState() };
  });
  vi.resetModules();
  const store = (await import(storeModulePath)) as Store;
  const mod = (await import(editorModulePath)) as {
    ProviderEditor: (props: { target: { id: string | null } }) => unknown;
  };
  editorFn = mod.ProviderEditor;
  // 先 init 再首渲染：useState 初值只在首次渲染时求值，catalog/providers 必须先就位
  await store.actions.init();
  render();
  return {
    store,
    byTestId: (key) => findProps(tree, key),
    unmount: () => {
      if (!mounted) return;
      mounted = false;
      for (const slot of slots) {
        if (slot && typeof slot.cleanup === 'function') (slot.cleanup as () => void)();
      }
    },
  };
}

const savedProvider: ProviderConfig = {
  id: 'p1',
  name: 'Provider One',
  kind: 'openai-compatible',
  baseUrl: 'http://localhost:9/v1',
  hasApiKey: true,
  enabled: true,
  customModels: ['m1', 'm2'],
  createdAt: 0,
};

const flushMicrotasks = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

describe('actions.saveProvider apiKey scrub', () => {
  it('deletes input.apiKey as soon as providers.save resolves, without waiting for refresh', async () => {
    const { api } = makeApi();
    const input: ProviderInput = {
      name: 'P',
      kind: 'builtin',
      builtinProvider: 'anthropic',
      apiKey: 'sk-live-1234',
      enabled: true,
      customModels: [],
    };
    let captured: ProviderInput | undefined;
    api.providers.save = async (i) => {
      captured = i;
      return clone(savedProvider);
    };
    // providers.list 永远挂起：刷新不应阻塞 payload 脱敏
    api.providers.list = () => new Promise(() => {});
    const store = await boot(api);
    const pending = store.actions.saveProvider(input);
    void pending.catch(() => {});
    await flushMicrotasks();
    expect(captured).toBe(input);
    expect('apiKey' in input).toBe(false);
    expect(input.apiKey).toBeUndefined();
  });

  it('deletes input.apiKey when providers.save rejects', async () => {
    const { api } = makeApi();
    const input: ProviderInput = {
      name: 'P',
      kind: 'builtin',
      builtinProvider: 'anthropic',
      apiKey: 'sk-live-1234',
      enabled: true,
      customModels: [],
    };
    api.providers.save = async () => {
      throw new Error('后端炸了');
    };
    const store = await boot(api);
    await expect(store.actions.saveProvider(input)).rejects.toThrow('后端炸了');
    expect('apiKey' in input).toBe(false);
  });
});

describe('ProviderEditor pending payload scrub (mock hooks)', () => {
  afterEach(() => {
    vi.doUnmock(reactModulePath);
    vi.doUnmock(storeModulePath);
    vi.resetModules();
  });

  function editorApi(saveImpl: (i: ProviderInput) => Promise<ProviderConfig>) {
    const { api } = makeApi();
    api.providers.catalog = async () => [{ id: 'b1', name: 'B1', modelCount: 1 }];
    api.providers.save = saveImpl;
    vi.stubGlobal('window', { asi: api });
    vi.stubGlobal('document', {
      documentElement: { dataset: {} },
      addEventListener: () => {},
      removeEventListener: () => {},
    });
    return api;
  }

  it('clears the draft immediately, keeps the payload key only until IPC resolves', async () => {
    let captured: ProviderInput | undefined;
    let resolveSave: (c: ProviderConfig) => void = () => {};
    const gate = new Promise<ProviderConfig>((res) => {
      resolveSave = res;
    });
    editorApi(async (i) => {
      captured = i;
      return gate;
    });
    const h = await mountEditor({ id: null });
    const node = { value: '' };
    (must(h, 'pe-apikey').ref as (n: unknown) => void)(node);
    (must(h, 'pe-apikey').onChange as (e: unknown) => void)({
      target: { value: 'sk-draft-99' },
    });
    (must(h, 'pe-save').onClick as () => void)();
    // 草稿立即清空；payload 在 IPC 解决前仍持有 key
    expect(node.value).toBe('');
    expect(captured?.apiKey).toBe('sk-draft-99');
    resolveSave(clone(savedProvider));
    await flushMicrotasks();
    expect('apiKey' in (captured as ProviderInput)).toBe(false);
    // 保存成功后关闭编辑器
    expect(h.store.getState().editor).toBeNull();
    h.unmount();
  });

  it('cancel while IPC is in flight scrubs the payload; late resolve does not close a reopened editor', async () => {
    let captured: ProviderInput | undefined;
    let resolveSave: (c: ProviderConfig) => void = () => {};
    const gate = new Promise<ProviderConfig>((res) => {
      resolveSave = res;
    });
    editorApi(async (i) => {
      captured = i;
      return gate;
    });
    const h = await mountEditor({ id: null });
    (must(h, 'pe-apikey').ref as (n: unknown) => void)({ value: '' });
    (must(h, 'pe-apikey').onChange as (e: unknown) => void)({
      target: { value: 'sk-draft-99' },
    });
    (must(h, 'pe-save').onClick as () => void)();
    expect(captured?.apiKey).toBe('sk-draft-99');
    (must(h, 'pe-cancel').onClick as () => void)();
    // 取消当下 payload 里的明文就被删掉
    expect('apiKey' in (captured as ProviderInput)).toBe(false);
    // 用户在 IPC 未决期间打开了另一个厂商的编辑器
    h.store.actions.openEditor('p1');
    resolveSave(clone(savedProvider));
    await flushMicrotasks();
    expect(h.store.getState().editor).toEqual({ id: 'p1' });
    h.unmount();
  });

  it('unmount while IPC is in flight scrubs the payload via effect cleanup', async () => {
    let captured: ProviderInput | undefined;
    const gate = new Promise<ProviderConfig>(() => {});
    editorApi(async (i) => {
      captured = i;
      return gate;
    });
    const h = await mountEditor({ id: null });
    (must(h, 'pe-apikey').onChange as (e: unknown) => void)({
      target: { value: 'sk-draft-99' },
    });
    (must(h, 'pe-save').onClick as () => void)();
    expect(captured?.apiKey).toBe('sk-draft-99');
    h.unmount();
    expect('apiKey' in (captured as ProviderInput)).toBe(false);
  });

  it('detaching the key input while IPC is in flight scrubs the payload', async () => {
    let captured: ProviderInput | undefined;
    const gate = new Promise<ProviderConfig>(() => {});
    editorApi(async (i) => {
      captured = i;
      return gate;
    });
    const h = await mountEditor({ id: null });
    (must(h, 'pe-apikey').ref as (n: unknown) => void)({ value: 'x' });
    (must(h, 'pe-apikey').onChange as (e: unknown) => void)({
      target: { value: 'sk-draft-99' },
    });
    (must(h, 'pe-save').onClick as () => void)();
    expect(captured?.apiKey).toBe('sk-draft-99');
    (must(h, 'pe-apikey').ref as (n: unknown) => void)(null);
    expect('apiKey' in (captured as ProviderInput)).toBe(false);
    h.unmount();
  });

  it('rejects a short typed key locally and shows the key error without calling save', async () => {
    let saveCalls = 0;
    editorApi(async () => {
      saveCalls += 1;
      return clone(savedProvider);
    });
    const h = await mountEditor({ id: null });
    (must(h, 'pe-apikey').onChange as (e: unknown) => void)({ target: { value: 'sk-1' } });
    (must(h, 'pe-save').onClick as () => void)();
    expect(saveCalls).toBe(0);
    expect(h.byTestId('pe-apikey')?.['aria-invalid']).toBe(true);
    expect(h.byTestId('pe-apikey')?.['aria-describedby']).toBe('pe-apikey-err');
    expect(String(h.byTestId('pe-apikey-err')?.children)).toContain('至少 8');
    h.unmount();
  });

  it('rejects a draft containing the mask placeholder without calling save', async () => {
    let saveCalls = 0;
    editorApi(async () => {
      saveCalls += 1;
      return clone(savedProvider);
    });
    const h = await mountEditor({ id: null });
    (must(h, 'pe-apikey').onChange as (e: unknown) => void)({
      target: { value: 'sk-abc[已隐藏]xyz' },
    });
    (must(h, 'pe-save').onClick as () => void)();
    expect(saveCalls).toBe(0);
    expect(String(h.byTestId('pe-apikey-err')?.children)).toContain('占位符');
    h.unmount();
  });

  it('rejects a whitespace-only key draft but treats a truly empty draft as retain', async () => {
    const calls: ProviderInput[] = [];
    editorApi(async (i) => {
      calls.push(i);
      return clone(savedProvider);
    });
    const h = await mountEditor({ id: null });
    (must(h, 'pe-apikey').onChange as (e: unknown) => void)({ target: { value: '   ' } });
    (must(h, 'pe-save').onClick as () => void)();
    expect(calls).toHaveLength(0);
    expect(String(h.byTestId('pe-apikey-err')?.children)).toContain('不能为空字符串');
    // 清空草稿后再保存：apiKey 为 undefined（新建厂商表示不设置 key）
    (must(h, 'pe-apikey').onChange as (e: unknown) => void)({ target: { value: '' } });
    (must(h, 'pe-save').onClick as () => void)();
    await flushMicrotasks();
    expect(calls).toHaveLength(1);
    expect(calls[0].apiKey).toBeUndefined();
    h.unmount();
  });
});
