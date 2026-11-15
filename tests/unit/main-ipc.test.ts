import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AssistantMessageEvent } from '@mariozechner/pi-ai';
import * as piai from '@mariozechner/pi-ai';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ChatService } from '../../src/main/chat/chat-service';
import { ModelResolver } from '../../src/main/chat/model-resolver';
import { emitChatEvent, type MainServices, registerIpc } from '../../src/main/ipc';
import { dataDir } from '../../src/main/paths';
import { ConversationStore } from '../../src/main/stores/conversation-store';
import {
  FAUX_PROVIDER_ID,
  ProviderStore,
  type StorageEncryption,
} from '../../src/main/stores/provider-store';
import { SettingsStore } from '../../src/main/stores/settings-store';
import { IPC_CHANNELS, IPC_INVOKE_CHANNELS } from '../../src/shared/ipc';
import type { ChatEvent, ChatMessage, ModelRef } from '../../src/shared/types';

const mocks = vi.hoisted(() => {
  const handlers = new Map<string, (...args: unknown[]) => unknown>();
  return {
    handlers,
    handle: vi.fn((channel: string, fn: (...args: unknown[]) => unknown) => {
      handlers.set(channel, fn);
    }),
    getMainWindow: vi.fn((): unknown => undefined),
    getPath: vi.fn(() => '/default/userData'),
    setPath: vi.fn(),
    nativeTheme: { themeSource: 'system' as 'system' | 'light' | 'dark' },
    safeStorage: {
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
    },
  };
});

vi.mock('electron', () => ({
  ipcMain: { handle: mocks.handle },
  app: { getPath: mocks.getPath, setPath: mocks.setPath },
  safeStorage: mocks.safeStorage,
  nativeTheme: mocks.nativeTheme,
}));

vi.mock('../../src/main/main-window', () => ({
  getMainWindow: () => mocks.getMainWindow(),
}));

vi.mock('@mariozechner/pi-ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@mariozechner/pi-ai')>();
  return {
    ...actual,
    stream: vi.fn(actual.stream),
    complete: vi.fn(actual.complete),
    __actual: actual,
  };
});

const REAL_PIAI = (piai as unknown as { __actual: typeof piai }).__actual;
const streamMock = vi.mocked(piai.stream);

const doneMessage: ChatMessage = {
  id: 'm1',
  role: 'assistant',
  text: 'ok',
  createdAt: 0,
  status: 'done',
};

const dirs: string[] = [];
const resolvers: ModelResolver[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'asi-main-ipc-'));
  dirs.push(dir);
  return dir;
}

function fakeEncryption(): StorageEncryption {
  return mocks.safeStorage;
}

interface FakeWebContents {
  send: ReturnType<typeof vi.fn>;
  isDestroyed: () => boolean;
  mainFrame: { url: string };
}

interface TestEnv extends MainServices {
  dir: string;
  events: ChatEvent[];
  mainWebContents: FakeWebContents;
  trustedEvent: { sender: FakeWebContents; senderFrame: { url: string } };
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
  invokeAs: (event: unknown, channel: string, ...args: unknown[]) => Promise<unknown>;
}

