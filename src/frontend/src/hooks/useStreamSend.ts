import { useState, useRef, useCallback, useEffect } from 'react';
import { api } from '../api/client';
import { streamConversation, streamOrchestrate, type StreamEvent } from '../api/streamClient';
import { confirm as confirmDialog } from '../components/ui/confirm-dialog';
import { sendNotification } from '../lib/notifications';
import { useActivityStore } from '../store/activityStore';

export interface Attachment {
  name: string;
  dataUrl: string;
}

export interface StreamSendOptions {
  /** Current conversation ID (null for new conversation) */
  conversationId: string | null;
  /** Current mode: 'normal' or 'super' */
  mode: 'normal' | 'super';
  /** Current messages array (for history) */
  messages: Array<{ id: string; role: string; content: string; reasoning?: string | null }>;
  /** Deep thinking mode */
  deepThinking: boolean;
  /** Web search enabled */
  webSearch: boolean;
  /** Loop mode */
  loopMode: boolean;
  /** Selected provider (for normal mode) */
  selectedProvider?: { id: string; models?: string[]; defaultModel?: string } | null;
  /** Selected model (for normal mode) */
  selectedModel?: string;
  /** Attachments to send */
  attachments?: Attachment[];
  /** Called when sending starts */
  onSendStart?: () => void;
  /** Called when sending ends (success or error) */
  onSendEnd?: (success: boolean) => void;
  /** Called when tokens are received */
  onTokens?: (tokens: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) => void;
  /** Called when retry info is received */
  onRetry?: (retry: { attempt: number; maxRetries: number; status: number; delay: number } | null) => void;
  /** Called when live reasoning is updated */
  onLiveReasoning?: (reasoning: string) => void;
  /** Called to update messages (optimistic + final) */
  onMessagesUpdate: (updater: (prev: any[]) => any[]) => void;
  /** Called when conversation ID changes (new conversation created) */
  onConversationCreated?: (id: string) => void;
  /** Called to load messages after send completes */
  onLoadMessages?: (id: string) => Promise<void>;
  /** Called to reload conversations list */
  onLoadConversations?: () => Promise<void>;
  /** Current conversation ref (for race condition guards) */
  currentConvRef: React.MutableRefObject<string | null>;
  /** Abort controller ref (for FE-05: new controller per send) */
  abortRef: React.MutableRefObject<AbortController | null>;
  /** Mounted ref (for cleanup on unmount) */
  mountedRef?: React.MutableRefObject<boolean>;
}

export interface UseStreamSendReturn {
  sending: boolean;
  thinking: boolean;
  streamTokens: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | null;
  retryInfo: { attempt: number; maxRetries: number; status: number; delay: number } | null;
  liveReasoning: string;
  handleSend: (contentOverride?: string) => Promise<void>;
  stopGeneration: () => void;
  setSending: React.Dispatch<React.SetStateAction<boolean>>;
  setThinking: React.Dispatch<React.SetStateAction<boolean>>;
}

/**
 * Shared hook for streaming send logic (FE-05 compliant):
 * - New AbortController per send
 * - Optimistic UI (temp user + AI messages)
 * - rAF flush for smooth streaming
 * - Activity store integration
 * - Abort handling (local + backend cancel)
 * - Supports both normal (streamConversation) and super (streamOrchestrate) modes
 * - Attachments and model selector options
 */
