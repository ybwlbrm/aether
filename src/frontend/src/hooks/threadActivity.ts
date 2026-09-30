/**
 * T16 · activityStore → 审批 + 循环指标 的投影。
 *
 * ## 为什么要读 getEventsByRun 而不是 getEvents
 * `activityStore` 的引用缓存在 `set` **之后**才失效，因此 store 订阅回调里调 `getEvents()`
 * 读到的是**上一份快照**（活动事件刚到达时长度仍是 0）。`getEventsByRun` 无缓存，
 * 是 `ConversationActivityStream` 已在用的读法，这里沿用。
 *
 * ## 为什么按"会话 + 事件总数"短路
 * 订阅在每个事件到达时触发；流式期间每个 token delta 都是一次事件，全量扫描会退化成
 * O(n²)。事件总数不变即无需重扫（审批只在 ask-confirm 到达时变化）。
 */
import type { AgentEventEnvelope } from '@pacc/shared';
import { useActivityStore } from '../store/activityStore';
import type { ApprovalRequest, ApprovalTracker } from './threadApproval';
import type { ThreadLoopMetrics } from './threadContract';

/** 循环指标：Run 作用域回溯（每个 Run 的 seq 独立，跨 Run 合并排序不可靠） */
function readLoopMetrics(conversationId: string, store: ReturnType<typeof useActivityStore.getState>): ThreadLoopMetrics | null {
  const runIds = store.getRunsForConversation(conversationId);
  for (let i = runIds.length - 1; i >= 0; i--) {
    const events = store.getEventsByRun(runIds[i]);
    for (let j = events.length - 1; j >= 0; j--) {
      const ev = events[j];
      const meta = ev.metadata;
      if ((ev.eventType === 'task.completed' || ev.eventType === 'task.failed') && meta && typeof meta.turnsUsed === 'number') {
        return {
          turnsUsed: Number(meta.turnsUsed),
          elapsedMs: Number(meta.elapsedMs || 0),
          toolCalls: Number(meta.toolCalls || 0),
          budgetExceeded: meta.budgetExceeded ? String(meta.budgetExceeded) : null,
        };
      }
    }
  }
  return null;
}

export interface ActivityProjection {
  readonly pendingApproval: ApprovalRequest | null;
  readonly approvalError: string | null;
  readonly loopMetrics: ThreadLoopMetrics | null;
}

export interface ActivitySync {
  /** 按当前会话重算三项投影（会话为 null 时清空审批） */
  readonly sync: (conversationId: string | null) => ActivityProjection;
  /** 强制下一次 sync 重扫（会话切换 / 消息重载后调用） */
  readonly invalidate: () => void;
}

export function createActivitySync(approvals: ApprovalTracker): ActivitySync {
  let scannedKey = '';
  return {
    invalidate: () => { scannedKey = ''; },
    sync: (conversationId) => {
      if (conversationId === null) {
        approvals.clear();
        return { pendingApproval: null, approvalError: null, loopMetrics: null };
      }
      const store = useActivityStore.getState();
      const runIds = store.getRunsForConversation(conversationId);
      let eventCount = 0;
      for (const runId of runIds) eventCount += store.getEventsByRun(runId).length;
      if (`${conversationId}:${eventCount}` !== scannedKey) {
        scannedKey = `${conversationId}:${eventCount}`;
        const events: AgentEventEnvelope[] = [];
        for (const runId of runIds) events.push(...store.getEventsByRun(runId));
        approvals.sync(events);
      }
      const snapshot = approvals.getSnapshot();
      return {
        pendingApproval: snapshot.pending,
        approvalError: snapshot.error,
        loopMetrics: readLoopMetrics(conversationId, store),
      };
    },
  };
}
