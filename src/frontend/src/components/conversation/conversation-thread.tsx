/**
 * 会话消息区（Chat / CodingHome 同一实现）。
 *
 * 内聚的东西：滚动意图锁（用户上滑即停止自动滚底 + "回到底部"）、消息气泡、Activity 流、
 * 处理中指示、失败态。两条路此前各写一份，且 Chat 的滚动 effect 依赖 `sending` 而
 * CodingHome 依赖 `messages + sending` —— 收敛后行为一致。
 *
 * `children` 渲染在滚动容器内（Chat 的 ReasoningBar / 加载失败 / 轮询状态机）。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import type { StreamFailure } from '../../hooks/useStreamSend';
import { ConversationActivityStream } from './activity-stream';
import { ConversationMessageBubble, type ConversationMessage } from './message-bubble';
import { StreamFailureState } from './stream-failure';
import { ThinkingDots } from './thinking-dots';

export interface ConversationThreadProps {
  readonly messages: readonly ConversationMessage[];
  readonly conversationId: string | null;
  readonly sending: boolean;
  readonly thinking: boolean;
  readonly failure: StreamFailure | null;
  readonly onRetryFailure: () => void;
  readonly children?: ReactNode;
}

export function ConversationThread({
  messages, conversationId, sending, thinking, failure, onRetryFailure, children,
}: ConversationThreadProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const [userScrolledUp, setUserScrolledUp] = useState(false);

  // 阈值 40px：小幅上滑仍判为"在底部"，不会被误拉回
  const isNearBottom = useCallback(() => {
    const el = listRef.current;
    if (!el) return true;
    return el.scrollHeight - el.scrollTop - el.clientHeight < 40;
  }, []);

  const scrollToBottom = useCallback(() => {
    setUserScrolledUp(false);
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  // 新消息到达时自动滚底 —— 用户主动上滑阅读历史时不得被拉回
  useEffect(() => {
    if (userScrolledUp) return;
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages, sending, userScrolledUp]);

  return (
    <div
      ref={listRef}
      onScroll={() => { setUserScrolledUp(!isNearBottom()); }}
      aria-live="polite"
      className="flex-1 overflow-y-auto min-h-0"
      style={{ display: 'flex', flexDirection: 'column', gap: 16, padding: '8px 8px 16px', overflowAnchor: 'none', position: 'relative' }}
    >
      {userScrolledUp && (
        <button
          type="button"
          onClick={scrollToBottom}
          style={{
            position: 'sticky', top: 8, alignSelf: 'center', zIndex: 5, display: 'block', margin: '0 auto 8px',
            fontSize: 12, padding: '4px 14px', borderRadius: 99, cursor: 'pointer',
            background: 'var(--bg-surface)', color: 'var(--color-accent)',
            border: '1px solid var(--border-primary)', boxShadow: '0 2px 12px rgba(0,0,0,0.3)',
          }}
          title="回到最新消息"
          aria-label="回到底部"
        >
          ⬇ 回到底部
        </button>
      )}
      {messages.map((message, index) => (
        <ConversationMessageBubble key={message.id} message={message} index={index} />
      ))}
      <ConversationActivityStream conversationId={conversationId} />
      {/* sending 覆盖"另一个标签页正在生成"（轮询 generating），thinking 覆盖本地流 */}
      {(sending || thinking) && <ThinkingDots />}
      {failure && <StreamFailureState failure={failure} onRetry={onRetryFailure} />}
      {children}
    </div>
  );
}
