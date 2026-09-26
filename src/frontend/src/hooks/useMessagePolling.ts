import { useEffect, useRef, useCallback, useState } from 'react';
import { api } from '../api/client';
import { fetchEvents } from '../api/streamClient';
import { useActivityStore } from '../store/activityStore';

/** 整改计划第 3 章（P0）：轮询显式状态机 */
export type PollStatus = 'idle' | 'polling' | 'error' | 'retrying';

/** 轮询错误详情（含类型 / 最后成功时间 / 下次重试倒计时） */
export interface PollErrorInfo {
  message: string;
  type: 'message' | 'activity';
  lastSuccessAt: number | null;
  retryInMs: number;
}

export interface Message {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  reasoning?: string | null;
  createdAt: string;
  toolCalls?: string | null;
}

export interface UseMessagePollingOptions {
  /** Current conversation ID */
  conversationId: string | null;
  /** Whether polling is enabled (e.g., only when sending) */
  enabled?: boolean;
  /** Polling interval in ms (default: 1000 for CodingHome, 2000 for Chat) */
  intervalMs?: number;
  /** Called to update messages with merged server data */
  onMessagesUpdate: (updater: (prev: Message[]) => Message[]) => void;
  /** Called when token total updates */
  onTokenTotalUpdate?: (total: number) => void;
  /** Called when sending state should update based on server status */
  onSendingUpdate?: (generating: boolean) => void;
  /** Called when live reasoning should update from server */
  onLiveReasoningUpdate?: (reasoning: string) => void;
  /** Current conversation ref (for race condition guards) */
  currentConvRef: React.MutableRefObject<string | null>;
  /** Message poll request ID ref (for FE-04/FE-08: request sequence guard) */
  msgPollReqIdRef: React.MutableRefObject<number>;
  /** Activity poll request ID ref (separate from message polling to avoid interference) */
  activityPollReqIdRef?: React.MutableRefObject<number>;
  /** Mounted ref (for cleanup on unmount) */
  mountedRef?: React.MutableRefObject<boolean>;
  /** Whether to also poll activity events (for Chat.tsx) */
  pollActivityEvents?: boolean;
  /** Activity store last sequence getter */
  getLastSeq?: (convId: string) => number;
  /** Called when polling error occurs (FE-ERR-06: expose errors instead of silent catch) */
  onPollError?: (error: Error, type: 'message' | 'activity') => void;
}

/**
 * Shared hook for message polling with request sequence guard (FE-04/FE-08):
 * - Polls conversation messages at configurable interval
 * - Merges server messages with local optimistic messages by ID
 * - Request sequence guard discards stale responses
 * - Updates token total, sending state, and live reasoning from server
 * - Optionally polls activity events (for Chat.tsx)
 * - FE-RACE-01: Separate request ID refs for message vs activity polling
 * - FE-ERR-06: Expose polling errors via onPollError callback
 */
export interface UseMessagePollingReturn {
  /** 轮询显式状态机（整改计划第 3 章：{idle,polling,error,retrying}） */
  pollStatus: PollStatus;
  /** 轮询错误详情（含类型/最后成功时间/重试倒计时） */
  pollErrorInfo: PollErrorInfo | null;
  /** 立即重试：取消旧 interval、递增请求代次、调用 poll()（而非 load()） */
  retry: () => void;
}

