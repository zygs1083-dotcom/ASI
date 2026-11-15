import { randomUUID } from 'node:crypto';
import type { Api, AssistantMessage, Context, Message, Model, Usage } from '@mariozechner/pi-ai';
import { complete, stream } from '@mariozechner/pi-ai';
import type {
  ChatEvent,
  ChatMessage,
  Conversation,
  MessageStatus,
  ModelRef,
  TestResult,
} from '../../shared/types';
import type { ConversationStore } from '../stores/conversation-store';
import { FAUX_PROVIDER_ID, type ProviderStore } from '../stores/provider-store';
import { KeyRedactor, redactKeys } from './key-redactor';
import type { ModelResolver } from './model-resolver';

/** faux 厂商不需要真实 key，传固定哨兵避免 pi-ai 回退到环境变量里的真实凭证 */
const FAUX_API_KEY = 'asi-faux';
const TEST_TIMEOUT_MS = 15000;
/** abort 后等待底层流结束的最长时间，超过则强制终结 */
const ABORT_LIMIT_MS = 2000;

interface ActiveRequest {
  controller: AbortController;
  /** run 结束后 resolve，永不 reject */
  completion: Promise<void>;
}

interface StreamTarget {
  model: Model<Api>;
  apiKey: string;
  providerId: string;
  modelRef: ModelRef;
}

function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

export class ChatService {
  private readonly active = new Map<string, ActiveRequest>();

  constructor(
    private readonly providers: ProviderStore,
    private readonly conversations: ConversationStore,
    private readonly resolver: ModelResolver,
    private readonly emit: (event: ChatEvent) => void,
  ) {}

  async send(conversationId: string, text: string): Promise<{ user: ChatMessage; assistant: ChatMessage }> {
    // 同步校验（首个 await 之前完成）：任何失败都不追加消息
    const conv = this.requireIdle(conversationId);
    if (text.trim() === '') {
      throw new Error('消息内容不能为空');
    }
    const target = this.resolveTarget(conv);

    const now = Date.now();
    const user: ChatMessage = { id: randomUUID(), role: 'user', text, createdAt: now, status: 'done' };
    const assistant = this.newAssistant(now, target.modelRef);

    const messages: Message[] = conv.messages
      .filter((m) => m.status === 'done')
      .map((m) => this.toHistoryMessage(m, target.model));
    messages.push({ role: 'user', content: text, timestamp: user.createdAt });
    const context: Context = { messages };

    this.conversations.appendMessages(conversationId, [user, assistant]);
    this.schedule(conversationId, assistant, target, context);
    return { user: structuredClone(user), assistant: structuredClone(assistant) };
  }

  async retry(conversationId: string): Promise<{ assistant: ChatMessage }> {
    const conv = this.requireIdle(conversationId);
    const last = conv.messages[conv.messages.length - 1];
    if (last?.role !== 'assistant' || (last.status !== 'error' && last.status !== 'aborted')) {
      throw new Error('只能重试最后一轮失败或已停止的回复');
    }
    // 全部校验（模型/厂商/key）通过后才允许改动会话
    const target = this.resolveTarget(conv);
    const assistant = this.newAssistant(Date.now(), target.modelRef);
    // 上下文 = 被替换 assistant 之前的 done 历史（原 user 消息已在其中，不重复追加）
    const context: Context = {
      messages: conv.messages
        .slice(0, -1)
        .filter((m) => m.status === 'done')
        .map((m) => this.toHistoryMessage(m, target.model)),
    };
    this.conversations.replaceLastMessage(conversationId, last.id, assistant);
    this.schedule(conversationId, assistant, target, context);
    return { assistant: structuredClone(assistant) };
  }

  /** 同步校验：会话存在且没有进行中的请求 */
  private requireIdle(conversationId: string): Conversation {
    if (this.active.has(conversationId)) {
      throw new Error('该会话已有进行中的回复，请等待完成或先停止');
    }
    const conv = this.conversations.get(conversationId);
    if (!conv) {
      throw new Error('会话不存在');
    }
    return conv;
  }

