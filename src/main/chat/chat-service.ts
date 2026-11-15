import { randomUUID } from 'node:crypto';
import type { Api, AssistantMessage, Context, Message, Model, Usage } from '@mariozechner/pi-ai';
import { complete, stream } from '@mariozechner/pi-ai';
import type { ChatEvent, ChatMessage, MessageStatus, TestResult } from '../../shared/types';
import type { ConversationStore } from '../stores/conversation-store';
import { FAUX_PROVIDER_ID, type ProviderStore } from '../stores/provider-store';
import type { ModelResolver } from './model-resolver';

/** faux 厂商不需要真实 key，传固定哨兵避免 pi-ai 回退到环境变量里的真实凭证 */
const FAUX_API_KEY = 'asi-faux';
const TEST_TIMEOUT_MS = 15000;
const KEY_MASK = '[已隐藏]';

interface ActiveRequest {
  controller: AbortController;
  /** run 结束后 resolve，永不 reject */
  completion: Promise<void>;
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
    if (this.active.has(conversationId)) {
      throw new Error('该会话已有进行中的回复，请等待完成或先停止');
    }
    const conv = this.conversations.get(conversationId);
    if (!conv) {
      throw new Error('会话不存在');
    }
    if (text.trim() === '') {
      throw new Error('消息内容不能为空');
    }
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
    const model = this.resolver.resolve(provider, modelRef.modelId);
    let apiKey: string | undefined;
    try {
      apiKey = provider.id === FAUX_PROVIDER_ID ? FAUX_API_KEY : this.providers.getApiKey(provider.id);
    } catch (err) {
      throw new Error(this.mask(err, undefined));
    }
    if (!apiKey) {
      throw new Error('厂商未设置 API Key');
    }

    const now = Date.now();
    const user: ChatMessage = { id: randomUUID(), role: 'user', text, createdAt: now, status: 'done' };
    const assistant: ChatMessage = {
      id: randomUUID(),
      role: 'assistant',
      text: '',
      createdAt: now,
      model: structuredClone(modelRef),
      status: 'streaming',
    };

    const messages: Message[] = conv.messages
      .filter((m) => m.status === 'done')
      .map((m) => this.toHistoryMessage(m, model));
    messages.push({ role: 'user', content: text, timestamp: user.createdAt });
    const context: Context = { messages };

    this.conversations.appendMessages(conversationId, [user, assistant]);

    const controller = new AbortController();
    const entry: ActiveRequest = {
      controller,
      completion: new Promise<void>((resolve) => {
        // 延迟到 send 返回之后才开始跑，保证事件不会先于返回值到达
        setTimeout(() => {
          this.run(conversationId, assistant, model, context, apiKey, provider.id, controller.signal)
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
    return { user: structuredClone(user), assistant: structuredClone(assistant) };
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
    const provider = this.providers.get(providerId);
    if (!provider) {
      return { ok: false, error: '厂商不存在' };
    }
    if (!provider.enabled) {
      return { ok: false, error: '厂商已停用' };
    }
    let model: Model<Api>;
    try {
      model = this.resolver.resolve(provider, modelId);
    } catch (err) {
      return { ok: false, error: this.mask(err, undefined) };
    }
    let apiKey: string | undefined;
    try {
      apiKey = provider.id === FAUX_PROVIDER_ID ? FAUX_API_KEY : this.providers.getApiKey(provider.id);
    } catch (err) {
      return { ok: false, error: this.mask(err, undefined) };
    }
    if (!apiKey) {
      return { ok: false, error: '厂商未设置 API Key' };
    }

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
        return { ok: false, error: this.mask(reply.errorMessage ?? '', apiKey) || '测试失败' };
      }
      return { ok: true, latencyMs: Math.max(0, Date.now() - started) };
    } catch (err) {
      if (timedOut) {
        return { ok: false, error: '测试连接超时（15 秒）' };
      }
      return { ok: false, error: this.mask(err, apiKey) };
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
    try {
      if (providerId === FAUX_PROVIDER_ID) {
        // 必须在 stream() 之前同步入队：faux 在 stream() 调用时同步取走响应
        this.resolver.prepareFauxResponse(this.lastUserText(context));
      }
      const events = stream(model, context, { apiKey, signal });
      let terminal: 'done' | 'error' | undefined;
      let abortedReason = false;
      let providerError: string | undefined;
      for await (const event of events) {
        if (signal.aborted) {
          break;
        }
        if (event.type === 'text_delta') {
          assistant.text += event.delta;
          try {
            this.conversations.updateMessage(conversationId, assistant);
          } catch {
            // 会话被外部删除：继续消费但不回写，绝不复活
          }
          this.safeEmit({ type: 'delta', conversationId, messageId: assistant.id, delta: event.delta });
        } else if (event.type === 'done') {
          terminal = 'done';
        } else if (event.type === 'error') {
          terminal = 'error';
          abortedReason = event.reason === 'aborted';
          providerError = event.error.errorMessage;
        }
      }
      if (signal.aborted || abortedReason) {
        status = 'aborted';
        errorText = '已停止';
      } else if (terminal === 'done') {
        status = 'done';
      } else {
        status = 'error';
        errorText = providerError ? this.mask(providerError, apiKey) : '模型回复失败';
      }
    } catch (err) {
      if (signal.aborted) {
        status = 'aborted';
        errorText = '已停止';
      } else {
        status = 'error';
        errorText = this.mask(err, apiKey);
      }
    }

    assistant.status = status;
    assistant.error = errorText;
    let emitType: 'done' | 'error' = status === 'done' ? 'done' : 'error';
    try {
      this.conversations.updateMessage(conversationId, assistant);
      this.conversations.flush(conversationId);
    } catch (err) {
      assistant.status = 'error';
      assistant.error = this.mask(err, apiKey);
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

  private mask(err: unknown, apiKey: string | undefined): string {
    let message = err instanceof Error ? err.message : typeof err === 'string' ? err : '';
    if (message === '') {
      message = '未知错误';
    }
    if (apiKey) {
      message = message.split(apiKey).join(KEY_MASK);
    }
    return message;
  }
}
