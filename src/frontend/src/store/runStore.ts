/**
 * Aether 2.4.0 —— 权威 Run 状态 Store（T8）。
 *
 * ## 不变量（本文件存在的唯一理由）
 * 1. **状态零漂移**：`status` 恒为 `@pacc/shared` 的 `RunStatus`（11 态）。类型上由
 *    `RunDto` 保证；映射上由 T5 的 `RUN_EVENT_TYPE_TO_STATUS` 保证。store 内不出现任何
 *    手写状态字符串。
 * 2. **唯一数据输入 = 真实后端快照 + 真实 v2 事件**。没有乐观状态、没有本地计时器推断、
 *    没有 "发送中即 running" 之类的伪造标志。
 * 3. **`ingestSnapshot` 是唯一允许状态跳到任意后端值的路径**（服务端权威，可跨状态机跳转）。
 *    事件流只能把状态推进到 T5 表中 8 个 `run.*` 事件对应的值。
 * 4. **`activeRunId` 只由 `setActiveRun` 设置**，绝不从快照或事件推断 —— 快照里的
 *    `status: 'running'` 不是"这条 run 就是当前会话活动 run"的证据。
 * 5. **不伪造 Run**：未见过后端快照的 run 收到事件时不生成占位 `RunSnapshot`
 *    （RunSnapshot 需要完整 DTO，事件补不全）。
 *
 * 消费方（spinner / 停止按钮 / 状态标签）一律经本 store 的 reader 读取，不自行缓存状态。
 */
import { create } from 'zustand';
import type { AgentEvent, RunStatus } from '@pacc/shared';
import type { RunDto } from '../api/runs';
import { RUN_EVENT_TYPE_TO_STATUS, RUN_STATUS_META, isRunLifecycleEventType } from '../lib/run-status';

/**
 * `run.budget_exceeded` —— 后端已发射但**不在** v2 44 种事件闭集内（T3 发现）。
 *
 * 放在本文件而非 T5 映射表：T5 只能证明 v2 闭集内的 8 个事件，这个值是前端对后端扩展的
 * 显式承认，需要在状态写入路径上以 string 检查被看见。
 */
export const BUDGET_EXCEEDED_EVENT_TYPE = 'run.budget_exceeded';

/** retry/attempt 事件投影（RunDto 不含重试信息，故只能来自事件流）。 */
export interface RetryState {
  attempt?: number;
  status?: 'scheduled' | 'running' | 'completed' | 'failed' | 'exhausted';
  delayMs?: number;
}

/** 后端 DTO + 前端本地叠加字段。 */
export type RunSnapshot = RunDto & {
  /** 已消费到的最大事件 seq（来自快照入参或事件流，单调不减）。 */
  lastEventSeq: number;
  /** 快照可能已过期（长时间未收到后端确认）。 */
  isStale: boolean;
  /** 最近一次 retry/attempt 事件投影。 */
  retryState?: RetryState;
};

/**
 * v2 闭集外的事件形状。
 *
 * `run.budget_exceeded` 等后端扩展不在 `AgentEvent` 判别联合内。与其让生产代码和测试都靠
 * `as AgentEvent` 断言绕过闭集，不如把闭集边界显式建模为结构类型 —— 联合的 `type` 拓宽为
 * `string` 后即可走 string-keyed 查表，全程零 `any`、零类型断言。
 */
export interface UnknownRunEvent {
  readonly type: string;
  readonly runId: string;
  readonly seq?: number;
}

export type RunStoreEvent = AgentEvent | UnknownRunEvent;

export interface RunState {
  runsById: Record<string, RunSnapshot>;
  runIdsByConversation: Record<string, string[]>;
  activeRunId: string | null;
  lastSyncedAt: number | null;

  // actions
  setActiveRun: (runId: string | null) => void;
  ingestSnapshot: (dto: RunDto, eventSeq?: number) => void;
  applyLifecycleEvent: (ev: RunStoreEvent) => void;
  removeRun: (runId: string) => void;
  clearConversation: (conversationId: string) => void;
  markStale: (runId: string) => void;

  // readers
  getRun: (runId: string) => RunSnapshot | undefined;
  getActiveRun: () => RunSnapshot | null;
  getRunsForConversation: (conversationId: string) => RunSnapshot[];
  isRunBusy: (status: RunStatus) => boolean;
}

/** 事件类型 → Run 状态：8 个 v2 `run.*` 走 T5 映射表，`run.budget_exceeded` 走本地常量。
 *  入参是 string（判别联合的 `type` 已拓宽），判定与查表都不做类型断言。 */
function statusForEventType(evType: string): RunStatus | null {
  if (evType === BUDGET_EXCEEDED_EVENT_TYPE) return 'budget_exceeded';
  if (!isRunLifecycleEventType(evType)) return null;
  return RUN_EVENT_TYPE_TO_STATUS[evType];
}

/** 6 个 retry/attempt 事件 → retryState 投影。
 *  `in` 收窄把入参压回 `AgentEvent`（`UnknownRunEvent` 无 `payload`），随后 `switch` 按
 *  判别字段穷尽收窄，payload 字段全部类型安全。 */
