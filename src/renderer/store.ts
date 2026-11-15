import { useSyncExternalStore } from 'react';
import type {
  AppSettings,
  AsiApi,
  CatalogProvider,
  ChatEvent,
  ChatMessage,
  Conversation,
  ConversationSummary,
  ModelInfo,
  ModelRef,
  ProviderConfig,
  ProviderInput,
  TestResult,
} from '../shared/types';

export interface ConvState {
  loaded: boolean;
  title: string;
  model: ModelRef | null;
  messages: ChatMessage[];
}

export type View = 'chat' | 'settings';

/** editor = null 表示厂商列表；{ id: null } 表示新建厂商 */
export interface ProviderEditorTarget {
  id: string | null;
}

export interface AppState {
  ready: boolean;
  fatal: string | null;
  notice: string | null;
  view: View;
  editor: ProviderEditorTarget | null;
  summaries: ConversationSummary[];
  currentId: string | null;
  convLoading: boolean;
  conversations: Record<string, ConvState>;
  providers: ProviderConfig[];
  catalog: CatalogProvider[];
  allModels: ModelInfo[];
  modelsByProvider: Record<string, ModelInfo[]>;
  modelLoadErrors: Record<string, string>;
  settings: AppSettings | null;
  pendingSend: Record<string, boolean>;
  drafts: Record<string, string>;
}

const initialState: AppState = {
  ready: false,
  fatal: null,
  notice: null,
  view: 'chat',
  editor: null,
  summaries: [],
  currentId: null,
  convLoading: false,
  conversations: {},
  providers: [],
  catalog: [],
  allModels: [],
  modelsByProvider: {},
  modelLoadErrors: {},
  settings: null,
  pendingSend: {},
  drafts: {},
};

let state: AppState = initialState;
const listeners = new Set<() => void>();

