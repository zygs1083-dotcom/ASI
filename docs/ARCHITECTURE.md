# ASI 架构与接口契约

> 本文件是各任务之间的契约。改动 `src/shared/` 里的类型必须先由协调端改本文件。

## 1. 进程划分

```
┌───────────── Renderer (React, sandbox) ─────────────┐
│ ChatView / ProvidersView / Sidebar                   │
│        只调用 window.asi.*（preload 暴露）            │
└───────────────▲──────────────────────────────────────┘
                │ IPC（ipcRenderer.invoke / 事件推送）
┌───────────────┴──────────── Main (Node) ────────────┐
│ ProviderStore  —— providers.json + keys.json(加密)    │
│ ConversationStore —— conversations/<id>.json          │
│ SettingsStore —— settings.json                        │
│ ChatService —— 调用 pi-ai stream()，转发增量事件        │
│ ModelResolver —— ProviderConfig + modelId → pi-ai Model│
└──────────────────────────────────────────────────────┘
```

- pi-ai 只在主进程使用（它依赖 Node、且可避免 CORS、key 不出主进程）。
- 数据目录：`ASI_DATA_DIR` 环境变量优先，否则 `app.getPath('userData')`。
- `ASI_FAUX=1` 时注册 pi-ai faux 厂商（`registerFauxProvider`），并自动在 ProviderStore 中出现一个名为 `Faux (测试)` 的厂商，回复内容由 `ASI_FAUX_REPLY`（默认 `"你好，我是测试模型。"`）决定、`tokensPerSecond: 40`。仅用于测试，正常启动不出现。

## 2. 目录

```
src/
  shared/types.ts        契约类型（下文第 3 节，逐字照抄）
  shared/ipc.ts          IPC 通道名常量
  main/index.ts          创建窗口（hiddenInset 标题栏、最小 900x600）
  main/stores/*.ts       ProviderStore / ConversationStore / SettingsStore
  main/chat/*.ts         ChatService / ModelResolver
  main/ipc.ts            注册 ipcMain.handle
  preload/index.ts       contextBridge.exposeInMainWorld('asi', api)
  renderer/              React 应用（main.tsx, App.tsx, views/, components/, styles/tokens.css）
tests/unit/              vitest（主进程逻辑，用 faux 厂商 + 临时目录）
tests/e2e/               Playwright _electron
```

## 3. 共享类型（`src/shared/types.ts`）

```ts
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
```

## 4. 行为约定

- **发送**：上下文 = 该会话全部 `status` 为 `done` 的历史 + 新用户消息；无 systemPrompt。会话未选模型、厂商无 key（faux 除外）、模型不存在时，`send` 直接 reject 并带中文可读错误，不写入消息。
- **流式**：只转发 `text_delta`；`thinking_*` 忽略。结束后写盘一次（不必每个 delta 写盘）。
- **中止**：`abort` → AbortController；消息最终 `status='aborted'`，保留已收到的文本，推送 `error` 事件。
- **错误**：provider 报错 → `status='error'`、`error` 为可读信息（不含 key），推送 `error` 事件。
- **同一会话同一时刻只能有一个进行中的请求**，重复 `send` reject。
- **openai-compatible 模型**：构造 `Model<'openai-completions'>`，`provider` 用厂商 id，`compat: { supportsDeveloperRole: false }`，contextWindow 128000，maxTokens 8192，cost 全 0。
- **builtin 覆盖 baseUrl**：`{ ...getModel(p, id), baseUrl }`。
- **key 传递**：`stream(model, ctx, { apiKey, signal })`。
- **写盘**：原子写（写临时文件再 rename）。keys.json 只存 `safeStorage.encryptString` 的 base64；`safeStorage.isEncryptionAvailable()` 为 false 时（测试环境）退化为明文并在日志警告一次——仅在 `ASI_DATA_DIR` 被设置时允许退化。

## 5. 界面测试锚点（`data-testid`，UI 与 e2e 共同遵守）

| testid | 元素 |
|---|---|
| `nav-new-chat` | 侧栏「新对话」 |
| `conv-item` | 侧栏会话项（`data-id` = 会话 id，`aria-current="page"` 表示选中） |
| `conv-delete` | 会话项上的删除按钮 |
| `nav-settings` | 侧栏「设置」 |
| `sidebar-default-model` | 侧栏底部默认模型文字 |
| `chat-empty` | 空会话占位 |
| `go-settings` | 空会话里"先去配置模型厂商"按钮 |
| `msg-user` / `msg-assistant` | 消息（`data-status` = streaming/done/error/aborted） |
| `msg-error` | 助手错误条 |
| `composer-input` | 输入框 textarea |
| `composer-send` / `composer-stop` | 发送 / 停止按钮 |
| `model-picker` | 模型药丸按钮；弹层内选项 `model-option`（`data-provider-id`、`data-model-id`），搜索框 `model-search` |
| `provider-add` | 「添加厂商」 |
| `provider-search` | 查找厂商输入框 |
| `provider-row` | 厂商行（`data-id`），行内开关 `provider-toggle`，状态 `provider-key-status` |
| `pe-kind-builtin` / `pe-kind-compatible` | 编辑面板类型分段 |
| `pe-builtin-select` | 内置厂商下拉（`<select>`） |
| `pe-name` / `pe-baseurl` / `pe-apikey` / `pe-apikey-clear` | 表单字段 |
| `pe-model-input` | OpenAI 兼容模型 id 输入（回车添加），标签 `pe-model-tag` |
| `pe-model-row` | 模型预览行（`data-model-id`），测试按钮 `pe-model-test`，结果 `pe-model-test-result` |
| `pe-save` / `pe-cancel` / `pe-delete` | 面板按钮（删除需二次确认：再点一次 `pe-delete-confirm`） |
| `settings-default-model` | 通用卡片里的默认模型选择器（同 `model-picker` 弹层） |
| `theme-system` / `theme-light` / `theme-dark` | 外观分段 |