function retryStateFor(ev: RunStoreEvent): RetryState | null {
  if (!('payload' in ev)) return null;
  switch (ev.type) {
    case 'attempt.started':
    case 'retry.started':
      return { attempt: ev.payload.attempt, status: 'running' };
    case 'retry.scheduled':
      return { attempt: ev.payload.attempt, status: 'scheduled', delayMs: ev.payload.delayMs };
    case 'retry.completed':
      return { attempt: ev.payload.attempt, status: 'completed' };
    case 'retry.failed':
      return { attempt: ev.payload.attempt, status: 'failed' };
    case 'retry.exhausted':
      return { attempt: ev.payload.attempt, status: 'exhausted' };
    default:
      return null;
  }
}

export const useRunStore = create<RunState>((set, get) => ({
  runsById: {},
  runIdsByConversation: {},
  activeRunId: null,
  lastSyncedAt: null,

  /** 唯一允许设置 activeRunId 的入口。清理悬挂指针（removeRun/clearConversation）不算推断。 */
  setActiveRun: (runId) => set({ activeRunId: runId }),

  /** 服务端权威快照：唯一允许状态跳到任意后端值的路径。同时清 isStale、推进 lastSyncedAt。 */
  ingestSnapshot: (dto, eventSeq) => {
    const prev = get().runsById[dto.id];
    const snapshot: RunSnapshot = {
      ...dto,
      lastEventSeq: eventSeq ?? prev?.lastEventSeq ?? 0,
      isStale: false,
      retryState: prev?.retryState,
    };
    set(s => {
      const runsById = { ...s.runsById, [dto.id]: snapshot };
      if (dto.conversationId === null) return { runsById, lastSyncedAt: Date.now() };
      const indexed = s.runIdsByConversation[dto.conversationId] ?? [];
      const runIdsByConversation = indexed.includes(dto.id)
        ? s.runIdsByConversation
        : { ...s.runIdsByConversation, [dto.conversationId]: [...indexed, dto.id] };
      return { runsById, runIdsByConversation, lastSyncedAt: Date.now() };
    });
  },

  /** v2 事件流 → 状态 / retryState。未命中生命周期与 retry 语义的事件静默忽略。 */
  applyLifecycleEvent: (ev) => {
    const prev = get().runsById[ev.runId];
    // 不伪造 Run：没有后端快照就没有 RunDto，事件补不全（不变量 5）
    if (prev === undefined) return;
    const status = statusForEventType(ev.type);
    const retryState = retryStateFor(ev);
    if (status === null && retryState === null) return;
    const next: RunSnapshot = {
      ...prev,
      lastEventSeq: Math.max(prev.lastEventSeq, ev.seq ?? 0),
    };
    if (status !== null) next.status = status;
    if (retryState !== null) next.retryState = retryState;
    set(s => ({ runsById: { ...s.runsById, [ev.runId]: next } }));
  },

  removeRun: (runId) => {
    set(s => {
      const runsById = { ...s.runsById };
      delete runsById[runId];
      const runIdsByConversation = { ...s.runIdsByConversation };
      for (const [conversationId, runIds] of Object.entries(runIdsByConversation)) {
        runIdsByConversation[conversationId] = runIds.filter((id) => id !== runId);
      }
      return {
        runsById,
        runIdsByConversation,
        activeRunId: s.activeRunId === runId ? null : s.activeRunId,
      };
    });
  },

  clearConversation: (conversationId) => {
    set(s => {
      const runIds = s.runIdsByConversation[conversationId] ?? [];
      const runsById = { ...s.runsById };
      for (const runId of runIds) delete runsById[runId];
      const runIdsByConversation = { ...s.runIdsByConversation };
      delete runIdsByConversation[conversationId];
      const cleared = new Set(runIds);
      return {
        runsById,
        runIdsByConversation,
        activeRunId: s.activeRunId !== null && cleared.has(s.activeRunId) ? null : s.activeRunId,
      };
    });
  },

  markStale: (runId) => {
    const prev = get().runsById[runId];
    if (prev === undefined) return;
    set(s => ({ runsById: { ...s.runsById, [runId]: { ...prev, isStale: true } } }));
  },

  getRun: (runId) => get().runsById[runId],

  getActiveRun: () => {
    const { activeRunId, runsById } = get();
    if (activeRunId === null) return null;
    return runsById[activeRunId] ?? null;
  },

  getRunsForConversation: (conversationId) => {
    const { runsById, runIdsByConversation } = get();
    return (runIdsByConversation[conversationId] ?? []).flatMap((runId) => {
      const snapshot = runsById[runId];
      return snapshot ? [snapshot] : [];
    });
  },

  /** 委托 T5：Record<RunStatus, RunStatusMeta> 保证 11 态编译期穷尽，新增状态即报错。 */
  isRunBusy: (status) => RUN_STATUS_META[status].busy,
}));