function setState(patch: Partial<AppState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

export function useAppState(): AppState {
  return useSyncExternalStore(subscribe, () => state);
}

/** 仅供 DEV 验证脚本读取当前快照 */
export const getState = (): AppState => state;

// ---------- helpers ----------

const api = (): AsiApi => window.asi;

const errText = (e: unknown): string => (e instanceof Error && e.message ? e.message : '操作失败，请重试');

const isTerminal = (m: ChatMessage): boolean => m.status !== 'streaming';

export function currentConv(s: AppState): ConvState | null {
  return s.currentId ? (s.conversations[s.currentId] ?? null) : null;
}

export function convStreaming(cd: ConvState | null | undefined): boolean {
  return !!cd?.messages.some((m) => m.status === 'streaming');
}

export interface ModelDisplay {
  label: string;
  available: boolean;
}

/** 解析模型引用 → 展示名 + 是否仍然可用（厂商存在、启用且模型存在） */
export function resolveModel(s: AppState, ref: ModelRef | null): ModelDisplay {
  if (!ref) return { label: '选择模型', available: false };
  const provider = s.providers.find((p) => p.id === ref.providerId);
  const info = s.allModels.find((m) => m.providerId === ref.providerId && m.modelId === ref.modelId);
  const modelName = info?.name ?? ref.modelId;
  const label = provider ? `${provider.name} · ${modelName}` : modelName;
  const available = !!provider && provider.enabled && !!info;
  return { label, available };
}

export function applyTheme(theme: AppSettings['theme']): void {
  const el = document.documentElement;
  if (theme === 'system') {
    delete el.dataset.theme;
  } else {
    el.dataset.theme = theme;
  }
}

// ---------- 流式事件与合并 ----------

// 每个会话里流式消息 id → 已收到的全部 delta 文本（权威来源：订阅早于任何 send/get）。
const liveDeltas = new Map<string, Map<string, string>>();
// 消息尚未出现在缓存里时先到的事件（send 返回前 / 会话未加载）
const pendingEvents = new Map<string, ChatEvent[]>();
// 会话删除纪元：get/send 的过期响应不允许复活已删会话
const convEpoch = new Map<string, number>();
// 本地字段（title/model）版本：改名/改模型后，过期的 get 快照不得覆盖本地新值
const convLocalRev = new Map<string, number>();
// 进行中的本地改名：summaries 刷新不得覆盖它
const renamingConvs = new Set<string>();

const bumpRev = (m: Map<string, number>, k: string): void => {
  m.set(k, (m.get(k) ?? 0) + 1);
};

let selectionGen = 0;
let offEvents: (() => void) | null = null;
let initStarted = false;

function queueEvent(convId: string, e: ChatEvent): void {
  const list = pendingEvents.get(convId) ?? [];
  list.push(e);
  pendingEvents.set(convId, list);
}

function setConv(id: string, conv: ConvState | null): void {
  const conversations = { ...state.conversations };
  if (conv) conversations[id] = conv;
  else delete conversations[id];
  setState({ conversations });
}

function ensureSubscribed(): void {
  if (!offEvents) offEvents = api().chat.onEvent(handleEvent);
}

/** 切换会话时同步重建订阅：先退订再订阅，无事件间隙，全局按 conversationId 路由不变 */
function renewSubscription(): void {
  offEvents?.();
  offEvents = api().chat.onEvent(handleEvent);
}

/**
 * 合并规则（消息历史只增不减）：
 * - 同一 messageId：任一侧为终态（done/error/aborted）则终态获胜——终态绝不回流式；
 *   两侧同态取快照；同为 streaming 时文本以 liveDeltas 累积为准，否则取更长的一侧，
 *   保证晚到的旧快照不会把终端消息改回流式、也不会截断已收到的文本。
 * - 缓存里存在而快照里没有的消息（send 刚写入的 pair 等）按原顺序保留在尾部。
 */
function mergeMessage(c: ChatMessage | undefined, s: ChatMessage, acc: string | undefined): ChatMessage {
  if (!c) {
    return acc != null && s.status === 'streaming' ? { ...s, text: acc } : s;
  }
  const cTerm = isTerminal(c);
  const sTerm = isTerminal(s);
  if (cTerm && !sTerm) return c;
  if (!cTerm && sTerm) return s;
  if (sTerm) return s;
  const text = acc ?? (c.text.length >= s.text.length ? c.text : s.text);
  return text === s.text ? s : { ...s, text };
}

function mergeMessages(convId: string, snap: ChatMessage[], cached: ChatMessage[]): ChatMessage[] {
  const deltas = liveDeltas.get(convId);
  const remaining = new Map(cached.map((m) => [m.id, m]));
  const merged = snap.map((s) => {
    const c = remaining.get(s.id);
    remaining.delete(s.id);
    return mergeMessage(c, s, deltas?.get(s.id));
  });
  for (const m of cached) {
    if (remaining.has(m.id)) merged.push(m);
  }
  return merged;
}

/**
 * 把事件应用到会话缓存。queueMissing=true 时，消息还没到的事件重新排队；
 * flush 阶段传 false，缺失的 delta 直接补一条 streaming 占位消息。
 */
function applyEventToConv(cd: ConvState, convId: string, e: ChatEvent, queueMissing: boolean): ConvState {
  if (e.type === 'delta') {
    const acc = liveDeltas.get(convId)?.get(e.messageId) ?? '';
    const idx = cd.messages.findIndex((m) => m.id === e.messageId);
    if (idx < 0) {
      if (queueMissing) {
        queueEvent(convId, e);
        return cd;
      }
      const placeholder: ChatMessage = {
        id: e.messageId,
        role: 'assistant',
        text: acc,
        createdAt: Date.now(),
        status: 'streaming',
      };
      return { ...cd, messages: [...cd.messages, placeholder] };
    }
    // 终态消息忽略迟到的 delta（如过期排队事件重放），终态不得回流式
    if (isTerminal(cd.messages[idx])) return cd;
    if (cd.messages[idx].text === acc && cd.messages[idx].status === 'streaming') return cd;
    const messages = [...cd.messages];
    messages[idx] = { ...messages[idx], text: acc, status: 'streaming' };
    return { ...cd, messages };
  }
  const idx = cd.messages.findIndex((m) => m.id === e.message.id);
  if (idx < 0) {
    if (queueMissing) {
      queueEvent(convId, e);
      return cd;
    }
    return { ...cd, messages: [...cd.messages, e.message] };
  }
  const messages = [...cd.messages];
  messages[idx] = e.message;
  return { ...cd, messages };
}

function flushPending(convId: string, cd: ConvState): ConvState {
  const list = pendingEvents.get(convId);
  if (!list?.length) return cd;
  pendingEvents.delete(convId);
  let next = cd;
  for (const e of list) next = applyEventToConv(next, convId, e, false);
  return next;
}

function handleEvent(e: ChatEvent): void {
  const convId = e.conversationId;
  if (e.type === 'delta') {
    let m = liveDeltas.get(convId);
    if (!m) {
      m = new Map();
      liveDeltas.set(convId, m);
    }
    m.set(e.messageId, (m.get(e.messageId) ?? '') + e.delta);
  } else {
    liveDeltas.get(convId)?.delete(e.message.id);
  }
  const cd = state.conversations[convId];
  if (!cd?.loaded) {
    queueEvent(convId, e);
    return;
  }
  const next = applyEventToConv(cd, convId, e, true);
  if (next !== cd) setConv(convId, next);
  if (e.type !== 'delta') void refreshSummaries();
}

/** get 快照与当前缓存按消息 id 合并，再 flush 排队事件 */
function mergeIntoCache(convId: string, conv: Conversation): ConvState {
  const cached = state.conversations[convId];
  const deltas = liveDeltas.get(convId);
  const cd: ConvState = {
    loaded: true,
    title: conv.title,
    model: conv.model,
    messages: cached
      ? mergeMessages(convId, conv.messages, cached.messages)
      : conv.messages.map((m) => {
          const acc = deltas?.get(m.id);
          return acc != null && m.status === 'streaming' ? { ...m, text: acc } : m;
        }),
  };
  return flushPending(convId, cd);
}

/** send 返回的 user/assistant：按 id upsert——已存在时按合并规则（终态不被流式占位覆盖） */
function upsertMessages(convId: string, messages: ChatMessage[], incoming: ChatMessage[]): ChatMessage[] {
  const deltas = liveDeltas.get(convId);
  const byId = new Map(incoming.map((m) => [m.id, m]));
  const out = messages.map((m) => {
    const inc = byId.get(m.id);
    return inc ? mergeMessage(m, inc, deltas?.get(m.id)) : m;
  });
  const have = new Set(messages.map((m) => m.id));
  for (const m of incoming) {
    if (!have.has(m.id)) {
      const acc = deltas?.get(m.id);
      out.push(acc != null && m.status === 'streaming' ? { ...m, text: acc } : m);
    }
  }
  return out;
}

async function refreshSummaries(): Promise<void> {
  try {
    const summaries = await api().conversations.list();
    const conversations = { ...state.conversations };
    let changed = false;
    for (const s of summaries) {
      const cd = conversations[s.id];
      if (cd && !renamingConvs.has(s.id) && cd.title !== s.title) {
        conversations[s.id] = { ...cd, title: s.title };
        changed = true;
      }
    }
    setState(changed ? { summaries, conversations } : { summaries });
  } catch {
    // 列表刷新失败保留旧数据，不打断界面
  }
}

async function refreshProviders(): Promise<void> {
  const [providers, allModels] = await Promise.all([api().providers.list(), api().providers.allModels()]);
  setState({ providers, allModels });
}

// ---------- actions ----------

export const actions = {
  async init(): Promise<void> {
    // 先保证订阅存在（StrictMode cleanup→remount 后 initStarted 已为 true 也要重新挂上）
    ensureSubscribed();
    if (initStarted) return;
    initStarted = true;
    try {
      const [summaries, settings, catalog, providers, allModels] = await Promise.all([
        api().conversations.list(),
        api().settings.get(),
        api().providers.catalog(),
        api().providers.list(),
        api().providers.allModels(),
      ]);
      applyTheme(settings.theme);
      setState({ summaries, settings, catalog, providers, allModels, ready: true, fatal: null });
      if (summaries[0]) await actions.selectConversation(summaries[0].id);
      else await actions.newConversation();
    } catch (e) {
      setState({ fatal: errText(e), ready: true });
    }
  },

  retryInit(): void {
    initStarted = false;
    setState({ fatal: null, ready: false });
    void actions.init();
  },

  /** App 卸载时退订；与 ensureSubscribed 配对，保证任意时刻至多一个 handler */
  dispose(): void {
    offEvents?.();
    offEvents = null;
  },

  async selectConversation(id: string): Promise<void> {
    renewSubscription();
    const gen = ++selectionGen;
    const epoch = convEpoch.get(id) ?? 0;
    const rev = convLocalRev.get(id) ?? 0;
    const cached = state.conversations[id];
    setState({ currentId: id, view: 'chat', editor: null, convLoading: !cached?.loaded });
    try {
      const conv = await api().conversations.get(id);
      if ((convEpoch.get(id) ?? 0) !== epoch) return; // 等待期间被删除，不复活
      if (!conv) {
        // 会话已不存在
        setConv(id, null);
        const summaries = state.summaries.filter((s) => s.id !== id);
        if (gen === selectionGen) {
          setState({ summaries, convLoading: false });
          if (summaries[0]) await actions.selectConversation(summaries[0].id);
          else await actions.newConversation();
        } else {
          setState({ summaries });
        }
        return;
      }
      const merged = mergeIntoCache(id, conv);
      if ((convLocalRev.get(id) ?? 0) !== rev) {
        // 等待期间本地改过标题/模型，保留本地新值
        const cur = state.conversations[id];
        merged.title = cur?.title ?? merged.title;
        merged.model = cur?.model ?? merged.model;
      }
      const conversations = { ...state.conversations, [id]: merged };
      if (gen === selectionGen) setState({ conversations, convLoading: false });
      else setState({ conversations });
    } catch (e) {
      if (gen === selectionGen) setState({ convLoading: false, notice: errText(e) });
    }
  },

  async newConversation(): Promise<void> {
    const gen = ++selectionGen;
    try {
      const conv = await api().conversations.create();
      const conversations = {
        ...state.conversations,
        [conv.id]: { loaded: true, title: conv.title, model: conv.model, messages: conv.messages },
      };
      if (gen === selectionGen) {
        setState({ conversations, currentId: conv.id, view: 'chat', editor: null, convLoading: false });
      } else {
        setState({ conversations });
      }
      void refreshSummaries();
    } catch (e) {
      setState({ notice: errText(e) });
    }
  },

  async deleteConversation(id: string): Promise<void> {
    try {
      await api().conversations.remove(id);
    } catch (e) {
      setState({ notice: errText(e) });
      return;
    }
    bumpRev(convEpoch, id);
    bumpRev(convLocalRev, id);
    liveDeltas.delete(id);
    pendingEvents.delete(id);
    const conversations = { ...state.conversations };
    delete conversations[id];
    const drafts = { ...state.drafts };
    delete drafts[id];
    const summaries = state.summaries.filter((s) => s.id !== id);
    setState({ conversations, drafts, summaries });
    if (state.currentId === id) {
      if (summaries[0]) await actions.selectConversation(summaries[0].id);
      else await actions.newConversation();
    }
  },

  async renameConversation(id: string, title: string): Promise<void> {
    const trimmed = title.trim();
    if (!trimmed) return;
    bumpRev(convLocalRev, id);
    renamingConvs.add(id);
    try {
      await api().conversations.rename(id, trimmed);
      const cd = state.conversations[id];
      if (cd) setConv(id, { ...cd, title: trimmed });
      setState({ summaries: state.summaries.map((s) => (s.id === id ? { ...s, title: trimmed } : s)) });
      void refreshSummaries();
    } catch (e) {
      setState({ notice: errText(e) });
    } finally {
      renamingConvs.delete(id);
    }
  },

  setDraft(convId: string, text: string): void {
    setState({ drafts: { ...state.drafts, [convId]: text } });
  },

  async send(convId: string, rawText: string): Promise<void> {
    const text = rawText.trim();
    const cd = state.conversations[convId];
    if (!text || !cd?.loaded) return;
    if (state.pendingSend[convId] || convStreaming(cd)) return;
    const epoch = convEpoch.get(convId) ?? 0;
    setState({ pendingSend: { ...state.pendingSend, [convId]: true }, notice: null });
    try {
      const { user, assistant } = await api().chat.send(convId, text);
      if ((convEpoch.get(convId) ?? 0) !== epoch) return; // 会话在发送期间被删除
      const base = state.conversations[convId] ?? cd;
      const next = flushPending(convId, {
        ...base,
        messages: upsertMessages(convId, base.messages, [user, assistant]),
      });
      setConv(convId, next);
      // 仅当草稿仍等于本次提交的内容时才清空；等待期间新输入的文字保留
      if (state.drafts[convId] === rawText) {
        const drafts = { ...state.drafts };
        delete drafts[convId];
        setState({ drafts });
      }
      void refreshSummaries();
    } catch (e) {
      setState({ notice: errText(e) });
    } finally {
      const pendingSend = { ...state.pendingSend };
      delete pendingSend[convId];
      setState({ pendingSend });
    }
  },

  async abort(convId: string): Promise<void> {
    try {
      await api().chat.abort(convId);
    } catch (e) {
      setState({ notice: errText(e) });
    }
  },

  retry(convId: string, assistantMessageId: string): void {
    const cd = state.conversations[convId];
    if (!cd || convStreaming(cd) || state.pendingSend[convId]) return;
    const idx = cd.messages.findIndex((m) => m.id === assistantMessageId);
    const end = idx < 0 ? cd.messages.length : idx;
    for (let i = end - 1; i >= 0; i--) {
      const m = cd.messages[i];
      if (m.role === 'user') {
        void actions.send(convId, m.text);
        return;
      }
    }
  },

  async setConversationModel(convId: string, ref: ModelRef): Promise<void> {
    const cd = state.conversations[convId];
    if (!cd || convStreaming(cd) || state.pendingSend[convId]) return;
    bumpRev(convLocalRev, convId);
    try {
      await api().conversations.setModel(convId, ref);
      const now = state.conversations[convId];
      if (now) setConv(convId, { ...now, model: ref });
      void refreshSummaries();
    } catch (e) {
      setState({ notice: errText(e) });
    }
  },

  openSettings(): void {
    setState({ view: 'settings' });
  },

  openEditor(id: string | null): void {
    setState({ editor: { id }, view: 'settings' });
  },

  closeEditor(): void {
    setState({ editor: null });
  },

  dismissNotice(): void {
    setState({ notice: null });
  },

  async ensureProviderModels(id: string): Promise<void> {
    if (state.modelsByProvider[id]) return;
    try {
      const models = await api().providers.models(id);
      if (!state.modelsByProvider[id]) {
        const modelsByProvider = { ...state.modelsByProvider, [id]: models };
        const modelLoadErrors = { ...state.modelLoadErrors };
        delete modelLoadErrors[id];
        setState({ modelsByProvider, modelLoadErrors });
      }
    } catch (e) {
      setState({ modelLoadErrors: { ...state.modelLoadErrors, [id]: errText(e) } });
    }
  },

  /** 重取某厂商模型并同步进 allModels（enabled 时并入、disabled 时剔除） */
  async reloadProviderModels(id: string): Promise<void> {
    try {
      const models = await api().providers.models(id);
      const provider = state.providers.find((p) => p.id === id);
      const modelsByProvider = { ...state.modelsByProvider, [id]: models };
      const modelLoadErrors = { ...state.modelLoadErrors };
      delete modelLoadErrors[id];
      const allModels = [
        ...state.allModels.filter((m) => m.providerId !== id),
        ...(provider?.enabled ? models : []),
      ];
      setState({ modelsByProvider, modelLoadErrors, allModels });
    } catch (e) {
      setState({ modelLoadErrors: { ...state.modelLoadErrors, [id]: errText(e) } });
    }
  },

  /** 保存只认后端返回；成功后先落本地再刷新，刷新失败不回滚也不吞掉结果 */
  async saveProvider(input: ProviderInput): Promise<ProviderConfig> {
    const saved = await api().providers.save(input);
    const providers = [...state.providers.filter((p) => p.id !== saved.id), saved].sort(
      (a, b) => a.createdAt - b.createdAt,
    );
    const modelsByProvider = { ...state.modelsByProvider };
    delete modelsByProvider[saved.id];
    const allModels = state.allModels.filter((m) => m.providerId !== saved.id);
    setState({ providers, modelsByProvider, allModels });
    void actions.reloadProviderModels(saved.id);
    try {
      await refreshProviders();
    } catch (e) {
      setState({ notice: `已保存，但刷新列表失败：${errText(e)}` });
    }
    return saved;
  },

  async toggleProvider(p: ProviderConfig): Promise<void> {
    try {
      await actions.saveProvider({
        id: p.id,
        name: p.name,
        kind: p.kind,
        builtinProvider: p.builtinProvider,
        baseUrl: p.baseUrl,
        enabled: !p.enabled,
        customModels: [...p.customModels],
      });
    } catch (e) {
      setState({ notice: errText(e) });
    }
  },

  async testProviderModel(providerId: string, modelId: string): Promise<TestResult> {
    try {
      return await api().providers.test(providerId, modelId);
    } catch (e) {
      return { ok: false, error: errText(e) };
    }
  },

  async removeProvider(id: string): Promise<void> {
    try {
      await api().providers.remove(id);
    } catch (e) {
      setState({ notice: errText(e) });
      return;
    }
    // 先本地应用删除，刷新失败也不回滚
    const modelsByProvider = { ...state.modelsByProvider };
    delete modelsByProvider[id];
    const providers = state.providers.filter((p) => p.id !== id);
    const allModels = state.allModels.filter((m) => m.providerId !== id);
    setState({ modelsByProvider, providers, allModels, editor: null });
    try {
      await refreshProviders();
    } catch (e) {
      setState({ notice: `厂商已删除，但刷新列表失败：${errText(e)}` });
    }
  },

  async setDefaultModel(ref: ModelRef): Promise<void> {
    try {
      const settings = await api().settings.set({ defaultModel: ref });
      setState({ settings });
    } catch (e) {
      setState({ notice: errText(e) });
    }
  },

  async setTheme(theme: AppSettings['theme']): Promise<void> {
    try {
      const settings = await api().settings.set({ theme });
      applyTheme(settings.theme);
      setState({ settings });
    } catch (e) {
      setState({ notice: errText(e) });
    }
  },
};