  /** 当前已保存的全部 key：每次调用取最新值，中途新增/轮换的 key 也受保护 */
  private savedKeys(): string[] {
    return this.providers.getRedactionKeys();
  }

  /** 同步解析模型/厂商/key；任何一步失败都不允许调用方改动会话 */
  private resolveTarget(conv: Conversation): StreamTarget {
    const modelRef = conv.model;
    if (!modelRef) {
      throw new Error('请先为会话选择模型');
    }
    const provider = this.providers.get(modelRef.providerId);
    if (!provider) {
      throw new Error('模型所属厂商不存在');
    }
    if (!provider.enabled) {
      throw new Error('模型所属厂商已停用');
    }
    let model: Model<Api>;
    try {
      model = this.resolver.resolve(provider, modelRef.modelId);
    } catch (err) {
      throw new Error(this.mask(err, this.savedKeys()));
    }
    let apiKey: string | undefined;
    try {
      apiKey = provider.id === FAUX_PROVIDER_ID ? FAUX_API_KEY : this.providers.getApiKey(provider.id);
    } catch (err) {
      throw new Error(this.mask(err, this.savedKeys()));
    }
    if (!apiKey) {
      throw new Error('厂商未设置 API Key');
    }
    return { model, apiKey, providerId: provider.id, modelRef: structuredClone(modelRef) };
  }

  private newAssistant(now: number, modelRef: ModelRef): ChatMessage {
    return {
      id: randomUUID(),
      role: 'assistant',
      text: '',
      createdAt: now,
      model: structuredClone(modelRef),
      status: 'streaming',
    };
  }

  /** 同步占锁并延迟启动 run：占位消息先于任何事件返回给调用方 */
  private schedule(
    conversationId: string,
    assistant: ChatMessage,
    target: StreamTarget,
    context: Context,
  ): void {
    const controller = new AbortController();
    const entry: ActiveRequest = {
      controller,
      completion: new Promise<void>((resolve) => {
        // 延迟到 send/retry 返回之后才开始跑，保证事件不会先于返回值到达
        setTimeout(() => {
          this.run(
            conversationId,
            assistant,
            target.model,
            context,
            target.apiKey,
            target.providerId,
            controller.signal,
          )
            .catch(() => {})
            .finally(() => {
              if (this.active.get(conversationId) === entry) {
                this.active.delete(conversationId);
              }
              resolve();
            });
        }, 0);
      }),
    };
    this.active.set(conversationId, entry);
  }

  async abort(conversationId: string): Promise<void> {
    const entry = this.active.get(conversationId);
    if (!entry) {
      return;
    }
    entry.controller.abort();
    await entry.completion;
  }

