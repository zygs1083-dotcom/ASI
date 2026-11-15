import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
    getAllWindows: vi.fn((): Array<{ webContents: { send: ReturnType<typeof vi.fn> } }> => []),
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
  BrowserWindow: { getAllWindows: mocks.getAllWindows },
  app: { getPath: mocks.getPath, setPath: mocks.setPath },
  safeStorage: mocks.safeStorage,
  nativeTheme: mocks.nativeTheme,
}));

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

interface TestEnv extends MainServices {
  events: ChatEvent[];
  invoke: (channel: string, ...args: unknown[]) => Promise<unknown>;
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
  const invoke = async (channel: string, ...args: unknown[]) => {
    const handler = mocks.handlers.get(channel);
    expect(handler, channel).toBeDefined();
    return handler?.({}, ...args);
  };
  return { providers, conversations, settings, resolver, chat, events, invoke };
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
  mocks.handlers.clear();
  mocks.nativeTheme.themeSource = 'system';
});

afterEach(() => {
  for (const r of resolvers.splice(0)) {
    r.dispose();
  }
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
  vi.unstubAllEnvs();
});

describe('registerIpc', () => {
  it('registers exactly the 17 request channels and no chat event handle', () => {
    const env = makeServices();
    registerIpc(env);
    expect(mocks.handle).toHaveBeenCalledTimes(17);
    expect([...mocks.handlers.keys()].sort()).toEqual([...IPC_INVOKE_CHANNELS].sort());
    expect(mocks.handlers.has(IPC_CHANNELS.chat.onEvent)).toBe(false);
  });

  it('wires default services lazily under ASI_DATA_DIR', async () => {
    const dir = tempDir();
    vi.stubEnv('ASI_DATA_DIR', dir);
    registerIpc();
    expect(mocks.handle).toHaveBeenCalledTimes(17);
    const get = mocks.handlers.get(IPC_CHANNELS.settings.get);
    await expect(get?.({})).resolves.toEqual({ defaultModel: null, theme: 'system' });
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

describe('emitChatEvent', () => {
  it('broadcasts the event to every window', () => {
    const sends = [vi.fn(), vi.fn(), vi.fn()];
    mocks.getAllWindows.mockReturnValue(sends.map((send) => ({ webContents: { send } })));
    const event: ChatEvent = { type: 'done', conversationId: 'c1', message: doneMessage };
    emitChatEvent(event);
    for (const send of sends) {
      expect(send).toHaveBeenCalledWith(IPC_CHANNELS.chat.onEvent, event);
    }
  });

  it('skips destroyed windows and isolates a failing receiver from the rest', () => {
    const destroyedSend = vi.fn();
    const throwingSend = vi.fn(() => {
      throw new Error('webContents gone');
    });
    const goodSend = vi.fn();
    mocks.getAllWindows.mockReturnValue([
      { isDestroyed: () => true, webContents: { send: destroyedSend } },
      { webContents: { isDestroyed: () => true, send: vi.fn() } },
      { isDestroyed: () => false, webContents: { send: throwingSend } },
      { isDestroyed: () => false, webContents: { isDestroyed: () => false, send: goodSend } },
    ] as unknown as Array<{ webContents: { send: ReturnType<typeof vi.fn> } }>);
    const event: ChatEvent = { type: 'done', conversationId: 'c1', message: doneMessage };
    emitChatEvent(event);
    expect(destroyedSend).not.toHaveBeenCalled();
    expect(throwingSend).toHaveBeenCalled();
    expect(goodSend).toHaveBeenCalledWith(IPC_CHANNELS.chat.onEvent, event);
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
