import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssistantMessage, AssistantMessageEvent, Context, StreamOptions } from '@mariozechner/pi-ai';
import * as piai from '@mariozechner/pi-ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from '../../src/main/chat/chat-service';
import { ModelResolver } from '../../src/main/chat/model-resolver';
import { ConversationStore } from '../../src/main/stores/conversation-store';
import {
  FAUX_PROVIDER_ID,
  ProviderStore,
  type StorageEncryption,
} from '../../src/main/stores/provider-store';
import type { ChatEvent, ChatMessage, Conversation } from '../../src/shared/types';

vi.mock('@mariozechner/pi-ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mariozechner/pi-ai')>();
  return {
    ...actual,
    stream: vi.fn(actual.stream),
    complete: vi.fn(actual.complete),
    __actual: actual,
  };
});

const REAL = (piai as unknown as { __actual: typeof piai }).__actual;
const streamMock = vi.mocked(piai.stream);
const completeMock = vi.mocked(piai.complete);

function fakeEncryption(): StorageEncryption {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (value: string) =>
      Buffer.concat([Buffer.from('ENC|'), Buffer.from(Buffer.from(value, 'utf8').toString('base64'))]),
    decryptString: (value: Buffer) => {
      const raw = value.toString('utf8');
      if (!raw.startsWith('ENC|')) {
        throw new Error('bad cipher');
      }
      return Buffer.from(raw.slice(4), 'base64').toString('utf8');
    },
  };
}

interface Env {
  dir: string;
  providers: ProviderStore;
  conversations: ConversationStore;
  resolver: ModelResolver;
  service: ChatService;
  events: ChatEvent[];
}

const dirs: string[] = [];
const resolvers: ModelResolver[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'asi-chat-service-'));
  dirs.push(dir);
  return dir;
}

function setup(faux = true): Env {
  const dir = tempDir();
  vi.stubEnv('ASI_FAUX', faux ? '1' : '');
  vi.stubEnv('ASI_FAUX_REPLY', undefined);
  const providers = new ProviderStore(dir, fakeEncryption());
  const conversations = new ConversationStore(dir);
  const resolver = new ModelResolver();
  resolvers.push(resolver);
  const events: ChatEvent[] = [];
  const service = new ChatService(providers, conversations, resolver, (e) => events.push(e));
  return { dir, providers, conversations, resolver, service, events };
}

function fauxConv(env: Env): Conversation {
  return env.conversations.create({ providerId: FAUX_PROVIDER_ID, modelId: 'faux-chat' });
}

function msg(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: `m-${Math.random().toString(36).slice(2)}`,
    role: 'user',
    text: 'hi',
    createdAt: 1,
    ...overrides,
  };
}

async function waitFor(cond: () => boolean, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) {
      throw new Error('waitFor timeout');
    }
    await new Promise((r) => setTimeout(r, 10));
  }
}

beforeEach(() => {
  streamMock.mockImplementation(REAL.stream);
  completeMock.mockImplementation(REAL.complete);
});

