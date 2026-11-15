import type { IpcMainInvokeEvent } from 'electron';
import { ipcMain, nativeTheme, safeStorage } from 'electron';
import { IPC_CHANNELS } from '../shared/ipc';
import type { AppSettings, ChatEvent, ModelRef, ProviderConfig, ProviderInput } from '../shared/types';
import { ChatService } from './chat/chat-service';
import { isSupportedBuiltinProvider, ModelResolver } from './chat/model-resolver';
import { getMainWindow } from './main-window';
import { dataDir } from './paths';
import { ConversationStore } from './stores/conversation-store';
import { ProviderStore } from './stores/provider-store';
import { SettingsStore } from './stores/settings-store';

export interface MainServices {
  providers: ProviderStore;
  conversations: ConversationStore;
  settings: SettingsStore;
  resolver: ModelResolver;
  chat: ChatService;
}

function createDefaultServices(): MainServices {
  const dir = dataDir();
  const providers = new ProviderStore(dir, safeStorage);
  const conversations = new ConversationStore(dir);
  const settings = new SettingsStore(dir, nativeTheme);
  const resolver = new ModelResolver();
  const chat = new ChatService(providers, conversations, resolver, emitChatEvent);
  return { providers, conversations, settings, resolver, chat };
}

function fail(message: string): never {
  throw new Error(`参数无效：${message}`);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function reqString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    fail(`${name} 必须是非空字符串`);
  }
  return value;
}

function reqBool(value: unknown, name: string): boolean {
  if (typeof value !== 'boolean') {
    fail(`${name} 必须是布尔值`);
  }
  return value;
}

function reqStringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string' && v.trim() !== '')) {
    fail(`${name} 必须是非空字符串数组`);
  }
  return [...value];
}