export function useMessagePolling(options: UseMessagePollingOptions): UseMessagePollingReturn {
  const {
    conversationId,
    enabled = true,
    intervalMs = 1000,
    onMessagesUpdate,
    onTokenTotalUpdate,
    onSendingUpdate,
    onLiveReasoningUpdate,
    currentConvRef,
    msgPollReqIdRef,
    activityPollReqIdRef,
    mountedRef,
    pollActivityEvents = false,
    getLastSeq,
    onPollError,
  } = options;

  // 整改计划第 3 章：显式状态机 + AbortController（组件卸载/会话切换/重试时取消旧请求）
  const [pollStatus, setPollStatus] = useState<PollStatus>('idle');
  const [pollErrorInfo, setPollErrorInfo] = useState<PollErrorInfo | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const activityAbortRef = useRef<AbortController | null>(null);
  const lastSuccessAtRef = useRef<number | null>(null);
  const retryTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollErrorCountRef = useRef(0);
  // retry 触发主轮询 effect 重启（interval 重建）
  const [restartKey, setRestartKey] = useState(0);
  // P0 通知幂等化：状态边沿检测 —— polling 只负责"状态同步"（generating 变化时回调 onSendingUpdate），
  // 不承担"事件生成"（通知必须来自 Run terminal event → NotificationCenter）。
  // 删除原 notifiedRef false→true→false→true 逻辑（持续状态 generating=false 不能推导"刚完成"）。
  const previousGeneratingRef = useRef<boolean | null>(null);

  /**
   * 状态边沿检测：仅在 generating 值发生变化时回调 onSendingUpdate。
   * 返回 [当前值, 是否发生 true→false 边沿]。通知由上层终态事件处理，
   * 此处仅同步 sending 状态，绝不发通知。
   */
  const syncGeneratingStatus = useCallback((generating: boolean): { generating: boolean; edgeDown: boolean } => {
    const previous = previousGeneratingRef.current;
    previousGeneratingRef.current = generating;
    const edgeDown = previous === true && generating === false;
    if (previous !== generating) {
      onSendingUpdate?.(generating);
    }
    return { generating, edgeDown };
  }, [onSendingUpdate]);

  const poll = useCallback(async () => {
    const convId = conversationId;
    if (!convId || !enabled) return;

    const reqId = ++msgPollReqIdRef.current;
    if (mountedRef && !mountedRef.current) return;

    // 整改计划第 3 章：每个 poll 用独立 AbortController（卸载/切换/重试时取消）
    if (abortRef.current) { try { abortRef.current.abort(); } catch { /* ignore */ } }
    const controller = new AbortController();
    abortRef.current = controller;
    setPollStatus('polling');

    try {
      const conv = await api.getConversation(convId, controller.signal);
      if (controller.signal.aborted) return;
      if (mountedRef && !mountedRef.current) return;
      if (reqId !== msgPollReqIdRef.current) return; // FE-04/FE-08: discard stale
      if (currentConvRef.current !== convId) return; // FE-04: conversation switched

      // Merge messages: server messages replace local optimistic ones
      onMessagesUpdate(prev => {
        const parseMsg = (m: Record<string, unknown>): Message => {
          let reasoning: string | undefined;
          if (m.toolResults) {
            try {
              const tr = JSON.parse(m.toolResults as string) as Record<string, unknown>;
              if (typeof tr.reasoning === 'string' && tr.reasoning !== '') reasoning = tr.reasoning;
            } catch {
              // Intentional fallback: 服务端 toolResults 可能不是合法 JSON（旧数据/部分字段），
              // 解析失败时保留默认 reasoning（undefined），不得让单条消息拖垮整个轮询合并。
            }
          }
          const str = (v: unknown): string => (typeof v === 'string' ? v : '');
          const role = (v: unknown): Message['role'] => (v === 'user' || v === 'assistant' || v === 'tool' ? v : 'user');
          return {
            id: str(m.id),
            role: role(m.role),
            content: str(m.content),
            createdAt: str(m.createdAt),
            reasoning,
            toolCalls: typeof m.toolCalls === 'string' ? m.toolCalls : null,
          };
        };

        const serverMessages: Message[] = (conv.messages || []).map(parseMsg);
        const serverMap = new Map<string, Message>(serverMessages.map(m => [m.id, m]));

        // 整改计划：无变化检测 —— 若 server 消息与本地完全一致（同 id 同 content），
        // 直接返回原 prev 引用（不触发 messages 变更 → 不打扰滚动位置）。
        // 修复：轮询 1s 一次但消息未变时，不能让 setMessages 产生新数组导致滚动 effect 反复触发。
        if (serverMessages.length === prev.length && serverMessages.every((sm, i) => {
          const p = prev[i];
          return p && p.id === sm.id && p.content === sm.content && p.role === sm.role;
        })) {
          return prev;
        }

        // Start with local messages, replace with server where IDs match
        const merged = prev.map(localMsg => serverMap.get(localMsg.id) || localMsg);

        // Add any server messages not in local (new messages from other clients)
        for (const sm of serverMessages) {
          if (!prev.some(m => m.id === sm.id)) {
            // Try to find optimistic placeholder to replace
            const optIdx = merged.findIndex(m =>
              (m.id.startsWith('u-') || m.id.startsWith('a-') || m.id.startsWith('remote-u-') || m.id.startsWith('temp-')) && m.role === sm.role
            );
            if (optIdx !== -1) {
              merged[optIdx] = sm;
            } else {
              merged.push(sm);
            }
          }
        }

        return merged;
      });

      // Update token total
      if (typeof conv.tokenTotal === 'number') {
        onTokenTotalUpdate?.(conv.tokenTotal);
      }

      // P0 通知幂等化：polling 仅同步 sending 状态（边沿检测），
      // 绝不在此产生通知 —— 通知唯一来源是 Run terminal event → NotificationCenter。
      // 持续状态 generating=false 只是"状态"，不是"事件"；轮询 100 次 completed 也不会重复通知。
      try {
        const statusRes = await fetch(`/api/conversations/${convId}/status`, {
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
          signal: controller.signal,
        });
        const status = await statusRes.json();
        if (controller.signal.aborted) return;
        if (reqId !== msgPollReqIdRef.current) return;
        if (currentConvRef.current !== convId) return;

        const generating = Boolean(status.generating);
        syncGeneratingStatus(generating);
      } catch { /* ignore */ }

      // Update live reasoning from latest message
      const latestMsg = conv.messages?.[conv.messages.length - 1];
      if (latestMsg?.toolResults) {
        try {
          const tr = JSON.parse(latestMsg.toolResults);
          if (tr.reasoning) {
            onLiveReasoningUpdate?.(tr.reasoning);
          }
        } catch { /* ignore */ }
      }

      // 整改计划第 3 章：成功 → 记录最后成功时间并复位状态机
      lastSuccessAtRef.current = Date.now();
      pollErrorCountRef.current = 0;
      setPollStatus('idle');
      setPollErrorInfo(null);
      if (abortRef.current === controller) abortRef.current = null;
    } catch (e) {
      if (controller.signal.aborted) return; // 主动取消（卸载/切换/重试）不算错误
      // FE-ERR-06: 不再静默吞错，通过回调向上层暴露
      if (e instanceof Error) {
        onPollError?.(e, 'message');
        pollErrorCountRef.current += 1;
        setPollStatus(pollErrorCountRef.current >= 3 ? 'error' : 'retrying');
        setPollErrorInfo({
          message: e.message,
          type: 'message',
          lastSuccessAt: lastSuccessAtRef.current,
          retryInMs: intervalMs,
        });
      }
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [
    conversationId,
    enabled,
    onMessagesUpdate,
    onTokenTotalUpdate,
    onSendingUpdate,
    onLiveReasoningUpdate,
    currentConvRef,
    msgPollReqIdRef,
    mountedRef,
    onPollError,
    intervalMs,
  ]);

  const pollActivity = useCallback(async () => {
    const convId = conversationId;
    if (!convId || !pollActivityEvents || !getLastSeq) return;

    // 使用独立的 activityPollReqIdRef，避免与消息轮询互相干扰 (FE-RACE-01)
    const activityRef = activityPollReqIdRef ?? msgPollReqIdRef;
    const reqId = ++activityRef.current;
    if (mountedRef && !mountedRef.current) return;

    // 整改计划第 3 章：活动轮询同样使用 AbortController
    if (activityAbortRef.current) { try { activityAbortRef.current.abort(); } catch { /* ignore */ } }
    const controller = new AbortController();
    activityAbortRef.current = controller;

    try {
      const lastSeq = getLastSeq(convId);
      const events = await fetchEvents(convId, lastSeq, controller.signal);
      if (controller.signal.aborted) return;
      if (mountedRef && !mountedRef.current) return;
      if (reqId !== activityRef.current) return;
      if (currentConvRef.current !== convId) return;

      if (events.length > 0) {
        useActivityStore.getState().appendEvents(convId, events);
      }
      if (activityAbortRef.current === controller) activityAbortRef.current = null;
    } catch (e) {
      if (controller.signal.aborted) return; // 主动取消不算错误
      // FE-ERR-06: 活动轮询错误也暴露出去
      if (e instanceof Error) {
        onPollError?.(e, 'activity');
        pollErrorCountRef.current += 1;
        setPollStatus(pollErrorCountRef.current >= 3 ? 'error' : 'retrying');
        setPollErrorInfo((prev) => ({
          message: e.message,
          type: 'activity',
          lastSuccessAt: prev?.lastSuccessAt ?? lastSuccessAtRef.current,
          retryInMs: 2000,
        }));
      }
      if (activityAbortRef.current === controller) activityAbortRef.current = null;
    }
  }, [conversationId, pollActivityEvents, getLastSeq, currentConvRef, activityPollReqIdRef, msgPollReqIdRef, mountedRef, onPollError]);

  // 整改计划第 3 章：retry —— 取消旧 interval、递增请求代次、立即调用 poll()（而非 load()）
  const retry = useCallback(() => {
    if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
    pollErrorCountRef.current = 0;
    setPollErrorInfo(null);
    setPollStatus('retrying');
    // 强制重启主轮询 interval（通过递增一个"重启代次"状态触发 effect 重新执行）
    setRestartKey((k) => k + 1);
    void poll();
  }, [poll]);

  // Main message polling
  useEffect(() => {
    if (!conversationId || !enabled) return;

    let cancelled = false;

    const runPoll = async () => {
      if (cancelled) return;
      await poll();
    };

    runPoll();
    const interval = setInterval(runPoll, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(interval);
      // 整改计划第 3 章：卸载/会话切换时取消 in-flight 请求
      if (abortRef.current) { try { abortRef.current.abort(); } catch { /* ignore */ } abortRef.current = null; }
      if (activityAbortRef.current) { try { activityAbortRef.current.abort(); } catch { /* ignore */ } activityAbortRef.current = null; }
    };
  }, [conversationId, enabled, intervalMs, poll, restartKey]);

  // Activity events polling (Chat.tsx)
  useEffect(() => {
    if (!conversationId || !pollActivityEvents) return;

    let cancelled = false;

    const runPollActivity = async () => {
      if (cancelled) return;
      await pollActivity();
    };

    runPollActivity();
    const interval = setInterval(runPollActivity, 2000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [conversationId, pollActivityEvents, pollActivity, restartKey]);

  return { pollStatus, pollErrorInfo, retry };
}