afterEach(() => {
  vi.useRealTimers();
  for (const r of resolvers.splice(0)) {
    r.dispose();
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});

describe('ChatService.send validation', () => {
  it('rejects a missing conversation, empty text and unselected model without appending', async () => {
    const env = setup();
    await expect(env.service.send('nope', 'hi')).rejects.toThrow();
    const empty = env.conversations.create();
    await expect(env.service.send(empty.id, '   ')).rejects.toThrow();
    await expect(env.service.send(empty.id, 'hi')).rejects.toThrow(/模型/);
    expect(env.conversations.get(empty.id)?.messages).toEqual([]);
    expect(env.events).toEqual([]);
  });

  it('rejects when the provider is missing, disabled, the model unknown or the key unset', async () => {
    const env = setup();
    const gone = env.conversations.create({ providerId: 'missing', modelId: 'x' });
    await expect(env.service.send(gone.id, 'hi')).rejects.toThrow();

    const disabled = env.providers.save({
      name: 'Off',
      kind: 'builtin',
      builtinProvider: 'anthropic',
      apiKey: 'sk-x',
      enabled: false,
      customModels: [],
    });
    const c1 = env.conversations.create({ providerId: disabled.id, modelId: 'claude-sonnet-4-5' });
    await expect(env.service.send(c1.id, 'hi')).rejects.toThrow(/停用/);

    const noKey = env.providers.save({
      name: 'NoKey',
      kind: 'builtin',
      builtinProvider: 'anthropic',
      enabled: true,
      customModels: [],
    });
    const c2 = env.conversations.create({ providerId: noKey.id, modelId: 'claude-sonnet-4-5' });
    await expect(env.service.send(c2.id, 'hi')).rejects.toThrow(/API Key/i);

    const withKey = env.providers.save({
      name: 'Key',
      kind: 'builtin',
      builtinProvider: 'anthropic',
      apiKey: 'sk-k',
      enabled: true,
      customModels: [],
    });
    const c3 = env.conversations.create({ providerId: withKey.id, modelId: 'no-such-model' });
    await expect(env.service.send(c3.id, 'hi')).rejects.toThrow(/不存在/);

    for (const c of [gone, c1, c2, c3]) {
      expect(env.conversations.get(c.id)?.messages).toEqual([]);
    }
    expect(env.events).toEqual([]);
  });
});

describe('ChatService.send streaming', () => {
  it('returns placeholders before any event, then streams deltas to done and persists', async () => {
    const env = setup();
    // 超过 faux 单块上限（~20 字符）的回复，保证多个 text_delta
    const longReply =
      '你好，这是一个足够长的测试回复，用来保证 faux 模型把完整输出切分成多个 text delta 逐块发送。';
    vi.stubEnv('ASI_FAUX_REPLY', longReply);
    const conv = fauxConv(env);
    const { user, assistant } = await env.service.send(conv.id, 'hello');
    expect(user.status).toBe('done');
    expect(user.text).toBe('hello');
    expect(assistant.status).toBe('streaming');
    expect(assistant.text).toBe('');
    expect(assistant.model).toEqual(conv.model);
    // send 返回时事件还没开始
    expect(env.events).toEqual([]);

    await waitFor(() => env.events.some((e) => e.type === 'done'));
    const deltas = env.events.filter((e) => e.type === 'delta').map((e) => (e as { delta: string }).delta);
    expect(deltas.length).toBeGreaterThan(1);
    expect(deltas.join('')).toBe(longReply);
    const terminal = env.events.filter((e) => e.type === 'done' || e.type === 'error');
    expect(terminal).toHaveLength(1);
    const done = terminal[0];
    expect(done.type).toBe('done');
    expect(done && 'message' in done ? done.message.text : '').toBe(longReply);
    expect(done && 'message' in done ? done.message.status : '').toBe('done');

    const stored = env.conversations.get(conv.id);
    expect(stored?.messages.map((m) => m.id)).toEqual([user.id, assistant.id]);
    expect(stored?.messages[1].status).toBe('done');
    expect(stored?.messages[1].text).toBe(longReply);
    expect(stored?.title).toBe('hello');
    const raw = JSON.parse(readFileSync(join(env.dir, 'conversations', `${conv.id}.json`), 'utf8'));
    expect(raw.messages).toHaveLength(2);
    expect(raw.messages[1].text).toBe(longReply);
    expect(raw.messages[1].status).toBe('done');
    // 全新 Store 从磁盘重新加载后得到相同文本
    const reloaded = new ConversationStore(env.dir);
    expect(reloaded.get(conv.id)?.messages[1].text).toBe(longReply);
    expect(reloaded.get(conv.id)?.messages[1].status).toBe('done');
  });

  it('rejects a second send on the same conversation while active but allows overlap', async () => {
    vi.useFakeTimers();
    const env = setup();
    const a = fauxConv(env);
    const b = fauxConv(env);
    await env.service.send(a.id, '/slow');
    await expect(env.service.send(a.id, 'again')).rejects.toThrow();
    // 不同会话可以并行
    await env.service.send(b.id, 'hi');
    await vi.runAllTimersAsync();
    const aDone = env.events.find((e) => e.type === 'done' && e.conversationId === a.id);
    const bDone = env.events.find((e) => e.type === 'done' && e.conversationId === b.id);
    const aText = aDone && 'message' in aDone ? aDone.message.text : '';
    const bText = bDone && 'message' in bDone ? bDone.message.text : '';
    // /slow 的长回复和普通回复互不偷队列
    expect(Array.from(aText).length).toBeGreaterThanOrEqual(300);
    expect(bText).toBe('你好，我是测试模型。');
  });

  it('abort keeps the partial text, marks the message aborted and emits an error event', async () => {
    const env = setup();
    const conv = fauxConv(env);
    const { assistant } = await env.service.send(conv.id, '/slow');
    await waitFor(() => env.events.some((e) => e.type === 'delta'));
    const deltasAtAbort = env.events.filter((e) => e.type === 'delta').length;
    await env.service.abort(conv.id);
    await waitFor(() => env.events.some((e) => e.type === 'error'));
    const final = env.events.find((e) => e.type === 'error');
    const message = final && 'message' in final ? final.message : undefined;
    expect(message?.status).toBe('aborted');
    expect(message?.text.length).toBeGreaterThan(0);
    expect(message?.text.length).toBeLessThan(300);
    expect(message?.error).toBeTruthy();
    const stored = env.conversations.get(conv.id)?.messages.find((m) => m.id === assistant.id);
    expect(stored?.status).toBe('aborted');
    expect(stored?.text).toBe(message?.text);
    // abort 之后不再有新的 delta
    await new Promise((r) => setTimeout(r, 100));
    expect(env.events.filter((e) => e.type === 'delta').length).toBe(deltasAtAbort);
  });

  it('abort is idempotent when nothing is in flight', async () => {
    const env = setup();
    await expect(env.service.abort('no-conv')).resolves.toBeUndefined();
  });

  it('/error produces a readable error status, error event and a flushed message', async () => {
    const env = setup();
    const conv = fauxConv(env);
    await env.service.send(conv.id, '/error');
    await waitFor(() => env.events.some((e) => e.type === 'error'));
    const final = env.events.find((e) => e.type === 'error');
    const message = final && 'message' in final ? final.message : undefined;
    expect(message?.status).toBe('error');
    expect(message?.error).toBe('测试模型返回错误');
    expect(env.conversations.get(conv.id)?.messages[1].status).toBe('error');
  });

  it('sends only done history plus the new user message to the provider', async () => {
    const env = setup();
    const conv = env.conversations.create({ providerId: FAUX_PROVIDER_ID, modelId: 'faux-chat' });
    env.conversations.save({
      ...conv,
      messages: [
        msg({ id: 'u1', text: '第一条', status: 'done' }),
        msg({ id: 'a1', role: 'assistant', text: '回复一', status: 'done', model: conv.model ?? undefined }),
        msg({ id: 'a2', role: 'assistant', text: '出错', status: 'error', model: conv.model ?? undefined }),
        msg({ id: 'a3', role: 'assistant', text: '中止', status: 'aborted', model: conv.model ?? undefined }),
        msg({
          id: 'a4',
          role: 'assistant',
          text: '半截',
          status: 'streaming',
          model: conv.model ?? undefined,
        }),
        msg({ id: 'a5', role: 'assistant', text: '无状态', model: conv.model ?? undefined }),
      ],
    });
    let captured: Context | undefined;
    streamMock.mockImplementationOnce((model, ctx, options) => {
      captured = ctx;
      return REAL.stream(model, ctx, options);
    });
    await env.service.send(conv.id, '第二条');
    await waitFor(() => env.events.some((e) => e.type === 'done'));
    expect(captured).toBeDefined();
    expect(captured).not.toHaveProperty('systemPrompt');
    expect(captured).not.toHaveProperty('tools');
    const messages = captured?.messages ?? [];
    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({ role: 'user', content: '第一条' });
    expect(messages[1]).toMatchObject({ role: 'assistant' });
    const a1 = messages[1] as AssistantMessage;
    expect(a1.stopReason).toBe('stop');
    expect(a1.provider).toBe('faux');
    expect(a1.model).toBe('faux-chat');
    expect(messages[2]).toMatchObject({ role: 'user', content: '第二条' });
    // 新用户消息只出现一次
    expect(messages.filter((m) => m.role === 'user' && m.content === '第二条')).toHaveLength(1);
  });

  it('falls back to the current model metadata for unresolvable historical assistant messages', async () => {
    const env = setup();
    const conv = env.conversations.create({ providerId: FAUX_PROVIDER_ID, modelId: 'faux-chat' });
    env.conversations.save({
      ...conv,
      messages: [
        msg({ id: 'u1', text: '旧问题', status: 'done' }),
        msg({
          id: 'a1',
          role: 'assistant',
          text: '旧回复',
          status: 'done',
          model: { providerId: 'removed-provider', modelId: 'removed-model' },
        }),
      ],
    });
    let captured: Context | undefined;
    streamMock.mockImplementationOnce((model, ctx, options) => {
      captured = ctx;
      return REAL.stream(model, ctx, options);
    });
    await env.service.send(conv.id, '新问题');
    await waitFor(() => env.events.some((e) => e.type === 'done'));
    const a1 = captured?.messages[1] as AssistantMessage;
    expect(a1.provider).toBe('faux');
    expect(a1.model).toBe('faux-chat');
  });

  it('ignores thinking/tool events and only appends text_delta', async () => {
    const env = setup();
    const conv = fauxConv(env);
    streamMock.mockImplementationOnce(
      () =>
        ({
          async *[Symbol.asyncIterator]() {
            yield { type: 'thinking_start', contentIndex: 0 } as AssistantMessageEvent;
            yield { type: 'thinking_delta', contentIndex: 0, delta: 'secret-think' } as AssistantMessageEvent;
            yield { type: 'text_delta', contentIndex: 1, delta: '可见' } as AssistantMessageEvent;
            yield { type: 'text_delta', contentIndex: 1, delta: '文本' } as AssistantMessageEvent;
            yield { type: 'done', reason: 'stop', message: {} } as AssistantMessageEvent;
          },
        }) as unknown as ReturnType<typeof piai.stream>,
    );
    await env.service.send(conv.id, 'hi');
    await waitFor(() => env.events.some((e) => e.type === 'done'));
    const text = env.conversations.get(conv.id)?.messages[1].text;
    expect(text).toBe('可见文本');
    const deltas = env.events.filter((e) => e.type === 'delta');
    expect(deltas).toHaveLength(2);
  });

  it('masks the api key in provider errors', async () => {
    const env = setup();
    const provider = env.providers.save({
      name: 'Anthropic',
      kind: 'builtin',
      builtinProvider: 'anthropic',
      apiKey: 'sk-fakekey-9',
      enabled: true,
      customModels: [],
    });
    const conv = env.conversations.create({ providerId: provider.id, modelId: 'claude-sonnet-4-5' });
    streamMock.mockImplementationOnce(() => {
      throw new Error('HTTP 401 invalid api key sk-fakekey-9 supplied');
    });
    await env.service.send(conv.id, 'hi');
    await waitFor(() => env.events.some((e) => e.type === 'error'));
    const final = env.events.find((e) => e.type === 'error');
    const message = final && 'message' in final ? final.message : undefined;
    expect(message?.status).toBe('error');
    expect(message?.error).toContain('[已隐藏]');
    expect(message?.error).not.toContain('sk-fakekey-9');
    const stored = env.conversations.get(conv.id)?.messages[1];
    expect(stored?.error).not.toContain('sk-fakekey-9');
  });

  it('passes the decrypted api key explicitly to stream()', async () => {
    const env = setup();
    const provider = env.providers.save({
      name: 'Anthropic',
      kind: 'builtin',
      builtinProvider: 'anthropic',
      apiKey: 'sk-explicit-1',
      enabled: true,
      customModels: [],
    });
    const conv = env.conversations.create({ providerId: provider.id, modelId: 'claude-sonnet-4-5' });
    let options: StreamOptions | undefined;
    streamMock.mockImplementationOnce((_model, _ctx, o) => {
      options = o;
      return {
        async *[Symbol.asyncIterator]() {
          yield { type: 'done', reason: 'stop', message: {} } as AssistantMessageEvent;
        },
      } as unknown as ReturnType<typeof piai.stream>;
    });
    await env.service.send(conv.id, 'hi');
    await waitFor(() => env.events.some((e) => e.type === 'done'));
    expect(options?.apiKey).toBe('sk-explicit-1');
    expect(options?.signal).toBeInstanceOf(AbortSignal);
  });

  it('turns an iterator that ends without a terminal event into an error', async () => {
    const env = setup();
    const conv = fauxConv(env);
    streamMock.mockImplementationOnce(
      () =>
        ({
          async *[Symbol.asyncIterator]() {
            yield { type: 'text_delta', contentIndex: 0, delta: 'half' } as AssistantMessageEvent;
          },
        }) as unknown as ReturnType<typeof piai.stream>,
    );
    await env.service.send(conv.id, 'hi');
    await waitFor(() => env.events.some((e) => e.type === 'error'));
    expect(env.conversations.get(conv.id)?.messages[1].status).toBe('error');
    expect(env.conversations.get(conv.id)?.messages[1].text).toBe('half');
  });

  it('does not resurrect an externally removed conversation and emits an error event', async () => {
    const env = setup();
    const conv = fauxConv(env);
    streamMock.mockImplementationOnce(
      () =>
        ({
          async *[Symbol.asyncIterator]() {
            yield { type: 'text_delta', contentIndex: 0, delta: 'x' } as AssistantMessageEvent;
            env.conversations.remove(conv.id);
            yield { type: 'done', reason: 'stop', message: {} } as AssistantMessageEvent;
          },
        }) as unknown as ReturnType<typeof piai.stream>,
    );
    await env.service.send(conv.id, 'hi');
    await waitFor(() => env.events.some((e) => e.type === 'error'));
    expect(env.conversations.get(conv.id)).toBeNull();
    expect(existsSync(join(env.dir, 'conversations', `${conv.id}.json`))).toBe(false);
  });

  it('emits an error event when the final flush fails, without unhandled rejection', async () => {
    const env = setup();
    const conv = fauxConv(env);
    const file = join(env.dir, 'conversations', `${conv.id}.json`);
    streamMock.mockImplementationOnce(
      () =>
        ({
          async *[Symbol.asyncIterator]() {
            yield { type: 'text_delta', contentIndex: 0, delta: 'x' } as AssistantMessageEvent;
            rmSync(file);
            mkdirSync(file);
            yield { type: 'done', reason: 'stop', message: {} } as AssistantMessageEvent;
          },
        }) as unknown as ReturnType<typeof piai.stream>,
    );
    await env.service.send(conv.id, 'hi');
    await waitFor(() => env.events.some((e) => e.type === 'error'));
    const final = env.events.find((e) => e.type === 'error');
    const finalMessage = final && 'message' in final ? final.message : undefined;
    expect(finalMessage?.status).toBe('error');
    // 内存里的消息状态必须和终态事件一致，不能留下已落盘错误的 'done'
    const stored = env.conversations.get(conv.id)?.messages[1];
    expect(stored?.status).toBe('error');
    expect(stored?.error).toBe(finalMessage?.error);
    const leftovers = readdirSync(join(env.dir, 'conversations')).filter((f) => f.endsWith('.tmp'));
    expect(leftovers).toEqual([]);
    // 请求锁已释放：同一会话可以继续发新消息（校验通过、进入占位状态）
    const again = await env.service.send(conv.id, 'hi again');
    expect(again.assistant.status).toBe('streaming');
    await waitFor(() => env.events.filter((e) => e.type === 'error').length >= 2);
  });

  it('masks the api key in a terminal provider error event and preserves partial text', async () => {
    const env = setup();
    const provider = env.providers.save({
      name: 'Anthropic',
      kind: 'builtin',
      builtinProvider: 'anthropic',
      apiKey: 'sk-terminal-9',
      enabled: true,
      customModels: [],
    });
    const conv = env.conversations.create({ providerId: provider.id, modelId: 'claude-sonnet-4-5' });
    streamMock.mockImplementationOnce(
      () =>
        ({
          async *[Symbol.asyncIterator]() {
            yield { type: 'text_delta', contentIndex: 0, delta: 'partial' } as AssistantMessageEvent;
            yield {
              type: 'error',
              reason: 'error',
              error: { errorMessage: 'provider rejected key sk-terminal-9' },
            } as AssistantMessageEvent;
          },
        }) as unknown as ReturnType<typeof piai.stream>,
    );
    await env.service.send(conv.id, 'hi');
    await waitFor(() => env.events.some((e) => e.type === 'error'));
    const final = env.events.find((e) => e.type === 'error');
    const message = final && 'message' in final ? final.message : undefined;
    expect(message?.status).toBe('error');
    expect(message?.text).toBe('partial');
    expect(message?.error).toContain('[已隐藏]');
    expect(message?.error).not.toContain('sk-terminal-9');
    const stored = env.conversations.get(conv.id)?.messages[1];
    expect(stored?.status).toBe('error');
    expect(stored?.text).toBe('partial');
    expect(stored?.error).not.toContain('sk-terminal-9');
  });

  it('marks the message error and keeps partial text when the iterator throws mid-stream', async () => {
    const env = setup();
    const conv = fauxConv(env);
    streamMock.mockImplementationOnce(
      () =>
        ({
          async *[Symbol.asyncIterator]() {
            yield { type: 'text_delta', contentIndex: 0, delta: 'kept-text' } as AssistantMessageEvent;
            throw new Error('stream died');
          },
        }) as unknown as ReturnType<typeof piai.stream>,
    );
    await env.service.send(conv.id, 'hi');
    await waitFor(() => env.events.some((e) => e.type === 'error'));
    const stored = env.conversations.get(conv.id)?.messages[1];
    expect(stored?.status).toBe('error');
    expect(stored?.text).toBe('kept-text');
    expect(stored?.error).toBeTruthy();
  });

  it('does not overwrite a concurrent rename or model change when the stream finishes', async () => {
    const env = setup();
    const conv = fauxConv(env);
    const other = env.providers.save({
      name: 'Anthropic',
      kind: 'builtin',
      builtinProvider: 'anthropic',
      apiKey: 'sk-x',
      enabled: true,
      customModels: [],
    });
    await env.service.send(conv.id, 'hi');
    await waitFor(() => env.events.some((e) => e.type === 'delta'));
    env.conversations.rename(conv.id, '中途改名');
    env.conversations.setModel(conv.id, { providerId: other.id, modelId: 'claude-sonnet-4-5' });
    await waitFor(() => env.events.some((e) => e.type === 'done'));
    const stored = env.conversations.get(conv.id);
    expect(stored?.title).toBe('中途改名');
    expect(stored?.model).toEqual({ providerId: other.id, modelId: 'claude-sonnet-4-5' });
    expect(stored?.messages[1].status).toBe('done');
    expect(stored?.messages[1].text).toBe('你好，我是测试模型。');
    // 消息自身的模型快照仍是发送时的模型
    expect(stored?.messages[1].model).toEqual({ providerId: FAUX_PROVIDER_ID, modelId: 'faux-chat' });
  });

  it('persists the successful result and releases the lock when the emitter throws', async () => {
    const env = setup();
    const conv = fauxConv(env);
    const throwing = new ChatService(env.providers, env.conversations, env.resolver, () => {
      throw new Error('renderer gone');
    });
    await throwing.send(conv.id, 'hi');
    await waitFor(() => env.conversations.get(conv.id)?.messages[1].status === 'done');
    const stored = env.conversations.get(conv.id)?.messages[1];
    expect(stored?.text).toBe('你好，我是测试模型。');
    // 订阅者异常不影响锁释放，下一条消息可以正常完成
    const again = await throwing.send(conv.id, 'second');
    expect(again.assistant.status).toBe('streaming');
    await waitFor(() => env.conversations.get(conv.id)?.messages[3].status === 'done');
    expect(env.conversations.get(conv.id)?.messages).toHaveLength(4);
  });
});

describe('ChatService.test', () => {
  it('returns ok with latency for a working provider and sends a small ping', async () => {
    const env = setup();
    const result = await env.service.test(FAUX_PROVIDER_ID, 'faux-chat');
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(completeMock).toHaveBeenCalledTimes(1);
    const [_model, ctx, options] = completeMock.mock.calls[0];
    expect(ctx.messages).toHaveLength(1);
    expect(ctx.messages[0]).toMatchObject({ role: 'user', content: 'ping' });
    expect(options?.maxTokens).toBe(16);
    expect(options?.apiKey).toBe('asi-faux');
    // 测试连通不创建/修改会话
    expect(env.conversations.list()).toEqual([]);
  });

  it('returns ok:false with a masked error when the provider call fails', async () => {
    const env = setup();
    const provider = env.providers.save({
      name: 'Anthropic',
      kind: 'builtin',
      builtinProvider: 'anthropic',
      apiKey: 'sk-secret-7',
      enabled: true,
      customModels: [],
    });
    completeMock.mockImplementationOnce(async () => {
      throw new Error('HTTP 401 unauthorized: sk-secret-7');
    });
    const result = await env.service.test(provider.id, 'claude-sonnet-4-5');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('[已隐藏]');
    expect(result.error).not.toContain('sk-secret-7');
  });

  it('masks the api key when complete resolves with a provider error message', async () => {
    const env = setup();
    const provider = env.providers.save({
      name: 'Anthropic',
      kind: 'builtin',
      builtinProvider: 'anthropic',
      apiKey: 'sk-resolved-7',
      enabled: true,
      customModels: [],
    });
    completeMock.mockImplementationOnce(
      async () =>
        ({
          stopReason: 'error',
          errorMessage: 'provider denied sk-resolved-7',
        }) as AssistantMessage,
    );
    const result = await env.service.test(provider.id, 'claude-sonnet-4-5');
    expect(result.ok).toBe(false);
    expect(result.error).toContain('[已隐藏]');
    expect(result.error).not.toContain('sk-resolved-7');
  });

  it('supports concurrent faux test() calls without stealing response queues', async () => {
    const env = setup();
    const [r1, r2] = await Promise.all([
      env.service.test(FAUX_PROVIDER_ID, 'faux-chat'),
      env.service.test(FAUX_PROVIDER_ID, 'faux-chat'),
    ]);
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    expect(completeMock).toHaveBeenCalledTimes(2);
  });

  it('supports a faux test() overlapping a send on another conversation', async () => {
    const env = setup();
    const conv = fauxConv(env);
    const [result] = await Promise.all([
      env.service.test(FAUX_PROVIDER_ID, 'faux-chat'),
      env.service.send(conv.id, 'hi'),
    ]);
    expect(result.ok).toBe(true);
    await waitFor(() => env.events.some((e) => e.type === 'done'));
    expect(env.conversations.get(conv.id)?.messages[1].text).toBe('你好，我是测试模型。');
  });

  it('returns ok:false for missing provider, disabled provider, unknown model and missing key', async () => {
    const env = setup();
    expect((await env.service.test('missing', 'x')).ok).toBe(false);

    const disabled = env.providers.save({
      name: 'Off',
      kind: 'builtin',
      builtinProvider: 'anthropic',
      apiKey: 'sk-x',
      enabled: false,
      customModels: [],
    });
    expect((await env.service.test(disabled.id, 'claude-sonnet-4-5')).ok).toBe(false);

    const noKey = env.providers.save({
      name: 'NoKey',
      kind: 'builtin',
      builtinProvider: 'anthropic',
      enabled: true,
      customModels: [],
    });
    expect((await env.service.test(noKey.id, 'claude-sonnet-4-5')).ok).toBe(false);
    const noKeyResult = await env.service.test(noKey.id, 'no-model');
    expect(noKeyResult.ok).toBe(false);

    const withKey = env.providers.save({
      name: 'Key',
      kind: 'builtin',
      builtinProvider: 'anthropic',
      apiKey: 'sk-k',
      enabled: true,
      customModels: [],
    });
    expect((await env.service.test(withKey.id, 'no-such-model')).ok).toBe(false);
    expect(completeMock).not.toHaveBeenCalled();
  });

  it('enforces the 15s timeout on a non-cooperative complete and leaks no timer', async () => {
    vi.useFakeTimers();
    const env = setup();
    const provider = env.providers.save({
      name: 'Anthropic',
      kind: 'builtin',
      builtinProvider: 'anthropic',
      apiKey: 'sk-k',
      enabled: true,
      customModels: [],
    });
    completeMock.mockImplementationOnce(() => new Promise<AssistantMessage>(() => {}));
    const pending = env.service.test(provider.id, 'claude-sonnet-4-5');
    await vi.advanceTimersByTimeAsync(15000);
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.error).toContain('超时');
    expect(vi.getTimerCount()).toBe(0);
  });
});