export function useStreamSend(options: StreamSendOptions): UseStreamSendReturn {
  const {
    conversationId,
    mode,
    messages,
    deepThinking,
    webSearch,
    loopMode,
    selectedProvider,
    selectedModel,
    attachments = [],
    onSendStart,
    onSendEnd,
    onTokens,
    onRetry,
    onLiveReasoning,
    onMessagesUpdate,
    onConversationCreated,
    onLoadMessages,
    onLoadConversations,
    currentConvRef,
    abortRef,
    mountedRef,
  } = options;

  const [sending, setSending] = useState(false);
  const [thinking, setThinking] = useState(false);
  const [streamTokens, setStreamTokens] = useState<{ prompt_tokens: number; completion_tokens: number; total_tokens: number } | null>(null);
  const [retryInfo, setRetryInfo] = useState<{ attempt: number; maxRetries: number; status: number; delay: number } | null>(null);
  const [liveReasoning, setLiveReasoning] = useState<string>('');

  // rAF flush state
  const rafPendingRef = useRef(false);
  const accumulatedContentRef = useRef('');
  const reasoningContentRef = useRef('');

  const flushUI = useCallback(() => {
    rafPendingRef.current = false;
    if (mountedRef && !mountedRef.current) return;
    const content = accumulatedContentRef.current;
    if (reasoningContentRef.current) {
      setLiveReasoning(reasoningContentRef.current);
      onLiveReasoning?.(reasoningContentRef.current);
    }
    onMessagesUpdate(prev => prev.map(m =>
      m.id === 'temp-ai-streaming' ? { ...m, content } : m
    ));
  }, [mountedRef, onLiveReasoning, onMessagesUpdate]);

  const scheduleFlush = useCallback(() => {
    if (!rafPendingRef.current) {
      rafPendingRef.current = true;
      requestAnimationFrame(flushUI);
    }
  }, [flushUI]);

  // FE-05: Check if error is user abort
  const isAbortError = useCallback((e: unknown): boolean => {
    return e instanceof Error && (e.name === 'AbortError' || (e.name === 'TypeError' && /abort|load failed/i.test(e.message)));
  }, []);

  const handleSend = useCallback(async (contentOverride?: string) => {
    const currentConv = currentConvRef.current;
    if (!currentConv || sending) return;

    const content = (contentOverride ?? '').trim();
    const currentAttachments = attachments;
    if ((!content && currentAttachments.length === 0) || sending) return;

    setSending(true);
    setThinking(true);
    onSendStart?.();
    setRetryInfo(null);
    onRetry?.(null);
    setStreamTokens(null);
    onTokens?.({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 });
    setLiveReasoning('');
    onLiveReasoning?.('');
    accumulatedContentRef.current = '';
    reasoningContentRef.current = '';

    // FE-05: Create new AbortController per send, abort previous
    const prevController = abortRef.current;
    const controller = new AbortController();
    abortRef.current = controller;
    if (prevController) {
      try { prevController.abort(); } catch { /* ignore */ }
    }

    const sendConvId = currentConv;
    const sendController = controller;

    // Optimistic messages
    const tempUserMsg = { id: `temp-user-${Date.now()}`, role: 'user', content, createdAt: new Date().toISOString() };
    const tempAiMsg = { id: 'temp-ai-streaming', role: 'assistant', content: '', createdAt: new Date().toISOString() };
    onMessagesUpdate(prev => [...prev, tempUserMsg, tempAiMsg]);

    try {
      if (mode === 'super') {
        // Super mode: streamOrchestrate
        const history = messages.filter(m => m.role === 'user' || m.role === 'assistant');
        const imageAttachments = currentAttachments.filter(a => a.dataUrl.startsWith('data:image/'));
        const fileAttachments = currentAttachments.filter(a => !a.dataUrl.startsWith('data:image/'));

        // P1-13：不再清空整个 conversation 的历史 Activity —— Conversation 是历史容器，
        // 支持 Run1/Run2/Run3 并存。新 Run 的事件由 appendEvent 追加（按 runId 隔离去重）。
        await streamOrchestrate(
          {
            prompt: content,
            conversationId: sendConvId,
            history,
            images: imageAttachments.map(a => a.dataUrl),
            files: fileAttachments.map(a => ({ name: a.name, dataUrl: a.dataUrl })),
            deepThinking,
            webSearch,
            loop: loopMode,
          },
          {
            onEvent: (event: StreamEvent) => {
              if (currentConvRef.current !== sendConvId) return;
              if (mountedRef && !mountedRef.current) return;

              switch (event.kind) {
                case 'envelope': {
                  const ev = event.ev;
                  useActivityStore.getState().appendEvent(sendConvId, ev);

                  // ask-user approval
                  if (ev.eventType === 'task.ask-confirm' && ev.metadata?.approvalId) {
                    const apId = String(ev.metadata.approvalId);
                    const toolName = String(ev.metadata.toolName || '工具');
                    const argsSummary = String(ev.metadata.argsSummary || '');
                    void (async () => {
                      const ok = await confirmDialog({
                        title: '🔐 需要你的确认',
                        message: `AI 请求执行操作：${toolName}\n\n参数：${argsSummary}\n\n是否允许？（Level 1 只读模式下需要显式授权）`,
                        confirmText: '允许',
                        cancelText: '拒绝',
                      });
                      try {
                        await api.decideApproval(apId, ok ? 'approved' : 'rejected');
                      } catch { /* ignore */ }
                    })();
                  }

                  // Final output to bubble
                  if (ev.eventType === 'agent.output.delta' && ev.content) {
                    accumulatedContentRef.current += ev.content;
                    scheduleFlush();
                  } else if (ev.eventType === 'agent.error' || ev.eventType === 'task.failed') {
                    accumulatedContentRef.current += `\n❌ ${ev.content || '错误'}\n`;
                    scheduleFlush();
                  }
                  break;
                }
                case 'text-delta': {
                  accumulatedContentRef.current += event.text;
                  scheduleFlush();
                  break;
                }
                case 'reasoning-delta': {
                  reasoningContentRef.current = (reasoningContentRef.current ? reasoningContentRef.current + '\n' : '') + event.text;
                  scheduleFlush();
                  break;
                }
                case 'usage': {
                  setStreamTokens(event.usage);
                  onTokens?.(event.usage);
                  break;
                }
                case 'retry': {
                  setRetryInfo(event.retry);
                  onRetry?.(event.retry);
                  break;
                }
                case 'stream-truncated': {
                  if (currentConvRef.current !== sendConvId) return;
                  accumulatedContentRef.current += '\n⚠️ 响应流中断（未收到完整结束标记）\n';
                  scheduleFlush();
                  break;
                }
                case 'error': {
                  if (currentConvRef.current !== sendConvId) return;
                  accumulatedContentRef.current += `\n❌ ${event.message}\n`;
                  scheduleFlush();
                  break;
                }
              }
            },
          },
          sendController.signal,
        );

        // Final flush
        if (rafPendingRef.current) flushUI();
        if (currentConvRef.current !== sendConvId) return;

        sendNotification('AI 回复完成', { body: accumulatedContentRef.current.slice(0, 100) });
        onMessagesUpdate(prev => [
          ...prev.filter(m => m.id !== 'temp-ai-streaming' && !m.id.startsWith('temp-user-')),
          tempUserMsg,
          { id: 'temp-ai-streaming-done', role: 'assistant', content: accumulatedContentRef.current, createdAt: new Date().toISOString() },
        ]);
      } else {
        // Normal mode: streamConversation
        const imageAttachments = currentAttachments.filter(a => a.dataUrl.startsWith('data:image/'));
        const fileAttachments = currentAttachments.filter(a => !a.dataUrl.startsWith('data:image/'));

        // P1-13：不再 clearConv —— 保留历史 Run 的 Activity，新事件追加
        await streamConversation(
          sendConvId,
          content,
          {
            onEvent: (event: StreamEvent) => {
              if (currentConvRef.current !== sendConvId) return;
              if (mountedRef && !mountedRef.current) return;

              switch (event.kind) {
                case 'envelope': {
                  const ev = event.ev;
                  useActivityStore.getState().appendEvent(sendConvId, ev);

                  if (ev.eventType === 'task.ask-confirm' && ev.metadata?.approvalId) {
                    const apId = String(ev.metadata.approvalId);
                    const toolName = String(ev.metadata.toolName || '工具');
                    const argsSummary = String(ev.metadata.argsSummary || '');
                    void (async () => {
                      const ok = await confirmDialog({
                        title: '🔐 需要你的确认',
                        message: `AI 请求执行操作：${toolName}\n\n参数：${argsSummary}\n\n是否允许？（Level 1 只读模式下需要显式授权）`,
                        confirmText: '允许',
                        cancelText: '拒绝',
                      });
                      try {
                        await api.decideApproval(apId, ok ? 'approved' : 'rejected');
                      } catch { /* ignore */ }
                    })();
                  }
                  break;
                }
                case 'text-delta': {
                  setRetryInfo(null);
                  onRetry?.(null);
                  accumulatedContentRef.current += event.text;
                  scheduleFlush();
                  break;
                }
                case 'reasoning-delta': {
                  reasoningContentRef.current = (reasoningContentRef.current ? reasoningContentRef.current + '\n' : '') + event.text;
                  scheduleFlush();
                  break;
                }
                case 'usage': {
                  setStreamTokens(event.usage);
                  onTokens?.(event.usage);
                  break;
                }
                case 'tool-call': {
                  // Tool calls are handled via envelope in unified protocol
                  break;
                }
                case 'tool-result': {
                  setRetryInfo(null);
                  onRetry?.(null);
                  break;
                }
                case 'replace': {
                  accumulatedContentRef.current = event.content;
                  scheduleFlush();
                  break;
                }
                case 'retry': {
                  setRetryInfo(event.retry);
                  onRetry?.(event.retry);
                  break;
                }
                case 'stream-truncated': {
                  if (currentConvRef.current !== sendConvId) return;
                  accumulatedContentRef.current += '\n⚠️ 响应流中断（未收到完整结束标记）\n';
                  scheduleFlush();
                  break;
                }
                case 'error': {
                  if (currentConvRef.current !== sendConvId) return;
                  accumulatedContentRef.current += `\n❌ ${event.message}\n`;
                  scheduleFlush();
                  break;
                }
              }
            },
          },
          {
            signal: sendController.signal,
            deepThinking,
            reasoningEffort: deepThinking ? 'medium' : undefined,
            webSearch,
            loop: loopMode,
            images: imageAttachments.map(a => a.dataUrl),
            providerId: selectedProvider?.id,
            model: selectedModel,
            files: fileAttachments.map(a => ({ name: a.name, dataUrl: a.dataUrl })),
          },
        );

        if (rafPendingRef.current) flushUI();
        if (currentConvRef.current !== sendConvId) return;

        sendNotification('AI 回复完成', { body: accumulatedContentRef.current.slice(0, 100) });
        onMessagesUpdate(prev => [
          ...prev.filter(m => m.id !== 'temp-ai-streaming' && !m.id.startsWith('temp-user-')),
          tempUserMsg,
          { id: 'temp-ai-streaming-done', role: 'assistant', content: accumulatedContentRef.current, createdAt: new Date().toISOString() },
        ]);
      }

      // Reload messages and conversations
      if (onLoadMessages) await onLoadMessages(sendConvId);
      if (onLoadConversations) await onLoadConversations();
      onSendEnd?.(true);
    } catch (e: unknown) {
      if (isAbortError(e)) {
        if (currentConvRef.current === sendConvId && abortRef.current === sendController) {
          onMessagesUpdate(prev => prev.map(m =>
            m.id === 'temp-ai-streaming' ? { ...m, content: (m.content || '') + '\n\n⏹ 已停止生成' } : m
          ));
        }
      } else {
        if (currentConvRef.current === sendConvId && abortRef.current === sendController) {
          onMessagesUpdate(prev => prev.map(m =>
            m.id === 'temp-ai-streaming' ? { ...m, content: (m.content || '') + `\n\n❌ 错误: ${e instanceof Error ? e.message : String(e)}` } : m
          ));
        }
      }
      onSendEnd?.(false);
    } finally {
      // FE-05: Only cleanup if this is still the latest send
      if (abortRef.current === sendController && currentConvRef.current === sendConvId) {
        setSending(false);
        setThinking(false);
        setLiveReasoning('');
        onLiveReasoning?.('');
      }
    }
  }, [
    conversationId,
    mode,
    messages,
    deepThinking,
    webSearch,
    loopMode,
    selectedProvider,
    selectedModel,
    attachments,
    sending,
    onSendStart,
    onSendEnd,
    onTokens,
    onRetry,
    onLiveReasoning,
    onMessagesUpdate,
    onConversationCreated,
    onLoadMessages,
    onLoadConversations,
    currentConvRef,
    abortRef,
    mountedRef,
    isAbortError,
    flushUI,
    scheduleFlush,
  ]);

  const stopGeneration = useCallback(() => {
    if (abortRef.current) {
      abortRef.current.abort();
    }
    if (currentConvRef.current) {
      api.cancelConversation(currentConvRef.current).catch(() => {});
      api.cancelAgentGeneration(currentConvRef.current).catch(() => {});
    }
    setSending(false);
    setThinking(false);
  }, [currentConvRef, abortRef]);

  return {
    sending,
    thinking,
    streamTokens,
    retryInfo,
    liveReasoning,
    handleSend,
    stopGeneration,
    setSending,
    setThinking,
  };
}