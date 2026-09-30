/**
 * T21 `useActiveRunId` —— Workbench 拿到真实 run 的唯一入口。
 *
 * ## 数据源（无本地状态）
 *   - `workspace.conversationId`（store/workspace.ts）：当前会话
 *   - `runStore.getRunsForConversation`（T8）：该会话真实存在、且已见过后端快照的 run
 * 解析结果每次渲染都从 store 回读，因此不可能与状态标签 / spinner 漂移。
 *
 * ## 解析规则（三条，按优先级）
 *   ① `runStore.activeRunId` 命中本会话的 run → 用它（显式选择优先）
 *   ② 否则回退到本会话的**最后一个** run（`runIdsByConversation` 的追加序 = 后端快照摄入序）
 *   ③ 本会话没有 run → `{ runId: null, status: null }`
 *      绝不跨会话借 run，也绝不凭空造一个 run。
 *
 * ## 订阅稳定性
 * zustand v5 的 selector 默认按 `Object.is` 比较，因此本 hook 只订阅 **store 自身的
 * 稳定引用**（`activeRunId` / `runIdsByConversation` / `runsById`），
 * 派生（按会话过滤 + 解析）放在 `useMemo` 里做 —— 避免每次 getSnapshot 都产出新数组。
 */
import { useMemo } from 'react';
import type { RunStatus } from '@pacc/shared';
import { useRunStore } from '../../store/runStore';
import { useWorkspaceStore } from '../../store/workspace';

/** 解析结果：无 run 时两个字段都是 null（"没有"与"未加载完"不是一回事）。 */
export interface ActiveRunResolution {
  readonly runId: string | null;
  readonly status: RunStatus | null;
}

/** 解析只需要 run 的两个字段 —— 与 runStore 的具体快照类型解耦。 */
export interface ActiveRunCandidate {
  readonly id: string;
  readonly status: RunStatus;
}

const NO_RUN: ActiveRunResolution = { runId: null, status: null };

/**
 * 纯解析：`activeRunId` 命中本会话则用它，否则回退最后一个 run。
 * 会话内 run 列表来自 `runIdsByConversation`（摄入序），因此"最后一个"= 最新摄入。
 */
export function resolveActiveRun(
  runs: readonly ActiveRunCandidate[],
  activeRunId: string | null,
): ActiveRunResolution {
  if (activeRunId !== null) {
    const active = runs.find(run => run.id === activeRunId);
    if (active !== undefined) return { runId: active.id, status: active.status };
  }
  const latest = runs.at(-1);
  if (latest === undefined) return NO_RUN;
  return { runId: latest.id, status: latest.status };
}

/**
 * 当前会话的活跃 run。
 *
 * `conversationId` 为 null（还没进任何会话）时读空会话 —— 结果是 `NO_RUN`，
 * 不会读到上一个会话的残留 run。
 */
export function useActiveRunId(): ActiveRunResolution {
  const conversationId = useWorkspaceStore(state => state.conversationId);
  const activeRunId = useRunStore(state => state.activeRunId);
  const runIdsByConversation = useRunStore(state => state.runIdsByConversation);
  const runsById = useRunStore(state => state.runsById);

  return useMemo(
    () =>
      resolveActiveRun(
        useRunStore.getState().getRunsForConversation(conversationId ?? ''),
        activeRunId,
      ),
    [conversationId, activeRunId, runIdsByConversation, runsById],
  );
}
