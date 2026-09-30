/**
 * T16 · D1 —— 审批请求（`task.ask-confirm`）的识别与决策。
 *
 * ## 为什么从 useStreamSend 里提出来
 * 审批处理原先长在 `useStreamSend` 的 **mode 分支内部**（super 分支一份、normal 分支
 * 一份，重复的 confirmDialog + decideApproval）。两个后果：
 * 1. 任何新增 mode 都得再抄一遍，抄漏即"审批工具挂死"——后端在等 decideApproval，
 *    前端没人问，Run 永远停在这一步；
 * 2. 审批是**事件流的事实**（envelope 里带 `metadata.approvalId`），不是某个 mode 的行为。
 *
 * 本模块把判据提成一个纯函数，决策提成一个可测的状态机，两种 mode 共用同一份实现。
 * 数据来源是 activityStore —— 两种 mode 的 envelope 都无条件 `appendEvent` 到那里
 * （这是它们唯一的公共汇聚点），因此"处理 ask-confirm"被提到 mode 分支之外之后，
 * super / normal 的行为**由构造保证一致**，而不是靠两份代码手工保持一致。
 */
import type { AgentEventEnvelope } from '@pacc/shared';

/** 一次待用户裁决的审批（工具执行授权） */
export interface ApprovalRequest {
  readonly approvalId: string;
  readonly toolName: string;
  readonly argsSummary: string;
}

/** 判据入参：只需要 eventType + metadata，故 v1 envelope 与 v2 事件都能直接喂进来 */
export interface ApprovalCandidate {
  readonly eventType: string;
  readonly metadata?: Record<string, unknown> | undefined;
}

/**
 * 纯函数：envelope → 审批请求。
 * 判据 = `eventType === 'task.ask-confirm'` **且** `metadata.approvalId` 非空
 * （没有 approvalId 的 ask-confirm 不是"待裁决"，后端无从回执）。
 */
export function extractApprovalRequest(ev: ApprovalCandidate): ApprovalRequest | null {
  if (ev.eventType !== 'task.ask-confirm') return null;
  const rawId = ev.metadata?.approvalId;
  if (rawId === undefined || rawId === null || rawId === '') return null;
  return {
    approvalId: String(rawId),
    toolName: String(ev.metadata?.toolName || '工具'),
    argsSummary: String(ev.metadata?.argsSummary || ''),
  };
}

/** 审批提交面（生产绑真实 api，测试注入替身） */
export interface ApprovalApi {
  readonly decideApproval: (id: string, decision: 'approved' | 'rejected') => Promise<unknown>;
}

/** 对外快照：`pending` 引用稳定，供 useSyncExternalStore 使用 */
export interface ApprovalSnapshot {
  readonly pending: ApprovalRequest | null;
  /** 最近一次提交失败（用户可以再点一次重试；成功即清空） */
  readonly error: string | null;
}

export interface ApprovalTracker {
  /** 从事件流重算待审批项：倒序找最后一条"已发出但未裁决"的 ask-confirm */
  readonly sync: (events: readonly AgentEventEnvelope[]) => void;
  /** 会话切换 / 新建：清空待审批与失败提示（连同已裁决集合，避免旧审批复活） */
  readonly clear: () => void;
  /** 提交决策：成功即标记已裁决并清空待审批；失败则恢复待审批（可重试） */
  readonly decide: (ok: boolean) => Promise<void>;
  readonly getSnapshot: () => ApprovalSnapshot;
  readonly subscribe: (listener: () => void) => () => void;
}

const EMPTY: ApprovalSnapshot = { pending: null, error: null };

export function createApprovalTracker(api: ApprovalApi): ApprovalTracker {
  let snapshot: ApprovalSnapshot = EMPTY;
  /** 已提交过决策的 approvalId：事件会重放（回放/SSE/轮询三路），不得重复弹窗 */
  const decided = new Set<string>();
  const listeners = new Set<() => void>();

  const patch = (next: Partial<ApprovalSnapshot>): void => {
    if (next.pending === snapshot.pending && next.error === snapshot.error) return;
    snapshot = { pending: next.pending ?? null, error: next.error ?? null };
    for (const listener of listeners) listener();
  };

  return {
    sync: (events) => {
      for (let i = events.length - 1; i >= 0; i--) {
        const request = extractApprovalRequest(events[i]);
        if (!request || decided.has(request.approvalId)) continue;
        patch({ pending: request, error: null });
        return;
      }
      // 事件流里已无未裁决审批：静默收尾（不做提示，避免轮询抖动刷屏）
      if (snapshot.pending !== null) patch({ pending: null });
    },
    clear: () => {
      decided.clear();
      patch({ pending: null, error: null });
    },
    decide: async (ok) => {
      const request = snapshot.pending;
      if (!request) return;
      patch({ pending: null, error: null });
      try {
        await api.decideApproval(request.approvalId, ok ? 'approved' : 'rejected');
        decided.add(request.approvalId);
      } catch (cause: unknown) {
        // 提交失败：把审批放回待办（用户可重试），Run 侧仍会等回执
        patch({ pending: request, error: cause instanceof Error ? cause.message : String(cause) });
      }
    },
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
