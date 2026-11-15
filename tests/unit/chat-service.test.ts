import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

/** keys.json 里直接落一条密文条目用的编码（与 fakeEncryption 互逆） */
function fakeCipher(value: string): string {
  return Buffer.concat([
    Buffer.from('ENC|'),
    Buffer.from(Buffer.from(value, 'utf8').toString('base64')),
  ]).toString('base64');
}

/** 统计 decryptString 次数的加密实现：断言流式期间不做逐 delta 解密、每条密文只解密一次 */
function countingEncryption(): {
  enc: StorageEncryption;
  counts: { decrypt: number; perCipher: Map<string, number> };
} {
  const base = fakeEncryption();
  const counts = { decrypt: 0, perCipher: new Map<string, number>() };
  return {
    enc: {
      isEncryptionAvailable: base.isEncryptionAvailable,
      encryptString: base.encryptString,
      decryptString: (value: Buffer) => {
        counts.decrypt += 1;
        const cipher = value.toString('base64');
        counts.perCipher.set(cipher, (counts.perCipher.get(cipher) ?? 0) + 1);
        return base.decryptString(value);
      },
    },
    counts,
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

function setup(faux = true, enc: StorageEncryption = fakeEncryption()): Env {
  const dir = tempDir();
  vi.stubEnv('ASI_FAUX', faux ? '1' : '');
  vi.stubEnv('ASI_FAUX_REPLY', undefined);
  vi.stubEnv('ASI_DATA_DIR', dir);
  const providers = new ProviderStore(dir, enc);
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
      apiKey: 'sk-x-aaaa',
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
      apiKey: 'sk-k-aaaa',
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
      apiKey: 'sk-x-aaaa',
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
    expect(options?.maxTokens).toBe(64);
    expect(options?.apiKey).toBe('asi-faux');
    // 测试连通不创建/修改会话
    expect(env.conversations.list()).toEqual([]);
  });

  it('accepts an empty-content reply truncated by the token cap as ok', async () => {
    const env = setup();
    // maxTokens 顶满时厂商可能返回 stopReason:'length' 且零内容的回复：连通本身已验证
    completeMock.mockResolvedValueOnce(piai.fauxAssistantMessage([], { stopReason: 'length' }));
    const result = await env.service.test(FAUX_PROVIDER_ID, 'faux-chat');
    expect(result.ok).toBe(true);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    expect(result.error).toBeUndefined();
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

  it('masks snapshot keys in static errors like missing provider', async () => {
    const env = setup();
    // 遗留已存 key 恰好与静态错误文本相同：静态出口也必须过最终脱敏
    vi.spyOn(env.providers, 'getKeySnapshot').mockReturnValue({
      redactionKeys: ['厂商不存在'],
      getApiKey: () => undefined,
    });
    const result = await env.service.test('missing', 'x');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('[已隐藏]');
    expect(result.error).not.toContain('厂商不存在');
  });

  it('masks the 测试失败 fallback when stopReason is error with an empty message', async () => {
    const env = setup();
    const provider = env.providers.save({
      name: 'Anthropic',
      kind: 'builtin',
      builtinProvider: 'anthropic',
      apiKey: 'sk-fallback-9',
      enabled: true,
      customModels: [],
    });
    vi.spyOn(env.providers, 'getKeySnapshot').mockReturnValue({
      redactionKeys: ['测试失败', 'sk-fallback-9'],
      getApiKey: () => 'sk-fallback-9',
    });
    completeMock.mockImplementationOnce(
      async () => ({ stopReason: 'error', errorMessage: '' }) as AssistantMessage,
    );
    const result = await env.service.test(provider.id, 'claude-sonnet-4-5');
    expect(result.ok).toBe(false);
    // 兜底串本身命中已存 key：整串被脱敏
    expect(result.error).toBe('[已隐藏]');
  });

  it('masks active and snapshotted saved keys in thrown errors even if a provider is deleted mid-test', async () => {
    const env = setup();
    const other = env.providers.save({
      name: 'Other',
      kind: 'builtin',
      builtinProvider: 'anthropic',
      apiKey: 'sk-other-88',
      enabled: true,
      customModels: [],
    });
    const target = env.providers.save({
      name: 'Target',
      kind: 'builtin',
      builtinProvider: 'anthropic',
      apiKey: 'sk-active-8',
      enabled: true,
      customModels: [],
    });
    completeMock.mockImplementationOnce(async () => {
      // 测试挂起期间删除另一个厂商：其 key 仍受请求快照保护
      env.providers.remove(other.id);
      throw new Error('leak sk-active-8 and sk-other-88');
    });
    const result = await env.service.test(target.id, 'claude-sonnet-4-5');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('leak [已隐藏] and [已隐藏]');
  });

  it('masks active and snapshotted saved keys in stopReason errors even if a provider is deleted mid-test', async () => {
    const env = setup();
    const other = env.providers.save({
      name: 'Other',
      kind: 'builtin',
      builtinProvider: 'anthropic',
      apiKey: 'sk-other-88',
      enabled: true,
      customModels: [],
    });
    const target = env.providers.save({
      name: 'Target',
      kind: 'builtin',
      builtinProvider: 'anthropic',
      apiKey: 'sk-active-8',
      enabled: true,
      customModels: [],
    });
    completeMock.mockImplementationOnce(async () => {
      env.providers.remove(other.id);
      return {
        stopReason: 'error',
        errorMessage: 'deny sk-active-8 / sk-other-88',
      } as AssistantMessage;
    });
    const result = await env.service.test(target.id, 'claude-sonnet-4-5');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('deny [已隐藏] / [已隐藏]');
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
      apiKey: 'sk-x-aaaa',
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
      apiKey: 'sk-k-aaaa',
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
      apiKey: 'sk-k-aaaa',
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

/** 用自定义分片序列构造一次性 mock 流，尾态可选 done/error */
function streamDeltas(deltas: string[], tail: 'done' | { error: string } = 'done'): void {
  streamMock.mockImplementationOnce(
    () =>
      ({
        async *[Symbol.asyncIterator]() {
          for (const delta of deltas) {
            yield { type: 'text_delta', contentIndex: 0, delta } as AssistantMessageEvent;
          }
          if (tail === 'done') {
            yield { type: 'done', reason: 'stop', message: {} } as AssistantMessageEvent;
          } else {
            yield {
              type: 'error',
              reason: 'error',
              error: { errorMessage: tail.error },
            } as AssistantMessageEvent;
          }
        },
      }) as unknown as ReturnType<typeof piai.stream>,
  );
}

/** 带 key 的 builtin 厂商会话（stream 已被 mock，不会真实联网） */
function keyedConv(env: Env, apiKey: string): { providerId: string; conv: Conversation } {
  const provider = env.providers.save({
    name: 'Anthropic',
    kind: 'builtin',
    builtinProvider: 'anthropic',
    apiKey,
    enabled: true,
    customModels: [],
  });
  const conv = env.conversations.create({ providerId: provider.id, modelId: 'claude-sonnet-4-5' });
  return { providerId: provider.id, conv };
}

function deltaTexts(events: ChatEvent[]): string[] {
  return events.filter((e) => e.type === 'delta').map((e) => (e as { delta: string }).delta);
}

function deltaCumulatives(events: ChatEvent[]): string[] {
  return events.filter((e) => e.type === 'delta').map((e) => (e as { text: string }).text);
}

function terminalMessage(events: ChatEvent[]): ChatMessage | undefined {
  const t = events.find((e) => e.type === 'done' || e.type === 'error');
  return t && 'message' in t ? t.message : undefined;
}

describe('ChatService.retry', () => {
  function seed(
    env: Env,
    messages: ChatMessage[],
    model = { providerId: FAUX_PROVIDER_ID, modelId: 'faux-chat' },
  ): Conversation {
    const conv = env.conversations.create(model);
    const snap = env.conversations.get(conv.id);
    env.conversations.save({ ...(snap as Conversation), messages });
    return conv;
  }

  it('retries the last error turn: same user message, new assistant id, done result', async () => {
    const env = setup();
    const conv = seed(env, [
      msg({ id: 'u1', text: '你好', status: 'done' }),
      msg({ id: 'a1', role: 'assistant', text: '', status: 'error', error: '挂了' }),
    ]);
    const { assistant } = await env.service.retry(conv.id);
    expect(assistant.status).toBe('streaming');
    expect(assistant.id).not.toBe('a1');
    expect(env.events).toEqual([]);
    await waitFor(() => env.events.some((e) => e.type === 'done'));
    const stored = env.conversations.get(conv.id);
    expect(stored?.messages.map((m) => m.id)).toEqual(['u1', assistant.id]);
    expect(stored?.messages[0].text).toBe('你好');
    expect(stored?.messages[1].status).toBe('done');
    expect(stored?.messages[1].text).toBe('你好，我是测试模型。');
    const raw = JSON.parse(readFileSync(join(env.dir, 'conversations', `${conv.id}.json`), 'utf8'));
    expect(raw.messages).toHaveLength(2);
    expect(raw.messages[1].status).toBe('done');
  });

  it('retries the last aborted turn to completion', async () => {
    const env = setup();
    const conv = seed(env, [
      msg({ id: 'u1', text: '你好', status: 'done' }),
      msg({ id: 'a1', role: 'assistant', text: '半截', status: 'aborted', error: '已停止' }),
    ]);
    const { assistant } = await env.service.retry(conv.id);
    await waitFor(() => env.events.some((e) => e.type === 'done'));
    const stored = env.conversations.get(conv.id);
    expect(stored?.messages.map((m) => m.id)).toEqual(['u1', assistant.id]);
    expect(stored?.messages[1].status).toBe('done');
  });

  it('sends exactly the prior done history to the provider, skipping older failures', async () => {
    const env = setup();
    const conv = seed(env, [
      msg({ id: 'u1', text: '第一条', status: 'done' }),
      msg({ id: 'a1', role: 'assistant', text: '回复一', status: 'done' }),
      msg({ id: 'ax', role: 'assistant', text: '更早的失败', status: 'error', error: 'x' }),
      msg({ id: 'u2', text: '第二条', status: 'done' }),
      msg({ id: 'a2', role: 'assistant', text: '', status: 'error', error: '失败' }),
    ]);
    let captured: Context | undefined;
    streamMock.mockImplementationOnce((model, ctx, options) => {
      captured = ctx;
      return REAL.stream(model, ctx, options);
    });
    await env.service.retry(conv.id);
    await waitFor(() => env.events.some((e) => e.type === 'done'));
    const messages = captured?.messages ?? [];
    // 上下文 = 被删 assistant 之前的 done 历史：更早的 error 不计入，也不追加新的 user 消息
    expect(messages).toHaveLength(3);
    expect(messages[0]).toMatchObject({ role: 'user', content: '第一条' });
    expect(messages[1]).toMatchObject({ role: 'assistant' });
    expect(messages[2]).toMatchObject({ role: 'user', content: '第二条' });
    expect(messages.filter((m) => m.role === 'user' && m.content === '第二条')).toHaveLength(1);
  });

  it('rejects when the last message is not a failed/aborted assistant', async () => {
    const env = setup();
    const done = seed(env, [
      msg({ id: 'u1', status: 'done' }),
      msg({ id: 'a1', role: 'assistant', text: 'ok', status: 'done' }),
    ]);
    const userTail = seed(env, [msg({ id: 'u2', status: 'done' })]);
    const empty = seed(env, []);
    const streaming = seed(env, [
      msg({ id: 'u3', status: 'done' }),
      msg({ id: 'a3', role: 'assistant', text: 'x', status: 'streaming' }),
    ]);
    for (const conv of [done, userTail, empty, streaming]) {
      await expect(env.service.retry(conv.id)).rejects.toThrow();
    }
    await expect(env.service.retry('missing')).rejects.toThrow();
    // 全部未发生变更
    expect(env.conversations.get(done.id)?.messages).toHaveLength(2);
    expect(env.conversations.get(userTail.id)?.messages).toHaveLength(1);
    expect(env.conversations.get(streaming.id)?.messages[1].status).toBe('streaming');
    expect(env.events).toEqual([]);
  });

  it('rejects while a request is active, without mutating the failed message', async () => {
    vi.useFakeTimers();
    const env = setup();
    // 先发一条 send 占住会话锁（底层流挂起），retry 必须立即被拒且不改动
    streamMock.mockImplementationOnce(
      () =>
        ({
          async *[Symbol.asyncIterator]() {
            yield { type: 'text_delta', contentIndex: 0, delta: 'x' } as AssistantMessageEvent;
            await new Promise(() => {});
          },
        }) as unknown as ReturnType<typeof piai.stream>,
    );
    const conv = seed(env, [msg({ id: 'u1', text: 'hi', status: 'done' })]);
    await env.service.send(conv.id, 'again');
    await vi.advanceTimersByTimeAsync(0);
    await expect(env.service.retry(conv.id)).rejects.toThrow();
    // 消息未被改动：u1 + send 追加的 user + 进行中的 streaming assistant
    const stored = env.conversations.get(conv.id);
    expect(stored?.messages).toHaveLength(3);
    expect(stored?.messages[2].status).toBe('streaming');
    // 清理：强制终结释放锁
    const aborting = env.service.abort(conv.id);
    await vi.advanceTimersByTimeAsync(2000);
    await aborting;
  });

  it('rejects and preserves the failed message when the provider validation fails', async () => {
    const env = setup();
    const noKey = env.providers.save({
      name: 'NoKey',
      kind: 'builtin',
      builtinProvider: 'anthropic',
      enabled: true,
      customModels: [],
    });
    const conv = seed(
      env,
      [
        msg({ id: 'u1', status: 'done' }),
        msg({ id: 'a1', role: 'assistant', text: '', status: 'error', error: 'x' }),
      ],
      { providerId: noKey.id, modelId: 'claude-sonnet-4-5' },
    );
    await expect(env.service.retry(conv.id)).rejects.toThrow(/API Key/i);
    const stored = env.conversations.get(conv.id);
    expect(stored?.messages.map((m) => m.id)).toEqual(['u1', 'a1']);
    expect(stored?.messages[1].status).toBe('error');
    expect(env.events).toEqual([]);
  });
});

describe('ChatService key masking (cross-chunk)', () => {
  const KEY = 'sk-ABCDEFGH';

  it('masks a whole key arriving in a single chunk, in events, snapshot and on disk', async () => {
    const env = setup();
    const { conv } = keyedConv(env, KEY);
    streamDeltas([`正文${KEY}尾巴`]);
    await env.service.send(conv.id, 'hi');
    await waitFor(() => env.events.some((e) => e.type === 'done'));
    const final = terminalMessage(env.events);
    expect(final?.text).toBe('正文[已隐藏]尾巴');
    for (const e of env.events) {
      expect(JSON.stringify(e)).not.toContain(KEY);
    }
    const stored = env.conversations.get(conv.id);
    expect(stored?.messages[1].text).not.toContain(KEY);
    const raw = readFileSync(join(env.dir, 'conversations', `${conv.id}.json`), 'utf8');
    expect(raw).not.toContain(KEY);
  });

  it('masks the key at every two-chunk split boundary', async () => {
    for (let i = 1; i < KEY.length; i++) {
      const env = setup();
      const { conv } = keyedConv(env, KEY);
      streamDeltas([`pre${KEY.slice(0, i)}`, `${KEY.slice(i)}post`]);
      await env.service.send(conv.id, 'hi');
      await waitFor(() => env.events.some((e) => e.type === 'done' || e.type === 'error'));
      const final = terminalMessage(env.events);
      expect(final?.text, `split at ${i}`).toBe('pre[已隐藏]post');
      for (const e of env.events) {
        expect(JSON.stringify(e), `split at ${i}`).not.toContain(KEY);
      }
    }
  });

  it('masks the key across single-character delta fragments', async () => {
    const env = setup();
    const { conv } = keyedConv(env, KEY);
    streamDeltas([...KEY]);
    await env.service.send(conv.id, 'hi');
    await waitFor(() => env.events.some((e) => e.type === 'done'));
    const final = terminalMessage(env.events);
    expect(final?.text).toBe('[已隐藏]');
    for (const e of env.events) {
      expect(JSON.stringify(e)).not.toContain(KEY);
    }
  });

  it('masks repeated and adjacent occurrences of the key', async () => {
    const env = setup();
    const { conv } = keyedConv(env, KEY);
    streamDeltas([`${KEY}${KEY}`, `x${KEY.slice(0, 4)}`, KEY.slice(4)]);
    await env.service.send(conv.id, 'hi');
    await waitFor(() => env.events.some((e) => e.type === 'done'));
    expect(terminalMessage(env.events)?.text).toBe('[已隐藏][已隐藏]x[已隐藏]');
  });

  it('masks even a short legacy key in text and errors (defense in depth)', async () => {
    // 遗留数据里可能存在短 key：save 已拒收，这里只 mock 快照模拟遗留读取
    const env = setup();
    const SHORT = 'short-7';
    const { conv } = keyedConv(env, 'sk-legacy-9');
    vi.spyOn(env.providers, 'getKeySnapshot').mockReturnValue({
      redactionKeys: ['sk-legacy-9'],
      getApiKey: () => SHORT,
    });
    streamDeltas([`echo ${SHORT}`], { error: `denied ${SHORT}` });
    await env.service.send(conv.id, 'hi');
    await waitFor(() => env.events.some((e) => e.type === 'error'));
    const final = terminalMessage(env.events);
    expect(final?.text).toBe(`echo ${'[已隐藏]'}`);
    expect(final?.error).toBe(`denied ${'[已隐藏]'}`);
    for (const e of env.events) {
      expect(JSON.stringify(e)).not.toContain(SHORT);
    }
    const stored = env.conversations.get(conv.id)?.messages[1];
    expect(stored?.text).not.toContain(SHORT);
    expect(stored?.error).not.toContain(SHORT);
  });

  it('masks another provider saved key echoed by the active provider', async () => {
    const env = setup();
    const OTHER = 'sk-other-secret';
    env.providers.save({
      name: 'Other Provider',
      kind: 'builtin',
      builtinProvider: 'anthropic',
      apiKey: OTHER,
      enabled: true,
      customModels: [],
    });
    const { conv } = keyedConv(env, KEY);
    streamDeltas([`leak ${OTHER} here`], { error: `denied ${OTHER}` });
    await env.service.send(conv.id, 'hi');
    await waitFor(() => env.events.some((e) => e.type === 'error'));
    const final = terminalMessage(env.events);
    expect(final?.text).toBe('leak [已隐藏] here');
    expect(final?.error).toBe('denied [已隐藏]');
    for (const e of env.events) {
      expect(JSON.stringify(e)).not.toContain(OTHER);
    }
    expect(env.conversations.get(conv.id)?.messages[1].text).not.toContain(OTHER);
  });

  it('keeps protecting the request-start key after mid-stream deletion; a mid-stream saved key is protected only from the next request', async () => {
    const env = setup();
    const ROTATED = 'sk-rotated-9';
    const { providerId, conv } = keyedConv(env, KEY);
    let replacementId = '';
    streamMock.mockImplementationOnce(
      () =>
        ({
          async *[Symbol.asyncIterator]() {
            // 流式进行中：厂商被删除 → 又被另一个厂商顶替保存了新 key
            env.providers.remove(providerId);
            replacementId = env.providers.save({
              name: 'Replacement',
              kind: 'builtin',
              builtinProvider: 'anthropic',
              apiKey: ROTATED,
              enabled: true,
              customModels: [],
            }).id;
            yield { type: 'text_delta', contentIndex: 0, delta: `old${KEY}` } as AssistantMessageEvent;
            yield {
              type: 'text_delta',
              contentIndex: 0,
              delta: `new${ROTATED}`,
            } as AssistantMessageEvent;
            yield { type: 'done', reason: 'stop', message: {} } as AssistantMessageEvent;
          },
        }) as unknown as ReturnType<typeof piai.stream>,
    );
    await env.service.send(conv.id, 'hi');
    await waitFor(() => env.events.some((e) => e.type === 'done' || e.type === 'error'));
    const final = terminalMessage(env.events);
    // 起始快照里的 key 依然受保护；中途新保存的 key 本请求内有意不脱敏（下一次请求生效）
    expect(final?.text).toBe(`old[已隐藏]new${ROTATED}`);
    for (const e of env.events) {
      expect(JSON.stringify(e)).not.toContain(KEY);
    }
    expect(env.conversations.get(conv.id)?.messages[1].text).not.toContain(KEY);

    // 下一次请求的快照覆盖新 key：即使被分片切开也脱敏
    env.conversations.setModel(conv.id, {
      providerId: replacementId,
      modelId: 'claude-sonnet-4-5',
    });
    const eventCount = env.events.length;
    streamDeltas([ROTATED.slice(0, 5), ROTATED.slice(5), ' tail']);
    await env.service.send(conv.id, 'again');
    await waitFor(() => env.events.filter((e) => e.type === 'done').length >= 2);
    const later = env.events.slice(eventCount);
    const final2 = terminalMessage(later);
    expect(final2?.text).toBe('[已隐藏] tail');
    for (const e of later) {
      expect(JSON.stringify(e)).not.toContain(ROTATED);
    }
    expect(env.conversations.get(conv.id)?.messages[3].text).toBe('[已隐藏] tail');
  });

  it('masks a secret-bearing error from a failed persistence flush', async () => {
    const env = setup();
    const { conv } = keyedConv(env, KEY);
    streamDeltas(['ok']);
    vi.spyOn(env.conversations, 'flush').mockImplementation(() => {
      throw new Error(`disk io near ${KEY}`);
    });
    await env.service.send(conv.id, 'hi');
    await waitFor(() => env.events.some((e) => e.type === 'error'));
    const final = terminalMessage(env.events);
    expect(final?.status).toBe('error');
    expect(final?.error).toBe('disk io near [已隐藏]');
    for (const e of env.events) {
      expect(JSON.stringify(e)).not.toContain(KEY);
    }
  });

  it('emits benign text promptly: only a potential key-prefix tail is withheld', async () => {
    const env = setup();
    const { conv } = keyedConv(env, KEY);
    streamDeltas(['你好世界', `正常文本${KEY.slice(0, 3)}`, '继续']);
    await env.service.send(conv.id, 'hi');
    await waitFor(() => env.events.some((e) => e.type === 'done'));
    const deltas = deltaTexts(env.events);
    // 第一块完整放出；第二块放出正常文本但扣留 'sk-'；第三块发现不是 key 后放出剩余
    expect(deltas[0]).toBe('你好世界');
    expect(deltas[1]).toBe('正常文本');
    expect(deltas.join('')).toBe(`你好世界正常文本${KEY.slice(0, 3)}继续`);
    expect(terminalMessage(env.events)?.text).toBe(`你好世界正常文本${KEY.slice(0, 3)}继续`);
  });

  it('masks a streamed key before an error, and masks the secret inside the error text', async () => {
    const env = setup();
    const { conv } = keyedConv(env, KEY);
    streamDeltas([KEY.slice(0, 5), KEY.slice(5), 'more'], { error: `HTTP 401 ${KEY}` });
    await env.service.send(conv.id, 'hi');
    await waitFor(() => env.events.some((e) => e.type === 'error'));
    const final = terminalMessage(env.events);
    expect(final?.status).toBe('error');
    expect(final?.text).not.toContain(KEY);
    expect(final?.text).toBe('[已隐藏]more');
    expect(final?.error).not.toContain(KEY);
    expect(final?.error).toBe('HTTP 401 [已隐藏]');
    const stored = env.conversations.get(conv.id)?.messages[1];
    expect(stored?.text).not.toContain(KEY);
    expect(stored?.error).not.toContain(KEY);
  });

  it('masks on abort after a split key and flushes a pending key-prefix into the final message', async () => {
    const env = setup();
    const { conv } = keyedConv(env, KEY);
    streamMock.mockImplementationOnce(
      () =>
        ({
          async *[Symbol.asyncIterator]() {
            yield {
              type: 'text_delta',
              contentIndex: 0,
              delta: `ok${KEY.slice(0, 4)}`,
            } as AssistantMessageEvent;
            yield { type: 'text_delta', contentIndex: 0, delta: KEY.slice(4) } as AssistantMessageEvent;
            yield {
              type: 'text_delta',
              contentIndex: 0,
              delta: `safe${KEY.slice(0, 3)}`,
            } as AssistantMessageEvent;
            await new Promise(() => {});
          },
        }) as unknown as ReturnType<typeof piai.stream>,
    );
    const { assistant } = await env.service.send(conv.id, 'hi');
    // 等全部三块都消费完（'safe' 已放出、'sk-' 仍被扣留）再中止
    await waitFor(() => deltaTexts(env.events).join('').includes('safe'));
    const deltasBeforeAbort = deltaTexts(env.events).length;
    await env.service.abort(conv.id);
    const stored = env.conversations.get(conv.id)?.messages.find((m) => m.id === assistant.id);
    expect(stored?.status).toBe('aborted');
    // 完整 key 已脱敏；尾部残留的 key 前缀片段原样保留在终态消息中（不是完整 key）
    expect(stored?.text).not.toContain(KEY);
    expect(stored?.text).toBe(`ok[已隐藏]safe${KEY.slice(0, 3)}`);
    // abort 不为尾部补发 delta
    expect(deltaTexts(env.events)).toHaveLength(deltasBeforeAbort);
    for (const e of env.events) {
      expect(JSON.stringify(e)).not.toContain(KEY);
    }
  });

  it('masks the key when the iterator throws mid-stream', async () => {
    const env = setup();
    const { conv } = keyedConv(env, KEY);
    streamMock.mockImplementationOnce(
      () =>
        ({
          async *[Symbol.asyncIterator]() {
            yield { type: 'text_delta', contentIndex: 0, delta: KEY.slice(0, 6) } as AssistantMessageEvent;
            throw new Error(`boom ${KEY}`);
          },
        }) as unknown as ReturnType<typeof piai.stream>,
    );
    await env.service.send(conv.id, 'hi');
    await waitFor(() => env.events.some((e) => e.type === 'error'));
    const final = terminalMessage(env.events);
    expect(final?.error).toBe('boom [已隐藏]');
    expect(final?.text).not.toContain(KEY);
    // 抛错前扣留的前缀经 flush 后进入正文（key 片段，安全）
    expect(final?.text).toBe(KEY.slice(0, 6));
    for (const e of env.events) {
      expect(JSON.stringify(e)).not.toContain(KEY);
    }
  });

  it('masks the key in connectivity-test errors', async () => {
    const env = setup();
    const provider = env.providers.save({
      name: 'Anthropic',
      kind: 'builtin',
      builtinProvider: 'anthropic',
      apiKey: KEY,
      enabled: true,
      customModels: [],
    });
    completeMock.mockImplementationOnce(async () => {
      throw new Error(`unauthorized ${KEY}`);
    });
    const result = await env.service.test(provider.id, 'claude-sonnet-4-5');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('unauthorized [已隐藏]');
  });

  it('delta.text is the authoritative cumulative text and resumes after a snapshot', async () => {
    const env = setup();
    const { conv } = keyedConv(env, KEY);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    streamMock.mockImplementationOnce(
      () =>
        ({
          async *[Symbol.asyncIterator]() {
            yield { type: 'text_delta', contentIndex: 0, delta: 'abc' } as AssistantMessageEvent;
            yield { type: 'text_delta', contentIndex: 0, delta: KEY.slice(0, 4) } as AssistantMessageEvent;
            await gate;
            yield {
              type: 'text_delta',
              contentIndex: 0,
              delta: `${KEY.slice(4)}tail`,
            } as AssistantMessageEvent;
            yield { type: 'done', reason: 'stop', message: {} } as AssistantMessageEvent;
          },
        }) as unknown as ReturnType<typeof piai.stream>,
    );
    const { assistant } = await env.service.send(conv.id, 'hi');
    // 'abc' 已放出；'sk-A'（key 前缀）被扣留未发
    await waitFor(() => deltaTexts(env.events).length === 1);
    // 中途快照：get() 的正文 = 已安全放出的累计文本
    const snapshot = env.conversations.get(conv.id)?.messages.find((m) => m.id === assistant.id);
    expect(snapshot?.text).toBe('abc');
    release?.();
    await waitFor(() => env.events.some((e) => e.type === 'done'));
    const deltas = deltaTexts(env.events);
    const cumulatives = deltaCumulatives(env.events);
    let expected = '';
    for (const [i, delta] of deltas.entries()) {
      expected += delta;
      // 每个 delta 事件的 text 都是截至此刻的完整累计正文
      expect(cumulatives[i]).toBe(expected);
    }
    const final = terminalMessage(env.events);
    expect(final?.text).toBe(expected);
    // 快照前缀 + 后续 delta.text 仍能无缝续上权威文本
    expect(cumulatives.at(-1)).toBe('abc[已隐藏]tail');
    const stored = env.conversations.get(conv.id)?.messages.find((m) => m.id === assistant.id);
    expect(stored?.text).toBe(`abc[已隐藏]tail`);
  });

  it('masks fragments of two different keys interleaved across chunks', async () => {
    const env = setup();
    const A = 'abcd1234';
    const B = '1234wxyz';
    const { conv } = keyedConv(env, A);
    env.providers.save({
      name: 'Other',
      kind: 'builtin',
      builtinProvider: 'anthropic',
      apiKey: B,
      enabled: true,
      customModels: [],
    });
    streamDeltas(['abc', 'd1234', ' 12', '34wx', 'yz end']);
    await env.service.send(conv.id, 'hi');
    await waitFor(() => env.events.some((e) => e.type === 'done'));
    const final = terminalMessage(env.events);
    expect(final?.text).toBe('[已隐藏] [已隐藏] end');
    for (const e of env.events) {
      const s = JSON.stringify(e);
      expect(s).not.toContain(A);
      expect(s).not.toContain(B);
    }
    const stored = env.conversations.get(conv.id)?.messages[1];
    expect(stored?.text).toBe('[已隐藏] [已隐藏] end');
  });

  it('releases the safe prefix immediately and retains only the competing proper prefix', async () => {
    const env = setup();
    const A = 'abcdefgh';
    const B = 'XYZabcde';
    const { conv } = keyedConv(env, A);
    env.providers.save({
      name: 'Other',
      kind: 'builtin',
      builtinProvider: 'anthropic',
      apiKey: B,
      enabled: true,
      customModels: [],
    });
    // 'abc' 是 A 的前缀、'XYZ' 是 B 的前缀：'abc' 立即放出（允许以受保护前缀结尾），
    // 只扣留最长真前缀后缀 'XYZ'，后续片段拼不出 B 后整段放出
    streamDeltas(['abcXYZ', 'defgh', ' tail']);
    await env.service.send(conv.id, 'hi');
    await waitFor(() => env.events.some((e) => e.type === 'done'));
    const deltas = deltaTexts(env.events);
    expect(deltas[0]).toBe('abc');
    expect(deltas.join('')).toBe('abcXYZdefgh tail');
    expect(terminalMessage(env.events)?.text).toBe('abcXYZdefgh tail');
  });

  it('suppresses a mask char that would complete a legal key across the release boundary', async () => {
    const env = setup();
    const A = 'abcdefg[';
    const B = '12345678';
    const { conv } = keyedConv(env, A);
    env.providers.save({
      name: 'Other',
      kind: 'builtin',
      builtinProvider: 'anthropic',
      apiKey: B,
      enabled: true,
      customModels: [],
    });
    // 'abcdefg' 放出时已以 A 的 7 位真前缀结尾；'12345678' 匹配后插入的掩码
    // 首字符 '[' 恰好在边界上拼出完整 A，必须被压制——任何出口都不得出现任一把 key
    streamDeltas(['abcdefg1234', '5678']);
    await env.service.send(conv.id, 'hi');
    await waitFor(() => env.events.some((e) => e.type === 'done'));
    const deltas = deltaTexts(env.events);
    expect(deltas[0]).toBe('abcdefg');
    const final = terminalMessage(env.events);
    // 掩码首字符 '[' 在已放出边界上拼出完整 A 被压制：输出为 'abcdefg' + '已隐藏]'
    expect(final?.text).toBe('abcdefg已隐藏]');
    for (const e of env.events) {
      const s = JSON.stringify(e);
      expect(s).not.toContain(A);
      expect(s).not.toContain(B);
    }
    const stored = env.conversations.get(conv.id)?.messages[1];
    expect(stored?.text).toBe('abcdefg已隐藏]');
    const raw = readFileSync(join(env.dir, 'conversations', `${conv.id}.json`), 'utf8');
    expect(raw).not.toContain(A);
    expect(raw).not.toContain(B);
  });

  it('flushes a withheld key-prefix tail into the final text on done', async () => {
    const env = setup();
    const { conv } = keyedConv(env, KEY);
    streamDeltas(['body', KEY.slice(0, 4)]);
    await env.service.send(conv.id, 'hi');
    await waitFor(() => env.events.some((e) => e.type === 'done'));
    const final = terminalMessage(env.events);
    expect(final?.status).toBe('done');
    // 尾部只是 key 前缀残片（不是完整 key）：终端 flush 原样并入正文
    expect(final?.text).toBe(`body${KEY.slice(0, 4)}`);
    for (const e of env.events) {
      expect(JSON.stringify(e)).not.toContain(KEY);
    }
    expect(env.conversations.get(conv.id)?.messages[1].text).toBe(`body${KEY.slice(0, 4)}`);
  });

  it('flushes the withheld tail and masks the key inside a provider error', async () => {
    const env = setup();
    const { conv } = keyedConv(env, KEY);
    streamDeltas(['body', KEY.slice(0, 4)], { error: `denied ${KEY}` });
    await env.service.send(conv.id, 'hi');
    await waitFor(() => env.events.some((e) => e.type === 'error'));
    const final = terminalMessage(env.events);
    expect(final?.text).toBe(`body${KEY.slice(0, 4)}`);
    expect(final?.error).toBe('denied [已隐藏]');
    for (const e of env.events) {
      expect(JSON.stringify(e)).not.toContain(KEY);
    }
    const stored = env.conversations.get(conv.id)?.messages[1];
    expect(stored?.text).toBe(`body${KEY.slice(0, 4)}`);
    expect(stored?.error).not.toContain(KEY);
  });

  it('snapshots redaction keys exactly once per send and never re-decrypts mid-stream', async () => {
    const counting = countingEncryption();
    const env = setup(true, counting.enc);
    const { conv } = keyedConv(env, KEY);
    const keySpy = vi.spyOn(env.providers, 'getKeySnapshot');
    streamDeltas(['chunk-one', 'chunk-two', 'chunk-three']);
    await env.service.send(conv.id, 'hi');
    // 请求开始时取一次快照；流式期间不得再枚举集合或逐 delta 解密
    expect(keySpy).toHaveBeenCalledTimes(1);
    const decryptsAtReturn = counting.counts.decrypt;
    await waitFor(() => env.events.some((e) => e.type === 'delta'));
    await waitFor(() => env.events.some((e) => e.type === 'done'));
    expect(counting.counts.decrypt).toBe(decryptsAtReturn);
    expect(keySpy).toHaveBeenCalledTimes(1);
  });

  it('snapshots redaction keys exactly once per retry and per test call', async () => {
    const env = setup();
    const conv = fauxConv(env);
    const snapshot = env.conversations.get(conv.id);
    env.conversations.save({
      ...(snapshot as Conversation),
      messages: [
        msg({ id: 'u1', text: 'hi', status: 'done' }),
        msg({ id: 'a1', role: 'assistant', text: '', status: 'error', error: 'x' }),
      ],
    });
    streamDeltas(['ok']);
    const keySpy = vi.spyOn(env.providers, 'getKeySnapshot');
    await env.service.retry(conv.id);
    expect(keySpy).toHaveBeenCalledTimes(1);
    await waitFor(() => env.events.some((e) => e.type === 'done'));
    expect(keySpy).toHaveBeenCalledTimes(1);
    keySpy.mockClear();
    const result = await env.service.test(FAUX_PROVIDER_ID, 'faux-chat');
    expect(result.ok).toBe(true);
    expect(keySpy).toHaveBeenCalledTimes(1);
  });

  it.each(['send', 'retry', 'test'] as const)(
    'captures the key snapshot once per %s and decrypts each ciphertext exactly once',
    async (op) => {
      const counting = countingEncryption();
      const env = setup(true, counting.enc);
      const ACTIVE = 'sk-active-99';
      const OTHER = 'sk-other-999';
      // 两把不同的已存密文 key：一把属活动厂商，另一把属无关（停用）厂商
      env.providers.save({
        name: 'Other',
        kind: 'builtin',
        builtinProvider: 'anthropic',
        apiKey: OTHER,
        enabled: false,
        customModels: [],
      });
      const { providerId, conv } = keyedConv(env, ACTIVE);
      if (op === 'retry') {
        // 直接铺好失败回合，不先走一次 send
        const snapshot = env.conversations.get(conv.id);
        env.conversations.save({
          ...(snapshot as Conversation),
          messages: [
            msg({ id: 'u1', text: 'hi', status: 'done' }),
            msg({ id: 'a1', role: 'assistant', text: '', status: 'error', error: 'x' }),
          ],
        });
      }
      const snapshotSpy = vi.spyOn(env.providers, 'getKeySnapshot');
      const apiKeySpy = vi.spyOn(env.providers, 'getApiKey');
      const decryptsBefore = counting.counts.decrypt;
      const perCipherBefore = new Map(counting.counts.perCipher);

      let options: StreamOptions | undefined;
      if (op === 'test') {
        completeMock.mockImplementationOnce(async (_m, _ctx, o) => {
          options = o;
          return { stopReason: 'stop' } as AssistantMessage;
        });
        const result = await env.service.test(providerId, 'claude-sonnet-4-5');
        expect(result.ok).toBe(true);
      } else {
        streamMock.mockImplementationOnce((_m, _ctx, o) => {
          options = o;
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: 'text_delta', contentIndex: 0, delta: 'ok' } as AssistantMessageEvent;
              yield { type: 'done', reason: 'stop', message: {} } as AssistantMessageEvent;
            },
          } as unknown as ReturnType<typeof piai.stream>;
        });
        if (op === 'send') {
          await env.service.send(conv.id, 'hi');
        } else {
          await env.service.retry(conv.id);
        }
        // 断言覆盖到请求终态，而非只到调用返回
        await waitFor(() => env.events.some((e) => e.type === 'done' || e.type === 'error'));
        expect(terminalMessage(env.events)?.status).toBe('done');
        expect(terminalMessage(env.events)?.text).toBe('ok');
      }

      // 发给底层的就是快照中活动厂商的 key
      expect(options?.apiKey).toBe(ACTIVE);
      // 整个请求只取一次快照、不直接调独立 getApiKey
      expect(snapshotSpy).toHaveBeenCalledTimes(1);
      expect(apiKeySpy).not.toHaveBeenCalled();
      // 从调用前到终态：两条密文各恰好解密一次（快照枚举），此外没有任何解密
      for (const cipher of [fakeCipher(ACTIVE), fakeCipher(OTHER)]) {
        expect(counting.counts.perCipher.get(cipher) ?? 0).toBe((perCipherBefore.get(cipher) ?? 0) + 1);
      }
      expect(counting.counts.decrypt).toBe(decryptsBefore + 2);
    },
  );

  it('masks a stored legacy key colliding with static error text in send/retry/test failures', async () => {
    const env = setup();
    // 遗留 keys.json 里存着与静态错误串相同的非法短 key：
    // 新校验已不可能保存它，但加载后它仍在脱敏集合里
    writeFileSync(
      join(env.dir, 'providers.json'),
      JSON.stringify([
        {
          id: 'p-legacy',
          name: 'Legacy',
          kind: 'builtin',
          builtinProvider: 'anthropic',
          enabled: true,
          customModels: [],
          createdAt: 1,
        },
      ]),
      'utf8',
    );
    writeFileSync(
      join(env.dir, 'keys.json'),
      JSON.stringify({ 'p-legacy': { encrypted: true, value: fakeCipher('API Key') } }),
      'utf8',
    );
    const providers = new ProviderStore(env.dir, fakeEncryption());
    // 非法遗留 key 被标记不可用：所有 "厂商未设置 API Key" 出口都会撞上它
    const service = new ChatService(providers, env.conversations, env.resolver, (e) => env.events.push(e));
    const conv = env.conversations.create({ providerId: 'p-legacy', modelId: 'claude-sonnet-4-5' });
    const sendErr = (await service.send(conv.id, 'hi').catch((e) => e)) as Error;
    expect(sendErr.message).toBe('厂商未设置 [已隐藏]');
    expect(sendErr.message).not.toContain('API Key');

    const snapshot = env.conversations.get(conv.id);
    env.conversations.save({
      ...(snapshot as Conversation),
      messages: [
        msg({ id: 'u1', text: 'hi', status: 'done' }),
        msg({ id: 'a1', role: 'assistant', text: '', status: 'error', error: 'x' }),
      ],
    });
    const retryErr = (await service.retry(conv.id).catch((e) => e)) as Error;
    expect(retryErr.message).toBe('厂商未设置 [已隐藏]');
    expect(retryErr.message).not.toContain('API Key');

    const result = await service.test('p-legacy', 'claude-sonnet-4-5');
    expect(result.ok).toBe(false);
    expect(result.error).toBe('厂商未设置 [已隐藏]');
    expect(result.error).not.toContain('API Key');
  });

  it('redacts a 100000-char stream in 5000 fragments within 1s and snapshots keys once', async () => {
    const env = setup();
    const A = 'abcd1234';
    const B = '1234wxyz';
    const { conv } = keyedConv(env, A);
    env.providers.save({
      name: 'Other',
      kind: 'builtin',
      builtinProvider: 'anthropic',
      apiKey: B,
      enabled: true,
      customModels: [],
    });
    const block = `${'safe text '.repeat(8)}abcd1234 1234wxyz en`;
    expect(block.length).toBe(100);
    const full = block.repeat(1000);
    expect(full.length).toBe(100000);
    const fragments: string[] = [];
    for (let i = 0; i < full.length; i += 20) {
      fragments.push(full.slice(i, i + 20));
    }
    expect(fragments).toHaveLength(5000);
    streamDeltas(fragments);
    const keySpy = vi.spyOn(env.providers, 'getKeySnapshot');
    const t0 = performance.now();
    await env.service.send(conv.id, 'perf');
    await waitFor(() => env.events.some((e) => e.type === 'done'), 30000);
    const elapsed = performance.now() - t0;
    console.log(`[perf] 100000 chars / 5000 fragments redacted stream: ${elapsed.toFixed(1)}ms`);
    expect(elapsed).toBeLessThan(1000);
    expect(keySpy).toHaveBeenCalledTimes(1);
    const expected = `${'safe text '.repeat(8)}[已隐藏] [已隐藏] en`.repeat(1000);
    const final = terminalMessage(env.events);
    expect(final?.text).toBe(expected);
    const stored = env.conversations.get(conv.id)?.messages[1];
    expect(stored?.text).toBe(expected);
    const raw = readFileSync(join(env.dir, 'conversations', `${conv.id}.json`), 'utf8');
    expect(raw).not.toContain(A);
    expect(raw).not.toContain(B);
  });
});

describe('ChatService bounded abort', () => {
  /** 完全不响应 signal 的挂起流：可控推进或永不产出 */
  function hangingStream(): void {
    streamMock.mockImplementationOnce(
      () =>
        ({
          async *[Symbol.asyncIterator]() {
            yield { type: 'text_delta', contentIndex: 0, delta: 'chunk' } as AssistantMessageEvent;
            await new Promise(() => {});
          },
        }) as unknown as ReturnType<typeof piai.stream>,
    );
  }

  it('force-terminates a non-cooperative stream at the 2s deadline and releases the lock', async () => {
    vi.useFakeTimers();
    const env = setup();
    const conv = fauxConv(env);
    hangingStream();
    await env.service.send(conv.id, 'hi');
    await vi.advanceTimersByTimeAsync(0);
    const aborting = env.service.abort(conv.id);
    let settled = false;
    void aborting.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(settled).toBe(false);
    expect(env.conversations.get(conv.id)?.messages[1].status).toBe('streaming');
    await vi.advanceTimersByTimeAsync(1);
    await aborting;
    expect(settled).toBe(true);
    const stored = env.conversations.get(conv.id)?.messages[1];
    expect(stored?.status).toBe('aborted');
    expect(stored?.error).toBe('已停止');
    // 已落盘为 aborted
    const raw = JSON.parse(readFileSync(join(env.dir, 'conversations', `${conv.id}.json`), 'utf8'));
    expect(raw.messages[1].status).toBe('aborted');
    // 锁已释放：可以立刻再发
    streamDeltas(['ok']);
    await env.service.send(conv.id, 'again');
    await vi.advanceTimersByTimeAsync(0);
    await vi.runAllTimersAsync();
    expect(env.conversations.get(conv.id)?.messages[3].status).toBe('done');
  });

  it('concurrent abort calls are idempotent and do not reset the deadline', async () => {
    vi.useFakeTimers();
    const env = setup();
    const conv = fauxConv(env);
    hangingStream();
    await env.service.send(conv.id, 'hi');
    await vi.advanceTimersByTimeAsync(0);
    const a = env.service.abort(conv.id);
    await vi.advanceTimersByTimeAsync(1500);
    const b = env.service.abort(conv.id);
    // 若第二次 abort 重置了计时器，这里不会终结
    await vi.advanceTimersByTimeAsync(500);
    await Promise.all([a, b]);
    expect(env.conversations.get(conv.id)?.messages[1].status).toBe('aborted');
  });

  /** 完全可控的挂起流：next() 一直挂起直到测试显式放出结果，return() 同样挂起 */
  interface DeferredStream {
    resolveNext: (result: IteratorResult<AssistantMessageEvent>) => void;
    rejectNext: (err: unknown) => void;
  }

  function deferredStream(): DeferredStream {
    const ctl: DeferredStream = {
      resolveNext: () => {},
      rejectNext: () => {},
    };
    streamMock.mockImplementationOnce(
      () =>
        ({
          [Symbol.asyncIterator]() {
            return {
              next: () =>
                new Promise<IteratorResult<AssistantMessageEvent>>((res, rej) => {
                  ctl.resolveNext = res;
                  ctl.rejectNext = rej;
                }),
              return: () => new Promise<IteratorResult<AssistantMessageEvent>>(() => {}),
            };
          },
        }) as unknown as ReturnType<typeof piai.stream>,
    );
    return ctl;
  }

  const lateEvents = {
    'late delta': {
      value: { type: 'text_delta', contentIndex: 0, delta: 'late' } as AssistantMessageEvent,
      done: false,
    } as IteratorResult<AssistantMessageEvent>,
    'late done': {
      value: { type: 'done', reason: 'stop', message: {} } as AssistantMessageEvent,
      done: false,
    } as IteratorResult<AssistantMessageEvent>,
    'late error': {
      value: {
        type: 'error',
        reason: 'error',
        error: { errorMessage: 'late error' },
      } as AssistantMessageEvent,
      done: false,
    } as IteratorResult<AssistantMessageEvent>,
    'iterator end': { value: undefined, done: true } as IteratorResult<AssistantMessageEvent>,
  };

  it.each(Object.keys(lateEvents))(
    'a %s after a forced abort cannot emit, write, or release the newer lock',
    async (name) => {
      vi.useFakeTimers();
      const env = setup();
      const conv = fauxConv(env);
      const oldStream = deferredStream();
      const { assistant: first } = await env.service.send(conv.id, 'hi');
      await vi.advanceTimersByTimeAsync(0);
      const aborting = env.service.abort(conv.id);
      await vi.advanceTimersByTimeAsync(2000);
      await aborting;
      // 旧请求只有一个终态 error 事件，没有任何 delta
      expect(env.events).toHaveLength(1);
      expect(env.events[0].type).toBe('error');

      // 锁已释放：同一会话立刻再发新请求（同样不配合）
      deferredStream();
      const { assistant: second } = await env.service.send(conv.id, 'again');
      await vi.advanceTimersByTimeAsync(0);
      const storedBefore = env.conversations.get(conv.id);
      expect(storedBefore?.messages).toHaveLength(4);
      expect(storedBefore?.messages[3].status).toBe('streaming');

      // 现在才放出旧流的迟到事件/结束：对新请求和存储零副作用
      oldStream.resolveNext(lateEvents[name as keyof typeof lateEvents]);
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      expect(env.events).toHaveLength(1);
      const stored = env.conversations.get(conv.id);
      expect(stored?.messages[1].status).toBe('aborted');
      expect(stored?.messages[1].id).toBe(first.id);
      expect(stored?.messages[1].text).not.toContain('late');
      expect(stored?.messages[3].id).toBe(second.id);
      expect(stored?.messages[3].status).toBe('streaming');
      expect(stored?.messages[3].text).toBe('');
      // 旧事件不能清掉新请求的锁：并发 send 仍然被拒
      await expect(env.service.send(conv.id, 'third')).rejects.toThrow(/进行中/);
      // 新请求走自己的 2s 强终流程正常收尾（不 await 挂起的 return）
      const secondAbort = env.service.abort(conv.id);
      await vi.advanceTimersByTimeAsync(2000);
      await secondAbort;
      expect(env.events.filter((e) => e.type !== 'delta')).toHaveLength(2);
      expect(env.conversations.get(conv.id)?.messages[3].status).toBe('aborted');
    },
  );

  it('a late iterator rejection after a forced abort has zero side effects', async () => {
    vi.useFakeTimers();
    const env = setup();
    const conv = fauxConv(env);
    const oldStream = deferredStream();
    await env.service.send(conv.id, 'hi');
    await vi.advanceTimersByTimeAsync(0);
    const aborting = env.service.abort(conv.id);
    await vi.advanceTimersByTimeAsync(2000);
    await aborting;
    expect(env.events).toHaveLength(1);
    // 迭代器在强终之后抛错：不得产生未处理拒绝之外的任何副作用
    oldStream.rejectNext(new Error('late iterator failure'));
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(env.events).toHaveLength(1);
    const stored = env.conversations.get(conv.id)?.messages[1];
    expect(stored?.status).toBe('aborted');
    expect(stored?.error).toBe('已停止');
  });

  it('retry immediately after a forced abort works and late old events stay inert', async () => {
    vi.useFakeTimers();
    const env = setup();
    const conv = fauxConv(env);
    const oldStream = deferredStream();
    const { user, assistant: first } = await env.service.send(conv.id, 'hi');
    await vi.advanceTimersByTimeAsync(0);
    const aborting = env.service.abort(conv.id);
    await vi.advanceTimersByTimeAsync(2000);
    await aborting;
    // 强制终结后立刻 retry：替换被中止的 assistant，不追加 user
    streamDeltas(['retried']);
    const { assistant: retried } = await env.service.retry(conv.id);
    expect(retried.id).not.toBe(first.id);
    expect(retried.status).toBe('streaming');
    await vi.advanceTimersByTimeAsync(0);
    await vi.runAllTimersAsync();
    const stored = env.conversations.get(conv.id);
    expect(stored?.messages.map((m) => m.id)).toEqual([user.id, retried.id]);
    expect(stored?.messages[1].status).toBe('done');
    expect(stored?.messages[1].text).toBe('retried');
    // 旧流此时再放东西：不能 emit、不能改存储
    const eventCount = env.events.length;
    oldStream.resolveNext(lateEvents['late delta']);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(env.events).toHaveLength(eventCount);
    expect(env.conversations.get(conv.id)?.messages[1].text).toBe('retried');
    expect(env.conversations.get(conv.id)?.messages[1].status).toBe('done');
  });

  it('late events after the conversation was deleted cannot resurrect the file', async () => {
    vi.useFakeTimers();
    const env = setup();
    const conv = fauxConv(env);
    const oldStream = deferredStream();
    await env.service.send(conv.id, 'hi');
    await vi.advanceTimersByTimeAsync(0);
    const aborting = env.service.abort(conv.id);
    await vi.advanceTimersByTimeAsync(2000);
    await aborting;
    const file = join(env.dir, 'conversations', `${conv.id}.json`);
    env.conversations.remove(conv.id);
    expect(env.conversations.get(conv.id)).toBeNull();
    expect(existsSync(file)).toBe(false);
    // 强终之后旧流再放 delta/done/错误：文件与内存都不得复活
    oldStream.resolveNext(lateEvents['late delta']);
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    oldStream.rejectNext(new Error('late'));
    await vi.advanceTimersByTimeAsync(0);
    await Promise.resolve();
    expect(env.conversations.get(conv.id)).toBeNull();
    expect(existsSync(file)).toBe(false);
  });

  it('aborts before the scheduled run starts: stream is skipped entirely', async () => {
    vi.useFakeTimers();
    const env = setup();
    const conv = fauxConv(env);
    streamDeltas(['never']);
    await env.service.send(conv.id, 'hi');
    const aborting = env.service.abort(conv.id);
    await vi.advanceTimersByTimeAsync(0);
    await aborting;
    expect(streamMock).not.toHaveBeenCalled();
    const stored = env.conversations.get(conv.id)?.messages[1];
    expect(stored?.status).toBe('aborted');
    expect(stored?.text).toBe('');
  });
});
