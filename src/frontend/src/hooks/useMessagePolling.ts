import { useEffect, useRef, useCallback, useState } from 'react';
import { api } from '../api/client';
import { fetchEvents } from '../api/streamClient';
import { useActivityStore } from '../store/activityStore';

/** 整改计划第 3 章（P0）：轮询显式状态机 */
export type PollStatus = 'idle' | 'polling' | 'error' | 'retrying';

/** D6：连续失败多少击才从 retrying 升到 error（两条轮询各自独立计次） */
export const POLL_ERROR_THRESHOLD = 3

/**
 * D6：消息轮询与活动轮询的失败计数器**各自独立**。
 *
 * 修复前两条轮询共用一个 `pollErrorCountRef`：活动事件回放（afterSeq 游标）天然比
 * 消息快照更容易抖，两条轮询的失败被累加进同一个计数器 → 消息轮询只错 1 次、只要
 * 活动轮询同时错了 2 次就整体跳到 error 态，用户看到"消息轮询失败"却与消息无关。
 * 拆分后 `PollErrorInfo.type` 才真正描述"是哪条轮询在失败"，各自的 3 击阈值也才成立。
 *
 * 复位同样按通道独立：一条轮询成功只清自己那一路（原先成功即清零，实际上是"消息成功
 * 顺手抹掉活动轮询的失败"，反过来活动轮询失败也从未被消息成功清过，方向不对称）。
 */
export interface PollErrorCounters {
  /** 记一次消息轮询失败，返回该通道累计失败次数 */
  readonly noteMessageFailure: () => number
  /** 记一次活动轮询失败，返回该通道累计失败次数 */
  readonly noteActivityFailure: () => number
  /** 消息轮询成功 → 只复位消息通道 */
  readonly resetMessage: () => void
  /** 活动轮询成功 → 只复位活动通道 */
  readonly resetActivity: () => void
  /** 手动重试 → 两条通道一起复位 */
  readonly reset: () => void
  /** 由两条通道的较高失败数决定状态机（>= POLL_ERROR_THRESHOLD 即 error） */
  readonly status: () => PollStatus
  /** 两条通道的失败次数快照（供诊断/测试） */
  readonly snapshot: () => { readonly message: number; readonly activity: number }
}

export function createPollErrorCounters(): PollErrorCounters {
  let message = 0
  let activity = 0
  return {
    noteMessageFailure: () => { message += 1; return message },
    noteActivityFailure: () => { activity += 1; return activity },
    resetMessage: () => { message = 0 },
    resetActivity: () => { activity = 0 },
    reset: () => { message = 0; activity = 0 },
    status: () => (Math.max(message, activity) >= POLL_ERROR_THRESHOLD ? 'error' : 'retrying'),
    snapshot: () => ({ message, activity }),
  }
}

/**
 * AEX-P0-062 逐字不变式：正在流式的占位消息是 SSE 的实时投影，polling 的 server 快照
 * 可能更旧（DB 写入滞后于 SSE 显示），**不得**被覆盖。只有已完成的占位
 * （temp-ai-streaming-done）与真实消息才允许被替换。
 */
export const LIVE_STREAMING_PLACEHOLDER_ID = 'temp-ai-streaming';

export function isLiveStreamingPlaceholder(id: string): boolean {
  return id === LIVE_STREAMING_PLACEHOLDER_ID;
}

/**
 * AEX-P0-062 逐字不变式：可被 server 快照替换的乐观占位前缀 =
 * `u-` / `a-` / `remote-u-` / `temp-`，但**不含**正在流式的 `temp-ai-streaming`
 * （它必须继续走上面的实时投影分支）。
 */
export function isReplaceableOptimisticPlaceholder(id: string): boolean {
  return id.startsWith('u-')
    || id.startsWith('a-')
    || id.startsWith('remote-u-')
    || (id.startsWith('temp-') && !isLiveStreamingPlaceholder(id));
}

/** 活动事件回放的轮询间隔（消息轮询的 interval 由调用方按页面给定） */
export const ACTIVITY_POLL_INTERVAL_MS = 2000;