  async test(providerId: string, modelId: string): Promise<TestResult> {
    // 本次请求的脱敏 key 快照：测试挂起期间被删除的已存 key 仍受保护
    const requestKeys = this.savedKeys();
    // 所有失败出口统一过最终脱敏：静态错误与兜底串也不例外
    const failure = (err: unknown): TestResult => ({
      ok: false,
      error: this.mask(err, [...requestKeys, ...this.savedKeys()]),
    });
    const provider = this.providers.get(providerId);
    if (!provider) {
      return failure('厂商不存在');
    }
    if (!provider.enabled) {
      return failure('厂商已停用');
    }
    let model: Model<Api>;
    try {
      model = this.resolver.resolve(provider, modelId);
    } catch (err) {
      return failure(err);
    }
    let apiKey: string | undefined;
    try {
      apiKey = provider.id === FAUX_PROVIDER_ID ? FAUX_API_KEY : this.providers.getApiKey(provider.id);
    } catch (err) {
      return failure(err);
    }
    if (!apiKey) {
      return failure('厂商未设置 API Key');
    }
    requestKeys.push(apiKey);

    const controller = new AbortController();
    const started = Date.now();
    let timedOut = false;
    let rejectTimeout: (err: Error) => void = () => {};
    const timeout = new Promise<never>((_, reject) => {
      rejectTimeout = reject;
    });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      rejectTimeout(new Error('timeout'));
    }, TEST_TIMEOUT_MS);
    try {
      if (provider.id === FAUX_PROVIDER_ID) {
        this.resolver.prepareFauxResponse('ping');
      }
      // complete 直接跟在 prepare 后同步调用：faux 在 stream 调用时同步取走响应，
      // 中间不允许任何 await/microtask，否则并发的 test() 会互相覆盖响应队列
      const reply = await Promise.race([
        complete(
          model,
          { messages: [{ role: 'user', content: 'ping', timestamp: started }] },
          { apiKey, signal: controller.signal, maxTokens: 16 },
        ),
        timeout,
      ]);
      if (reply.stopReason === 'error' || reply.stopReason === 'aborted') {
        return failure(reply.errorMessage || '测试失败');
      }
      return { ok: true, latencyMs: Math.max(0, Date.now() - started) };
    } catch (err) {
      if (timedOut) {
        return failure('测试连接超时（15 秒）');
      }
      return failure(err);
    } finally {
      clearTimeout(timer);
    }
  }

  private async run(
    conversationId: string,
    assistant: ChatMessage,
    model: Model<Api>,
    context: Context,
    apiKey: string,
    providerId: string,
    signal: AbortSignal,
  ): Promise<void> {
    let status: MessageStatus;
    let errorText: string | undefined;
    // 本次请求的 key 快照：运行期间厂商被删除/轮换也不会让活动 key 失去保护
    const requestKeys = [apiKey, ...this.savedKeys()];
    // 边界处的最终防线：请求快照 + 此刻全部已存 key（中途新增的 key 也受保护）
    const guardKeys = (): string[] => [...requestKeys, ...this.savedKeys()];
    const guard = (text: string): string => redactKeys(text, guardKeys());
    // 所有流式正文先过脱敏器：发出的事件与写盘的快照永远不含完整 key
    const redactor = new KeyRedactor(requestKeys);
    // 消费任务的副作用开关：强制终结后置 false，迟到的 delta/终态全部失效
    let accepting = true;
    let abortTimer: ReturnType<typeof setTimeout> | undefined;
    let forceFinish: () => void = () => {};
    const forced = new Promise<void>((resolve) => {
      forceFinish = resolve;
    });
    const startDeadline = (): void => {
      abortTimer ??= setTimeout(forceFinish, ABORT_LIMIT_MS);
    };
    try {
      if (signal.aborted) {
        // 调度前就已被中止：完全不触碰底层流，直接终结
        status = 'aborted';
        errorText = '已停止';
      } else {
        if (providerId === FAUX_PROVIDER_ID) {
          // 必须在 stream() 之前同步入队：faux 在 stream() 调用时同步取走响应
          this.resolver.prepareFauxResponse(this.lastUserText(context));
        }
        const events = stream(model, context, { apiKey, signal });
        let terminal: 'done' | 'error' | undefined;
        let abortedReason = false;
        let providerError: string | undefined;
        const consume = async (): Promise<void> => {
          for await (const event of events) {
            if (!accepting || signal.aborted) {
              return;
            }
            if (event.type === 'text_delta') {
              const safe = redactor.push(event.delta);
              if (safe === '') {
                continue;
              }
              assistant.text += guard(safe);
              // 累计正文（事件里的权威值）在写盘/发出前再过一次最终脱敏
              assistant.text = guard(assistant.text);
              try {
                this.conversations.updateMessage(conversationId, assistant);
              } catch {
                // 会话被外部删除：继续消费但不回写，绝不复活
              }
              this.safeEmit({
                type: 'delta',
                conversationId,
                messageId: assistant.id,
                delta: guard(safe),
                text: assistant.text,
              });
            } else if (event.type === 'done') {
              terminal = 'done';
            } else if (event.type === 'error') {
              terminal = 'error';
              abortedReason = event.reason === 'aborted';
              providerError = event.error.errorMessage;
            }
          }
        };
        // abort 后最多等 ABORT_LIMIT_MS：不依赖底层迭代器响应取消
        signal.addEventListener('abort', startDeadline, { once: true });
        if (signal.aborted) {
          // 注册前刚好中止：补启动倒计时（幂等）
          startDeadline();
        }
        const outcome = await Promise.race([
          consume().then(
            () => 'consumed' as const,
            (err: unknown) => ({ thrown: err }),
          ),
          forced.then(() => 'forced' as const),
        ]);
        if (outcome === 'forced') {
          status = 'aborted';
          errorText = '已停止';
        } else if (typeof outcome === 'object') {
          throw outcome.thrown;
        } else if (signal.aborted || abortedReason) {
          status = 'aborted';
          errorText = '已停止';
        } else if (terminal === 'done') {
          status = 'done';
        } else {
          status = 'error';
          errorText = providerError ? this.mask(providerError, guardKeys()) : '模型回复失败';
        }
      }
    } catch (err) {
      if (signal.aborted) {
        status = 'aborted';
        errorText = '已停止';
      } else {
        status = 'error';
        errorText = this.mask(err, guardKeys());
      }
    } finally {
      accepting = false;
      if (abortTimer !== undefined) {
        clearTimeout(abortTimer);
      }
      signal.removeEventListener('abort', startDeadline);
    }

    // 把脱敏器扣留的尾部并入正文；aborted 不补发 delta，尾部直接进终态消息
    const tail = guard(redactor.flush());
    if (tail !== '') {
      assistant.text += tail;
      assistant.text = guard(assistant.text);
      if (status !== 'aborted') {
        try {
          this.conversations.updateMessage(conversationId, assistant);
        } catch {
          // 会话被外部删除：不回写
        }
        this.safeEmit({
          type: 'delta',
          conversationId,
          messageId: assistant.id,
          delta: tail,
          text: assistant.text,
        });
      }
    }

    assistant.status = status;
    // 终态前最后一次全量脱敏：权威正文与错误信息都不含完整 key
    assistant.text = guard(assistant.text);
    assistant.error = errorText === undefined ? undefined : guard(errorText);
    let emitType: 'done' | 'error' = status === 'done' ? 'done' : 'error';
    try {
      this.conversations.updateMessage(conversationId, assistant);
      this.conversations.flush(conversationId);
    } catch (err) {
      assistant.status = 'error';
      assistant.error = this.mask(err, guardKeys());
      emitType = 'error';
      try {
        // 尽力把内存里的消息同步到同一错误状态：不再二次 flush、不复活已删会话
        this.conversations.updateMessage(conversationId, assistant);
      } catch {
        // 会话已不存在等情况：不回写
      }
    }
    this.safeEmit({ type: emitType, conversationId, message: structuredClone(assistant) });
  }

  private lastUserText(context: Context): string {
    for (let i = context.messages.length - 1; i >= 0; i--) {
      const m = context.messages[i];
      if (m.role === 'user' && typeof m.content === 'string') {
        return m.content;
      }
    }
    return '';
  }

  private toHistoryMessage(m: ChatMessage, fallback: Model<Api>): Message {
    if (m.role === 'user') {
      return { role: 'user', content: m.text, timestamp: m.createdAt };
    }
    let meta = fallback;
    if (m.model) {
      const provider = this.providers.get(m.model.providerId);
      if (provider) {
        try {
          meta = this.resolver.resolve(provider, m.model.modelId);
        } catch {
          meta = fallback;
        }
      }
    }
    const assistant: AssistantMessage = {
      role: 'assistant',
      content: [{ type: 'text', text: m.text }],
      api: meta.api,
      provider: meta.provider,
      model: meta.id,
      timestamp: m.createdAt,
      stopReason: 'stop',
      usage: zeroUsage(),
    };
    return assistant;
  }

  private safeEmit(event: ChatEvent): void {
    try {
      this.emit(event);
    } catch {
      // 订阅方异常不得影响流式流程的最终结果
    }
  }

  private mask(err: unknown, keys: string[]): string {
    let message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
    if (message === '') {
      message = '未知错误';
    }
    return redactKeys(message, keys);
  }
}