function makeServices(): TestEnv {
  const dir = tempDir();
  const providers = new ProviderStore(dir, fakeEncryption());
  const conversations = new ConversationStore(dir);
  const settings = new SettingsStore(dir, mocks.nativeTheme);
  const resolver = new ModelResolver();
  resolvers.push(resolver);
  const events: ChatEvent[] = [];
  const chat = new ChatService(providers, conversations, resolver, (e) => events.push(e));
  const mainFrame = { url: 'https://app.local/main' };
  const mainWebContents: FakeWebContents = {
    send: vi.fn(),
    isDestroyed: () => false,
    mainFrame,
  };
  mocks.getMainWindow.mockReturnValue({ webContents: mainWebContents });
  const trustedEvent = { sender: mainWebContents, senderFrame: mainFrame };
  const invokeAs = async (event: unknown, channel: string, ...args: unknown[]) => {
    const handler = mocks.handlers.get(channel);
    expect(handler, channel).toBeDefined();
    return handler?.(event, ...args);
  };
  const invoke = (channel: string, ...args: unknown[]) => invokeAs(trustedEvent, channel, ...args);
  return {
    dir,
    providers,
    conversations,
    settings,
    resolver,
    chat,
    events,
    mainWebContents,
    trustedEvent,
    invoke,
    invokeAs,
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

const validProviderInput = {
  name: 'Anthropic',
  kind: 'builtin',
  builtinProvider: 'anthropic',
  enabled: true,
  customModels: [],
};

beforeEach(() => {
  vi.clearAllMocks();
  streamMock.mockImplementation(REAL_PIAI.stream);
  mocks.handlers.clear();
  mocks.nativeTheme.themeSource = 'system';
  vi.stubEnv('ASI_FAUX', '');
  vi.stubEnv('ASI_DATA_DIR', '');
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

describe('registerIpc', () => {
  it('registers exactly the 18 request channels and no chat event handle', () => {
    const env = makeServices();
    registerIpc(env);
    expect(mocks.handle).toHaveBeenCalledTimes(18);
    expect([...mocks.handlers.keys()].sort()).toEqual([...IPC_INVOKE_CHANNELS].sort());
    expect(mocks.handlers.has(IPC_CHANNELS.chat.onEvent)).toBe(false);
  });

  it('wires default services lazily under ASI_DATA_DIR', async () => {
    const dir = tempDir();
    vi.stubEnv('ASI_DATA_DIR', dir);
    registerIpc();
    expect(mocks.handle).toHaveBeenCalledTimes(18);
    const get = mocks.handlers.get(IPC_CHANNELS.settings.get);
    await expect(get?.({ webContents: { mainFrame: {} }, sender: {}, senderFrame: null })).rejects.toThrow();
  });
});

describe('IPC sender validation', () => {
  function untrustedEvents(env: TestEnv): Array<[string, unknown]> {
    const otherContents: FakeWebContents = {
      send: vi.fn(),
      isDestroyed: () => false,
      mainFrame: { url: env.mainWebContents.mainFrame.url },
    };
    return [
      ['null senderFrame', { sender: env.mainWebContents, senderFrame: null }],
      ['missing senderFrame', { sender: env.mainWebContents }],
      [
        'subframe of the same webContents',
        { sender: env.mainWebContents, senderFrame: { url: env.mainWebContents.mainFrame.url } },
      ],
      [
        'other window with a matching frame url',
        { sender: otherContents, senderFrame: otherContents.mainFrame },
      ],
      ['empty sender', {}],
    ];
  }

  it('rejects every invoke channel from untrusted senders before parsing args', async () => {
    const env = makeServices();
    registerIpc(env);
    for (const channel of IPC_INVOKE_CHANNELS) {
      for (const [name, event] of untrustedEvents(env)) {
        await expect(env.invokeAs(event, channel, 'garbage'), `${channel} / ${name}`).rejects.toThrow();
      }
    }
  });

  it('rejects every invoke channel when the main window is missing', async () => {
    const env = makeServices();
    registerIpc(env);
    mocks.getMainWindow.mockReturnValue(undefined);
    for (const channel of IPC_INVOKE_CHANNELS) {
      await expect(env.invoke(channel)).rejects.toThrow();
    }
  });

  it('does not touch services or validate args for an untrusted sender', async () => {
    const env = makeServices();
    registerIpc(env);
    const listSpy = vi.spyOn(env.providers, 'list');
    const saveSpy = vi.spyOn(env.providers, 'save');
    const sendSpy = vi.spyOn(env.chat, 'send');
    const untrusted = { sender: {}, senderFrame: null };
    await expect(env.invokeAs(untrusted, IPC_CHANNELS.providers.list)).rejects.toThrow();
    // 参数本身非法，但必须先因来源不可信被拒，而不是先暴露参数校验
    await expect(env.invokeAs(untrusted, IPC_CHANNELS.providers.save, Symbol('x'))).rejects.toThrow();
    await expect(env.invokeAs(untrusted, IPC_CHANNELS.chat.send, 'c1', 'hi')).rejects.toThrow();
    expect(listSpy).not.toHaveBeenCalled();
    expect(saveSpy).not.toHaveBeenCalled();
    expect(sendSpy).not.toHaveBeenCalled();
  });

  it('serves the authorized main-window sender', async () => {
    const env = makeServices();
    registerIpc(env);
    await expect(env.invoke(IPC_CHANNELS.settings.get)).resolves.toEqual({
      defaultModel: null,
      theme: 'system',
    });
  });
});

describe('IPC handlers: providers', () => {
  it('catalog includes faux under ASI_FAUX and lists saved providers', async () => {
    vi.stubEnv('ASI_FAUX', '1');
    const env = makeServices();
    registerIpc(env);
    const catalog = (await env.invoke(IPC_CHANNELS.providers.catalog)) as Array<{ id: string }>;
    expect(catalog.map((c) => c.id)).toContain(FAUX_PROVIDER_ID);
    expect(catalog.map((c) => c.id)).toContain('anthropic');
    expect(catalog.map((c) => c.id)).not.toContain('openai-codex');

    const saved = await env.invoke(IPC_CHANNELS.providers.save, {
      ...validProviderInput,
      apiKey: 'sk-ipc-1',
    });
    expect(saved).toMatchObject({ name: 'Anthropic', builtinProvider: 'anthropic', hasApiKey: true });
    const list = (await env.invoke(IPC_CHANNELS.providers.list)) as Array<{ id: string }>;
    expect(list.map((p) => p.id)).toContain(FAUX_PROVIDER_ID);
    expect(list.map((p) => p.id)).toContain((saved as { id: string }).id);
  });

  it('rejects invalid provider inputs without mutating the store', async () => {
    vi.stubEnv('ASI_FAUX', '1');
    const env = makeServices();
    registerIpc(env);
    const bad: unknown[][] = [
      [null],
      [[]],
      [{ ...validProviderInput, name: '' }],
      [{ ...validProviderInput, name: 7 }],
      [{ ...validProviderInput, kind: 'bogus' }],
      [{ ...validProviderInput, enabled: 'yes' }],
      [{ ...validProviderInput, customModels: 'x' }],
      [{ ...validProviderInput, customModels: [''] }],
      [{ ...validProviderInput, apiKey: '' }],
      [{ ...validProviderInput, builtinProvider: 'openai-codex' }],
      [{ ...validProviderInput, builtinProvider: 'faux' }],
      [{ ...validProviderInput, builtinProvider: 'nope' }],
      [{ ...validProviderInput, baseUrl: 'ftp://x' }],
      [{ ...validProviderInput, baseUrl: 'http://user:pass@host' }],
      [{ ...validProviderInput, baseUrl: 'not a url' }],
      [{ name: 'C', kind: 'openai-compatible', enabled: true, customModels: ['m'] }],
      [{ name: 'C', kind: 'openai-compatible', baseUrl: 'wss://x', enabled: true, customModels: ['m'] }],
      [{ ...validProviderInput, id: FAUX_PROVIDER_ID }],
    ];
    for (const args of bad) {
      await expect(env.invoke(IPC_CHANNELS.providers.save, ...args)).rejects.toThrow();
    }
    expect(env.providers.list().map((p) => p.id)).toEqual([FAUX_PROVIDER_ID]);
  });

  it('models returns previews even for a disabled provider; allModels filters by enabled', async () => {
    vi.stubEnv('ASI_FAUX', '1');
    const env = makeServices();
    registerIpc(env);
    const saved = (await env.invoke(IPC_CHANNELS.providers.save, {
      ...validProviderInput,
      enabled: false,
    })) as { id: string };
    const preview = (await env.invoke(IPC_CHANNELS.providers.models, saved.id)) as Array<{
      providerId: string;
    }>;
    expect(preview.length).toBeGreaterThan(0);
    expect(preview[0].providerId).toBe(saved.id);
    const all = (await env.invoke(IPC_CHANNELS.providers.allModels)) as Array<{ providerId: string }>;
    expect(all.map((m) => m.providerId)).not.toContain(saved.id);
    expect(all.map((m) => m.providerId)).toContain(FAUX_PROVIDER_ID);
    await expect(env.invoke(IPC_CHANNELS.providers.models, 'missing')).rejects.toThrow();
    await expect(env.invoke(IPC_CHANNELS.providers.models, '../x')).rejects.toThrow();
  });

  it('remove deletes a provider and test round-trips the faux provider', async () => {
    vi.stubEnv('ASI_FAUX', '1');
    const env = makeServices();
    registerIpc(env);
    const saved = (await env.invoke(IPC_CHANNELS.providers.save, validProviderInput)) as { id: string };
    await env.invoke(IPC_CHANNELS.providers.remove, saved.id);
    expect(env.providers.get(saved.id)).toBeUndefined();
    await expect(env.invoke(IPC_CHANNELS.providers.remove, 42)).rejects.toThrow();

    const result = (await env.invoke(IPC_CHANNELS.providers.test, FAUX_PROVIDER_ID, 'faux-chat')) as {
      ok: boolean;
    };
    expect(result.ok).toBe(true);
    await expect(env.invoke(IPC_CHANNELS.providers.test, 'missing', 'x')).resolves.toMatchObject({
      ok: false,
    });
  });
});

describe('IPC handlers: conversations, chat and settings', () => {
  it('creates conversations with the configured default model', async () => {
    vi.stubEnv('ASI_FAUX', '1');
    const env = makeServices();
    registerIpc(env);
    const ref: ModelRef = { providerId: FAUX_PROVIDER_ID, modelId: 'faux-chat' };
    await env.invoke(IPC_CHANNELS.settings.set, { defaultModel: ref });
    const conv = (await env.invoke(IPC_CHANNELS.conversations.create)) as { model: ModelRef | null };
    expect(conv.model).toEqual(ref);
    const list = (await env.invoke(IPC_CHANNELS.conversations.list)) as Array<{ id: string }>;
    expect(list.map((c) => c.id)).toEqual([(conv as unknown as { id: string }).id]);
  });

  it('setModel validates the ref and the real provider+model before saving', async () => {
    vi.stubEnv('ASI_FAUX', '1');
    const env = makeServices();
    registerIpc(env);
    const conv = (await env.invoke(IPC_CHANNELS.conversations.create)) as { id: string };
    await env.invoke(IPC_CHANNELS.conversations.setModel, conv.id, {
      providerId: FAUX_PROVIDER_ID,
      modelId: 'faux-chat',
    });
    expect(env.conversations.get(conv.id)?.model?.modelId).toBe('faux-chat');
    for (const bad of [
      [conv.id, null],
      [conv.id, { providerId: 'faux' }],
      [conv.id, { providerId: 'faux', modelId: 'other' }],
      [conv.id, { providerId: 'missing', modelId: 'x' }],
    ]) {
      await expect(env.invoke(IPC_CHANNELS.conversations.setModel, ...bad)).rejects.toThrow();
    }
    expect(env.conversations.get(conv.id)?.model?.modelId).toBe('faux-chat');
  });

  it('rename/get/remove round-trip and remove aborts before deleting', async () => {
    vi.stubEnv('ASI_FAUX', '1');
    const env = makeServices();
    registerIpc(env);
    const conv = (await env.invoke(IPC_CHANNELS.conversations.create)) as { id: string };
    await env.invoke(IPC_CHANNELS.conversations.rename, conv.id, '新名字');
    const got = (await env.invoke(IPC_CHANNELS.conversations.get, conv.id)) as { title: string };
    expect(got.title).toBe('新名字');
    await expect(env.invoke(IPC_CHANNELS.conversations.rename, conv.id, 5)).rejects.toThrow();
    await expect(env.invoke(IPC_CHANNELS.conversations.get, '../evil')).rejects.toThrow();

    // 进行中的流在 remove 前被 abort，文件删除后不复活
    await env.invoke(IPC_CHANNELS.conversations.setModel, conv.id, {
      providerId: FAUX_PROVIDER_ID,
      modelId: 'faux-chat',
    });
    await env.invoke(IPC_CHANNELS.chat.send, conv.id, '/slow');
    await env.invoke(IPC_CHANNELS.conversations.remove, conv.id);
    expect(env.conversations.get(conv.id)).toBeNull();
    await new Promise((r) => setTimeout(r, 100));
    expect(env.conversations.get(conv.id)).toBeNull();
  });

  it.each(['delta', 'done', 'end', 'reject'] as const)(
    'conversation.remove resolves by the abort deadline and a late %s cannot resurrect the file',
    async (lateKind) => {
      vi.useFakeTimers();
      vi.stubEnv('ASI_FAUX', '1');
      const env = makeServices();
      registerIpc(env);
      const conv = (await env.invoke(IPC_CHANNELS.conversations.create)) as { id: string };
      await env.invoke(IPC_CHANNELS.conversations.setModel, conv.id, {
        providerId: FAUX_PROVIDER_ID,
        modelId: 'faux-chat',
      });
      // 完全不配合的迭代器：next() 挂起等待测试放出结果，return() 也永远挂起
      let resolveNext: (r: IteratorResult<AssistantMessageEvent>) => void = () => {};
      let rejectNext: (e: unknown) => void = () => {};
      streamMock.mockImplementationOnce(
        () =>
          ({
            [Symbol.asyncIterator]() {
              return {
                next: () =>
                  new Promise<IteratorResult<AssistantMessageEvent>>((res, rej) => {
                    resolveNext = res;
                    rejectNext = rej;
                  }),
                return: () => new Promise<IteratorResult<AssistantMessageEvent>>(() => {}),
              };
            },
          }) as unknown as ReturnType<typeof piai.stream>,
      );
      await env.invoke(IPC_CHANNELS.chat.send, conv.id, 'hi');
      await vi.advanceTimersByTimeAsync(0);
      const file = join(env.dir, 'conversations', `${conv.id}.json`);
      const removing = env.invoke(IPC_CHANNELS.conversations.remove, conv.id);
      let settled = false;
      void removing.then(() => {
        settled = true;
      });
      // remove 内部的 abort 最多等 2000ms：1999ms 时仍 pending，2000ms 时完成删除
      await vi.advanceTimersByTimeAsync(1999);
      expect(settled).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await removing;
      expect(settled).toBe(true);
      expect(env.conversations.get(conv.id)).toBeNull();
      expect(existsSync(file)).toBe(false);
      // 强终只发了一个终态 error，没有 delta
      expect(env.events).toHaveLength(1);
      expect(env.events[0].type).toBe('error');
      // 迟到的流结果不得复活会话（不 await 挂起的 return）
      if (lateKind === 'delta') {
        resolveNext({
          value: { type: 'text_delta', contentIndex: 0, delta: 'late' } as AssistantMessageEvent,
          done: false,
        });
      } else if (lateKind === 'done') {
        resolveNext({
          value: { type: 'done', reason: 'stop', message: {} } as AssistantMessageEvent,
          done: false,
        });
      } else if (lateKind === 'end') {
        resolveNext({ value: undefined, done: true });
      } else {
        rejectNext(new Error('late iterator failure'));
      }
      await vi.advanceTimersByTimeAsync(0);
      await Promise.resolve();
      expect(env.events).toHaveLength(1);
      expect(env.conversations.get(conv.id)).toBeNull();
      expect(existsSync(file)).toBe(false);
      const fresh = new ConversationStore(env.dir);
      expect(fresh.get(conv.id)).toBeNull();
    },
  );

  it('chat send streams events through the service and abort stops them', async () => {
    vi.stubEnv('ASI_FAUX', '1');
    const env = makeServices();
    registerIpc(env);
    const conv = (await env.invoke(IPC_CHANNELS.conversations.create)) as { id: string };
    await env.invoke(IPC_CHANNELS.conversations.setModel, conv.id, {
      providerId: FAUX_PROVIDER_ID,
      modelId: 'faux-chat',
    });
    const pair = (await env.invoke(IPC_CHANNELS.chat.send, conv.id, '你好')) as {
      user: ChatMessage;
      assistant: ChatMessage;
    };
    expect(pair.assistant.status).toBe('streaming');
    await waitFor(() => env.events.some((e) => e.type === 'done'));
    expect(env.conversations.get(conv.id)?.messages[1].status).toBe('done');

    const conv2 = (await env.invoke(IPC_CHANNELS.conversations.create)) as { id: string };
    await env.invoke(IPC_CHANNELS.conversations.setModel, conv2.id, {
      providerId: FAUX_PROVIDER_ID,
      modelId: 'faux-chat',
    });
    await env.invoke(IPC_CHANNELS.chat.send, conv2.id, '/slow');
    await env.invoke(IPC_CHANNELS.chat.abort, conv2.id);
    await waitFor(() => env.events.some((e) => e.type === 'error' && e.conversationId === conv2.id));
    const aborted = env.conversations.get(conv2.id)?.messages[1];
    expect(aborted?.status).toBe('aborted');
  });

  it('chat.retry validates args and forwards to the service', async () => {
    vi.stubEnv('ASI_FAUX', '1');
    const env = makeServices();
    registerIpc(env);
    const conv = (await env.invoke(IPC_CHANNELS.conversations.create)) as { id: string };
    await env.invoke(IPC_CHANNELS.conversations.setModel, conv.id, {
      providerId: FAUX_PROVIDER_ID,
      modelId: 'faux-chat',
    });
    // 参数校验优先：坏 id 必须先被拒
    await expect(env.invoke(IPC_CHANNELS.chat.retry, 42)).rejects.toThrow();
    await expect(env.invoke(IPC_CHANNELS.chat.retry, '../x')).rejects.toThrow();
    await expect(env.invoke(IPC_CHANNELS.chat.retry, conv.id)).rejects.toThrow();

    const user: ChatMessage = {
      id: 'u-seed',
      role: 'user',
      text: '你好',
      createdAt: 1,
      status: 'done',
    };
    const failed: ChatMessage = {
      id: 'a-seed',
      role: 'assistant',
      text: '',
      createdAt: 2,
      status: 'error',
      error: '失败',
    };
    const snapshot = env.conversations.get(conv.id);
    if (snapshot === null) {
      throw new Error('会话应存在');
    }
    env.conversations.save({ ...snapshot, messages: [user, failed] });
    const retried = (await env.invoke(IPC_CHANNELS.chat.retry, conv.id)) as {
      assistant: ChatMessage;
    };
    expect(retried.assistant.status).toBe('streaming');
    expect(retried.assistant.id).not.toBe(failed.id);
    await waitFor(() => env.events.some((e) => e.type === 'done' && e.conversationId === conv.id));
    const stored = env.conversations.get(conv.id);
    expect(stored?.messages.map((m) => m.id)).toEqual([user.id, retried.assistant.id]);
    expect(stored?.messages[1].status).toBe('done');
  });

  it('chat send rejects invalid args and validation failures without appending', async () => {
    vi.stubEnv('ASI_FAUX', '1');
    const env = makeServices();
    registerIpc(env);
    const conv = (await env.invoke(IPC_CHANNELS.conversations.create)) as { id: string };
    await expect(env.invoke(IPC_CHANNELS.chat.send, conv.id, '')).rejects.toThrow();
    await expect(env.invoke(IPC_CHANNELS.chat.send, conv.id, '   ')).rejects.toThrow();
    await expect(env.invoke(IPC_CHANNELS.chat.send, conv.id, null)).rejects.toThrow();
    await expect(env.invoke(IPC_CHANNELS.chat.send, '../x', 'hi')).rejects.toThrow();
    // 会话未选模型
    await expect(env.invoke(IPC_CHANNELS.chat.send, conv.id, 'hi')).rejects.toThrow();
    expect(env.conversations.get(conv.id)?.messages).toEqual([]);
  });

  it('settings get/set apply theme and reject invalid patches', async () => {
    const env = makeServices();
    registerIpc(env);
    await expect(env.invoke(IPC_CHANNELS.settings.get)).resolves.toEqual({
      defaultModel: null,
      theme: 'system',
    });
    await env.invoke(IPC_CHANNELS.settings.set, { theme: 'dark' });
    expect(mocks.nativeTheme.themeSource).toBe('dark');
    await env.invoke(IPC_CHANNELS.settings.set, { defaultModel: null });
    await env.invoke(IPC_CHANNELS.settings.set, {});
    for (const bad of [
      null,
      [],
      { theme: 'neon' },
      { theme: 3 },
      { defaultModel: 'x' },
      { defaultModel: { providerId: 'p' } },
      { unknown: 1 },
    ]) {
      await expect(env.invoke(IPC_CHANNELS.settings.set, bad)).rejects.toThrow();
    }
    await expect(env.invoke(IPC_CHANNELS.settings.get)).resolves.toMatchObject({ theme: 'dark' });
  });
});

describe('IPC error redaction', () => {
  it('masks a saved key colliding with argument-validation error text', async () => {
    const env = makeServices();
    registerIpc(env);
    env.providers.save({
      name: 'P',
      kind: 'builtin',
      builtinProvider: 'anthropic',
      apiKey: 'providerId',
      enabled: true,
      customModels: [],
    });
    // 'providerId' 是合法保存的 key（10 位可打印 ASCII）：静态错误文本里的同名片段不得出桥
    const err = (await env.invoke(IPC_CHANNELS.providers.remove, 42).catch((e) => e)) as Error;
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('参数无效：[已隐藏] 必须是非空字符串');
    expect(err.message).not.toContain('providerId');
  });

  it('masks a saved key colliding with the kind-validation error text', async () => {
    const env = makeServices();
    registerIpc(env);
    env.providers.save({
      name: 'P',
      kind: 'builtin',
      builtinProvider: 'anthropic',
      apiKey: 'openai-compatible',
      enabled: true,
      customModels: [],
    });
    const err = (await env
      .invoke(IPC_CHANNELS.providers.save, {
        name: 'C',
        kind: 'nope',
        enabled: true,
        customModels: [],
      })
      .catch((e) => e)) as Error;
    expect(err.message).toBe('参数无效：kind 必须是 builtin 或 [已隐藏]');
    expect(err.message).not.toContain('openai-compatible');
  });

  it('masks saved keys in sync throws and async rejections, with a sanitized fallback', async () => {
    const env = makeServices();
    registerIpc(env);
    env.providers.save({
      name: 'P',
      kind: 'builtin',
      builtinProvider: 'anthropic',
      apiKey: 'providerId',
      enabled: true,
      customModels: [],
    });
    // handler 内同步抛错
    const removeSpy = vi.spyOn(env.providers, 'remove').mockImplementation(() => {
      throw new Error('sync leak providerId end');
    });
    const syncErr = (await env.invoke(IPC_CHANNELS.providers.remove, 'p1').catch((e) => e)) as Error;
    expect(syncErr.message).toBe('sync leak [已隐藏] end');
    expect(syncErr.message).not.toContain('providerId');
    removeSpy.mockRestore();

    // handler 返回的 promise 拒绝
    const sendSpy = vi.spyOn(env.chat, 'send').mockRejectedValue(new Error('async leak providerId end'));
    const asyncErr = (await env.invoke(IPC_CHANNELS.chat.send, 'c1', 'hi').catch((e) => e)) as Error;
    expect(asyncErr.message).toBe('async leak [已隐藏] end');
    expect(asyncErr.message).not.toContain('providerId');
    sendSpy.mockRestore();

    // 非 Error 拒绝原样转 message；完全无消息走统一中文兜底
    const abortSpy = vi.spyOn(env.chat, 'abort').mockRejectedValue('raw string');
    const strErr = (await env.invoke(IPC_CHANNELS.chat.abort, 'c1').catch((e) => e)) as Error;
    expect(strErr).toBeInstanceOf(Error);
    expect(strErr.message).toBe('raw string');
    abortSpy.mockRejectedValue(undefined);
    const emptyErr = (await env.invoke(IPC_CHANNELS.chat.abort, 'c1').catch((e) => e)) as Error;
    expect(emptyErr.message).toBe('未知错误');
    abortSpy.mockRestore();
  });
});

describe('emitChatEvent', () => {
  it('sends the event only to the main window webContents', () => {
    const send = vi.fn();
    const otherSend = vi.fn();
    mocks.getMainWindow.mockReturnValue({
      webContents: { send, isDestroyed: () => false },
    });
    const event: ChatEvent = { type: 'done', conversationId: 'c1', message: doneMessage };
    emitChatEvent(event);
    expect(send).toHaveBeenCalledWith(IPC_CHANNELS.chat.onEvent, event);
    expect(send).toHaveBeenCalledTimes(1);
    expect(otherSend).not.toHaveBeenCalled();
  });

  it('does nothing when there is no main window', () => {
    mocks.getMainWindow.mockReturnValue(undefined);
    const event: ChatEvent = { type: 'done', conversationId: 'c1', message: doneMessage };
    expect(() => emitChatEvent(event)).not.toThrow();
  });

  it('tolerates a send that throws because the window closed mid-delivery', () => {
    const send = vi.fn(() => {
      throw new Error('webContents gone');
    });
    mocks.getMainWindow.mockReturnValue({ webContents: { send } });
    const event: ChatEvent = { type: 'done', conversationId: 'c1', message: doneMessage };
    expect(() => emitChatEvent(event)).not.toThrow();
    expect(send).toHaveBeenCalledWith(IPC_CHANNELS.chat.onEvent, event);
  });
});

describe('dataDir', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('prefers ASI_DATA_DIR when set', () => {
    vi.stubEnv('ASI_DATA_DIR', '/tmp/asi-test-data');
    expect(dataDir()).toBe('/tmp/asi-test-data');
  });

  it('falls back to app userData when unset or empty', () => {
    vi.stubEnv('ASI_DATA_DIR', undefined);
    expect(dataDir()).toBe('/default/userData');
    vi.stubEnv('ASI_DATA_DIR', '');
    expect(dataDir()).toBe('/default/userData');
    expect(mocks.getPath).toHaveBeenCalledWith('userData');
  });
});
