/**
 * T24 · ThreadPage 的投影层 —— 把"会话状态"翻译成"T17 组件要的形状"。
 *
 * ## 为什么要这一层
 * 三条派生链与 JSX 无关，却各自要读两三个 store：
 * 1. **Run 状态条**：runStore（T8）的真实快照 + useRunStream（T15）的 live 流 →
 *    `RunStatusStripProps`，动作合法与否交给 T5 的 `RUN_STATUS_META` 判定。
 * 2. **工具活动**：activityStore 的 v1 envelope → T9 `projectToolActivity` → T17 `ToolActivityItem`。
 * 3. **审批态**：T16 的（pending, error）二元组 → T17 的五态判别联合。
 *
 * 把它们从页面里抽出来有两个直接好处：页面只剩"接哪个、门控到哪"，
 * 而这三条链各自可以被单独推理与测试 —— 不必渲染整页就能验证投影是否诚实。
 *
 * ## store 读法（照搬 T21 useActiveRunId 的既定形状）
 * **订阅稳定引用做响应式触发，派生值走 `getState()` 活读**。原因有二：
 * (1) `getRunsForConversation` 每次返回新数组，直接当 selector 会让 zustand 的
 * Object.is 比较永远不相等 → 无限重渲染；(2) 它闭包读的是活的 store，因此
 * SSR 静态渲染下也能看到真实后端快照，而 `selector(state)` 在服务端只会拿到
 * 建 store 时的 initialState。
 */
import { useMemo } from 'react';
import type { RunStatus } from '@pacc/shared';

import { errorMessage } from '../api/contract';
import {
  createRunStatusHandlers,
  type ApprovalPromptState,
  type RunStatusStripProps,
  type ToolActivityItem,
} from '../components/thread';
import { hasFullToolPayload, projectToolActivity } from '../store/projections';
import { useActivityStore } from '../store/activityStore';
import { useRunStore } from '../store/runStore';
import { useRunStream } from './useRunStream';
import { resolveActiveRun } from './workbench/useActiveRunId';
import type { UseThreadControllerResult } from './useThreadController';

export interface ThreadProjection {
  /** Run 状态条参数；无 run 时为 null（绝不伪造 run） */
  readonly run: RunStatusStripProps | null;
  /** 会话级工具活动行（只读 envelope） */
  readonly toolActivities: readonly ToolActivityItem[];
  /** 审批态（T17 五态判别联合） */
  readonly approval: ApprovalPromptState;
}

/** 审批态适配：T16 的（pending, error）二元组 → T17 的五态判别联合 */
const IDLE_APPROVAL: ApprovalPromptState = { phase: 'idle' };

export function approvalPromptState(
  pending: { readonly approvalId: string; readonly toolName: string; readonly argsSummary: string } | null,
  error: string | null,
): ApprovalPromptState {
  if (pending === null) return IDLE_APPROVAL;
  if (error !== null) return { phase: 'error', ...pending, errorMessage: error };
  return { phase: 'pending', ...pending };
}

/** 当前会话的活跃 run：显式选择优先，否则回退本会话最后一个已摄入的 run */
function useConversationRun(conversationId: string | null): {
  readonly runId: string | null
  readonly status: RunStatus | null
  readonly retryAttempt: number | undefined
} {
  const activeRunId = useRunStore((s) => s.activeRunId);
  const runIdsByConversation = useRunStore((s) => s.runIdsByConversation);
  const runsById = useRunStore((s) => s.runsById);
  return useMemo(() => {
    const resolved = resolveActiveRun(
      useRunStore.getState().getRunsForConversation(conversationId ?? ''),
      useRunStore.getState().activeRunId,
    );
    const attempt = useRunStore.getState().runsById[resolved.runId ?? '']?.retryState?.attempt;
    return { runId: resolved.runId, status: resolved.status, retryAttempt: attempt };
  }, [activeRunId, conversationId, runIdsByConversation, runsById]);
}

/** T9 投影 + T9 的载荷完整性结论 → T17 的条目（不合成任何服务端没给的字段） */
function useConversationToolActivities(
  conversationId: string | null,
  runId: string | null,
): readonly ToolActivityItem[] {
  const events = useActivityStore((s) => s.getEvents(conversationId ?? ''));
  return useMemo(() => {
    const entries = projectToolActivity(events, runId ?? undefined);
    if (entries.length === 0) return [];
    const full = hasFullToolPayload(events, runId ?? undefined);
    return entries.map((entry) => ({ entry, hasFullToolPayload: full, defaultExpanded: false }));
  }, [events, runId]);
}

export function useThreadProjection(thread: UseThreadControllerResult): ThreadProjection {
  const conversationId = thread.conversationId;
  const run = useConversationRun(conversationId);
  const runStream = useRunStream(run.runId);
  const toolActivities = useConversationToolActivities(conversationId, run.runId);

  // 动作失败一律经 reportError 上报（409 / 404 等），绝不 catch 后静默吞掉
  const actions = useMemo(
    () => createRunStatusHandlers((cause: unknown) => { thread.reportError(errorMessage(cause)); }),
    [thread],
  );

  // T15 的 live / 终态快照优先；尚未开流时回落到 runStore 已见的真实状态
  const status = runStream.status ?? run.status;
  const strip: RunStatusStripProps | null = run.runId !== null && status !== null
    ? {
      runId: run.runId,
      status,
      detail: run.retryAttempt === undefined ? undefined : `第 ${run.retryAttempt} 次重试`,
      ...actions,
    }
    : null;

  const approval = useMemo(
    () => approvalPromptState(thread.pendingApproval, thread.approvalError),
    [thread.pendingApproval, thread.approvalError],
  );

  return { run: strip, toolActivities, approval };
}