function validBaseUrl(value: unknown, name: string): string {
  const raw = reqString(value, name);
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    fail(`${name} 不是合法 URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    fail(`${name} 只支持 http/https`);
  }
  if (url.username !== '' || url.password !== '') {
    fail(`${name} 不能包含用户名或密码`);
  }
  return raw;
}

function validModelRef(value: unknown): ModelRef {
  if (!isRecord(value)) {
    fail('模型引用必须是对象');
  }
  return {
    providerId: reqString(value.providerId, 'providerId'),
    modelId: reqString(value.modelId, 'modelId'),
  };
}

function validProviderInput(value: unknown): ProviderInput {
  if (!isRecord(value)) {
    fail('厂商配置必须是对象');
  }
  if (value.kind !== 'builtin' && value.kind !== 'openai-compatible') {
    fail('kind 必须是 builtin 或 openai-compatible');
  }
  const input: ProviderInput = {
    name: reqString(value.name, 'name'),
    kind: value.kind,
    enabled: reqBool(value.enabled, 'enabled'),
    customModels: reqStringArray(value.customModels, 'customModels'),
  };
  if (value.id !== undefined) {
    input.id = reqString(value.id, 'id');
  }
  if (value.apiKey === null) {
    input.apiKey = null;
  } else if (value.apiKey !== undefined) {
    input.apiKey = reqString(value.apiKey, 'apiKey');
  }
  if (value.builtinProvider !== undefined) {
    input.builtinProvider = reqString(value.builtinProvider, 'builtinProvider');
  }
  if (input.kind === 'builtin') {
    if (!input.builtinProvider || !isSupportedBuiltinProvider(input.builtinProvider)) {
      fail(`不支持的厂商：${String(value.builtinProvider)}`);
    }
    if (value.baseUrl !== undefined) {
      input.baseUrl = validBaseUrl(value.baseUrl, 'baseUrl');
    }
  } else {
    input.baseUrl = validBaseUrl(value.baseUrl, 'baseUrl');
  }
  return input;
}

function validSettingsPatch(value: unknown): Partial<AppSettings> {
  if (!isRecord(value)) {
    fail('设置必须是对象');
  }
  for (const key of Object.keys(value)) {
    if (key !== 'defaultModel' && key !== 'theme') {
      fail(`未知设置项：${key}`);
    }
  }
  const patch: Partial<AppSettings> = {};
  if ('defaultModel' in value) {
    patch.defaultModel = value.defaultModel === null ? null : validModelRef(value.defaultModel);
  }
  if ('theme' in value) {
    if (value.theme !== 'system' && value.theme !== 'light' && value.theme !== 'dark') {
      fail('theme 必须是 system/light/dark');
    }
    patch.theme = value.theme;
  }
  return patch;
}

function requireProvider(services: MainServices, providerId: string): ProviderConfig {
  const provider = services.providers.get(providerId);
  if (!provider) {
    throw new Error('厂商不存在');
  }
  return provider;
}

export function registerIpc(services: MainServices = createDefaultServices()): void {
  const handle = (channel: string, fn: (...args: unknown[]) => unknown): void => {
    ipcMain.handle(channel, async (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      // 任何参数解析/服务调用之前先验证来源：必须来自主窗口主 frame，
      // 杜绝远程页面、子 frame 或其它窗口借桥调用特权接口
      const main = getMainWindow();
      const frame = event.senderFrame;
      if (!main || event.sender !== main.webContents || !frame || frame !== main.webContents.mainFrame) {
        throw new Error('IPC 调用来源不可信');
      }
      return fn(...args);
    });
  };
  const C = IPC_CHANNELS;

  handle(C.providers.catalog, () => services.resolver.catalog());
  handle(C.providers.list, () => services.providers.list());
  handle(C.providers.save, (input) => services.providers.save(validProviderInput(input)));
  handle(C.providers.remove, (id) => services.providers.remove(reqString(id, 'providerId')));
  handle(C.providers.models, (id) =>
    services.resolver.listModels(requireProvider(services, reqString(id, 'providerId'))),
  );
  handle(C.providers.allModels, () =>
    services.providers
      .list()
      .filter((p) => p.enabled)
      .flatMap((p) => services.resolver.listModels(p)),
  );
  handle(C.providers.test, (providerId, modelId) =>
    services.chat.test(reqString(providerId, 'providerId'), reqString(modelId, 'modelId')),
  );

  handle(C.conversations.list, () => services.conversations.list());
  handle(C.conversations.get, (id) => services.conversations.get(reqString(id, 'conversationId')));
  handle(C.conversations.create, () => services.conversations.create(services.settings.get().defaultModel));
  handle(C.conversations.rename, (id, title) =>
    services.conversations.rename(reqString(id, 'conversationId'), reqString(title, 'title')),
  );
  handle(C.conversations.remove, async (id) => {
    const conversationId = reqString(id, 'conversationId');
    await services.chat.abort(conversationId);
    services.conversations.remove(conversationId);
  });
  handle(C.conversations.setModel, (id, model) => {
    const conversationId = reqString(id, 'conversationId');
    const ref = validModelRef(model);
    const provider = requireProvider(services, ref.providerId);
    if (!provider.enabled) {
      throw new Error('厂商已停用');
    }
    services.resolver.resolve(provider, ref.modelId);
    services.conversations.setModel(conversationId, ref);
  });

  handle(C.chat.send, (id, text) =>
    services.chat.send(reqString(id, 'conversationId'), reqString(text, 'text')),
  );
  handle(C.chat.retry, (id) => services.chat.retry(reqString(id, 'conversationId')));
  handle(C.chat.abort, (id) => services.chat.abort(reqString(id, 'conversationId')));

  handle(C.settings.get, () => services.settings.get());
  handle(C.settings.set, (patch) => services.settings.set(validSettingsPatch(patch)));
}

export function emitChatEvent(e: ChatEvent): void {
  const win = getMainWindow();
  if (!win) {
    return;
  }
  try {
    win.webContents.send(IPC_CHANNELS.chat.onEvent, e);
  } catch {
    // 窗口在投递途中关闭不影响主流程
  }
}