/** D6：活动轮询失败的重试倒计时提示（与消息轮询的 intervalMs 区分开） */
export const ACTIVITY_POLL_RETRY_IN_MS = 2000;

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
  // D6：消息/活动两条轮询的失败计数彻底分离（各自 3 击阈值）
  const pollErrorCountersRef = useRef<ReturnType<typeof createPollErrorCounters> | null>(null);
  pollErrorCountersRef.current ??= createPollErrorCounters();
  const pollErrorCounters = pollErrorCountersRef.current;
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
        // AEX-P0-062: 正在流式的 temp-ai-streaming 是 SSE 实时投影，polling 不得覆盖
        const merged = prev.map(localMsg => {
          if (isLiveStreamingPlaceholder(localMsg.id)) return localMsg;
          const server = serverMap.get(localMsg.id);
          if (!server) return localMsg;
          // 只允许"更新"的 server 版本覆盖本地（createdAt 即版本序）
          if (server.createdAt && localMsg.createdAt && server.createdAt < localMsg.createdAt) return localMsg;
          return server;
        });

        // Add any server messages not in local (new messages from other clients)
        for (const sm of serverMessages) {
          if (!prev.some(m => m.id === sm.id)) {
            // Try to find optimistic placeholder to replace
            // AEX-P0-062: 跳过正在流式的 temp-ai-streaming（SSE 实时投影优先）；
            // 仅替换已完成占位 / 用户乐观消息。比较 createdAt 防止旧快照覆盖新显示。
            const optIdx = merged.findIndex(m =>
              isReplaceableOptimisticPlaceholder(m.id) &&
              m.role === sm.role &&
              (!sm.createdAt || !m.createdAt || sm.createdAt >= m.createdAt)
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

      // 整改计划第 3 章：成功 → 记录最后成功时间并复位状态机（只复位消息通道，见 D6）
      lastSuccessAtRef.current = Date.now();
      pollErrorCounters.resetMessage();
      setPollStatus('idle');
      setPollErrorInfo(null);
      if (abortRef.current === controller) abortRef.current = null;
    } catch (e) {
      if (controller.signal.aborted) return; // 主动取消（卸载/切换/重试）不算错误
      // FE-ERR-06: 不再静默吞错，通过回调向上层暴露
      if (e instanceof Error) {
        onPollError?.(e, 'message');
        pollErrorCounters.noteMessageFailure();
        setPollStatus(pollErrorCounters.status());
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
    pollErrorCounters,
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
      // D6：活动轮询成功只复位活动通道（不动消息通道的失败计数）
      pollErrorCounters.resetActivity();
      if (activityAbortRef.current === controller) activityAbortRef.current = null;
    } catch (e) {
      if (controller.signal.aborted) return; // 主动取消不算错误
      // FE-ERR-06: 活动轮询错误也暴露出去
      if (e instanceof Error) {
        onPollError?.(e, 'activity');
        pollErrorCounters.noteActivityFailure();
        setPollStatus(pollErrorCounters.status());
        setPollErrorInfo((prev) => ({
          message: e.message,
          type: 'activity',
          lastSuccessAt: prev?.lastSuccessAt ?? lastSuccessAtRef.current,
          retryInMs: ACTIVITY_POLL_RETRY_IN_MS,
        }));
      }
      if (activityAbortRef.current === controller) activityAbortRef.current = null;
    }
  }, [conversationId, pollActivityEvents, getLastSeq, currentConvRef, activityPollReqIdRef, msgPollReqIdRef, mountedRef, onPollError, pollErrorCounters]);

  // 整改计划第 3 章：retry —— 取消旧 interval、递增请求代次、立即调用 poll()（而非 load()）
  const retry = useCallback(() => {
    if (retryTimerRef.current) { clearTimeout(retryTimerRef.current); retryTimerRef.current = null; }
    pollErrorCounters.reset();
    setPollErrorInfo(null);
    setPollStatus('retrying');
    // 强制重启主轮询 interval（通过递增一个"重启代次"状态触发 effect 重新执行）
    setRestartKey((k) => k + 1);
    void poll();
  }, [poll, pollErrorCounters]);

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
    const interval = setInterval(runPollActivity, ACTIVITY_POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(interval); };
  }, [conversationId, pollActivityEvents, pollActivity, restartKey]);

  return { pollStatus, pollErrorInfo, retry };
}