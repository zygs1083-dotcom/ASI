import { ArrowUp, Square } from 'lucide-react';
import { useEffect, useRef } from 'react';
import type { ChatMessage } from '../../shared/types';
import { Markdown } from '../components/Markdown';
import { ModelPicker } from '../components/ModelPicker';
import { actions, type ConvState, convStreaming, useAppState } from '../store';

function UserMessage({ m }: { m: ChatMessage }) {
  return (
    <div className="msg-row user">
      <div className="msg-user" data-testid="msg-user" data-status={m.status ?? 'done'}>
        {m.text}
      </div>
    </div>
  );
}

function AssistantMessage({
  m,
  convId,
  isLast,
  pending,
}: {
  m: ChatMessage;
  convId: string;
  isLast: boolean;
  pending: boolean;
}) {
  const streaming = m.status === 'streaming';
  // 只有真正的最后一条失败/中止消息才可重试（契约：chat.retry 只针对最后一轮）
  const showRetry = isLast && (m.status === 'error' || m.status === 'aborted');
  return (
    <div className="msg-row assistant">
      <div className="msg-assistant" data-testid="msg-assistant" data-status={m.status ?? 'done'}>
        <Markdown text={m.text} streaming={streaming} />
        {m.status === 'error' && (
          <div className="msg-error" data-testid="msg-error">
            <span className="msg-error-text">{m.error || '出错了，请重试'}</span>
            {showRetry && (
              <button
                type="button"
                className="pill-btn msg-retry"
                aria-label="重试"
                disabled={pending}
                onClick={() => void actions.retry(convId)}
              >
                重试
              </button>
            )}
          </div>
        )}
        {m.status === 'aborted' && (
          <div className="msg-aborted">
            <span>已停止</span>
            {showRetry && (
              <button
                type="button"
                className="pill-btn msg-retry"
                aria-label="重试"
                disabled={pending}
                onClick={() => void actions.retry(convId)}
              >
                重试
              </button>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function Composer({ convId, conv }: { convId: string; conv: ConvState }) {
  const s = useAppState();
  const taRef = useRef<HTMLTextAreaElement>(null);
  const composingRef = useRef(false);
  const draft = s.drafts[convId] ?? '';
  const streaming = convStreaming(conv);
  const pending = !!s.pendingSend[convId];

  const resize = (ta: HTMLTextAreaElement) => {
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 164)}px`;
  };

  // 切换会话或草稿变化时重算高度
  // biome-ignore lint/correctness/useExhaustiveDependencies: 草稿内容变化时也要重算高度
  useEffect(() => {
    const ta = taRef.current;
    if (ta) resize(ta);
  }, [convId, draft]);

  const doSend = () => {
    if (streaming || pending) return;
    void actions.send(convId, draft);
    taRef.current?.focus();
  };

  return (
    <div className="composer-wrap">
      <div className="composer">
        <textarea
          ref={taRef}
          className="composer-input"
          data-testid="composer-input"
          aria-label="输入消息"
          placeholder="输入消息，Enter 发送，Shift+Enter 换行"
          rows={1}
          value={draft}
          onChange={(e) => actions.setDraft(convId, e.target.value)}
          onCompositionStart={() => {
            composingRef.current = true;
          }}
          onCompositionEnd={() => {
            composingRef.current = false;
          }}
          onKeyDown={(e) => {
            if (e.key !== 'Enter' || e.shiftKey) return;
            const ne = e.nativeEvent as KeyboardEvent & { keyCode?: number };
            if (composingRef.current || ne.isComposing || ne.keyCode === 229) return;
            e.preventDefault();
            doSend();
          }}
        />
        <div className="composer-bar">
          <ModelPicker
            testId="model-picker"
            value={conv.model}
            models={s.allModels}
            providers={s.providers}
            disabled={streaming || pending}
            onChange={(ref) => void actions.setConversationModel(convId, ref)}
          />
          {streaming ? (
            <button
              type="button"
              className="send-btn"
              data-testid="composer-stop"
              aria-label="停止生成"
              onClick={() => void actions.abort(convId)}
            >
              <Square size={12} strokeWidth={1.5} fill="currentColor" aria-hidden="true" />
            </button>
          ) : (
            <button
              type="button"
              className="send-btn"
              data-testid="composer-send"
              aria-label="发送"
              disabled={!draft.trim() || pending}
              onClick={doSend}
            >
              <ArrowUp size={16} strokeWidth={1.5} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function ChatView() {
  const s = useAppState();
  const convId = s.currentId;
  const conv = convId ? s.conversations[convId] : undefined;
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedRef = useRef(true);

  const messageCount = conv?.messages.length ?? 0;
  const lastText = conv?.messages[messageCount - 1]?.text;
  // biome-ignore lint/correctness/useExhaustiveDependencies: 有意在消息数/末条文本/会话切换时触发滚动
  useEffect(() => {
    const el = scrollRef.current;
    if (el && pinnedRef.current) el.scrollTop = el.scrollHeight;
  }, [convId, messageCount, lastText]);

  if (!convId || !conv) {
    return <div className="chat-loading">{s.convLoading ? '加载中…' : ''}</div>;
  }

  const empty = conv.messages.length === 0 && !s.convLoading;
  const noProviders = s.providers.length === 0;

  return (
    <div className="chat">
      <div
        className="chat-scroll"
        ref={scrollRef}
        onScroll={(e) => {
          const el = e.currentTarget;
          pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        <div className={`chat-col${empty ? ' fill' : ''}`}>
          {s.convLoading && !conv.loaded && <div className="chat-loading">加载中…</div>}
          {empty ? (
            <div className="chat-empty" data-testid="chat-empty">
              <div className="chat-empty-title">开始对话</div>
              {noProviders ? (
                <button
                  type="button"
                  className="pill-btn go-settings"
                  data-testid="go-settings"
                  aria-label="先去配置模型厂商"
                  onClick={() => actions.openSettings()}
                >
                  先去配置模型厂商
                </button>
              ) : (
                <ModelPicker
                  testId="model-picker-empty"
                  value={conv.model}
                  models={s.allModels}
                  providers={s.providers}
                  onChange={(ref) => void actions.setConversationModel(convId, ref)}
                />
              )}
            </div>
          ) : (
            conv.messages.map((m, i) =>
              m.role === 'user' ? (
                <UserMessage key={m.id} m={m} />
              ) : (
                <AssistantMessage
                  key={m.id}
                  m={m}
                  convId={convId}
                  isLast={i === conv.messages.length - 1}
                  pending={!!s.pendingSend[convId]}
                />
              ),
            )
          )}
        </div>
      </div>
      <Composer convId={convId} conv={conv} />
    </div>
  );
}
