/**
 * ApprovalPrompt —— 内联审批框（T17 / D1 产物）。
 *
 * 设计要点：
 * - **状态是 props，不是内部状态**：五态（idle / pending / submitting / error / resolved）
 *   由调用方（controller）持有，组件零内部状态、零副作用，可在 SSR 下断言。
 * - 状态用判别联合（`phase`）而非 `isSubmitting` / `isError` 布尔堆 —— 新增阶段时
 *   switch 编译期报错，不会静默落到「什么都不渲染」。
 * - 决议按钮只透传 approvalId：`onApprove` / `onReject` 由外部接 controller 的
 *   decideApproval，组件自身不碰网络。
 */
import { cn } from "../../lib/utils"

/** 已生效的决议（timeout / aborted 由 controller 归一到终态后传入） */
export type ApprovalOutcome = "approved" | "rejected"

/** 五态判别联合：非 idle 态一律携带 approvalId + toolName */
export type ApprovalPromptState =
  | { readonly phase: "idle" }
  | { readonly phase: "pending"; readonly approvalId: string; readonly toolName: string; readonly argsSummary: string }
  | { readonly phase: "submitting"; readonly approvalId: string; readonly toolName: string; readonly argsSummary: string }
  | {
      readonly phase: "error"
      readonly approvalId: string
      readonly toolName: string
      readonly argsSummary: string
      readonly errorMessage: string
    }
  | { readonly phase: "resolved"; readonly approvalId: string; readonly toolName: string; readonly decision: ApprovalOutcome }

export interface ApprovalPromptProps {
  readonly state: ApprovalPromptState
  /** 批准（外部接 controller.decideApproval） */
  readonly onApprove?: (approvalId: string) => void
  /** 拒绝（外部接 controller.decideApproval） */
  readonly onReject?: (approvalId: string) => void
}

/** pending / submitting / error 三态共有的「工具 + 参数」视图 */
interface ToolSummary {
  readonly toolName: string
  readonly argsSummary: string
}

function toolSummaryOf(state: ApprovalPromptState): ToolSummary | null {
  switch (state.phase) {
    case "idle":
    case "resolved":
      return null
    case "pending":
    case "submitting":
    case "error":
      return { toolName: state.toolName, argsSummary: state.argsSummary }
  }
}

const OUTCOME_LABEL: Readonly<Record<ApprovalOutcome, string>> = {
  approved: "已批准",
  rejected: "已拒绝",
}

/** idle / resolved 与「待决议」三态的分发：穷尽匹配，新增 phase 编译期报错 */
function ApprovalBody({ state, onApprove, onReject }: ApprovalPromptProps) {
  const summary = toolSummaryOf(state)
  const locked = state.phase === "submitting"

  return (
    <div
      data-slot="thread-approval"
      data-phase={state.phase}
      className={cn(
        "flex flex-col gap-2 border-l-2 py-2 pl-3",
        state.phase === "error" ? "border-l-[var(--color-danger)]" : "border-l-[var(--color-warning)]",
      )}
    >
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <span className="text-xs font-medium text-[var(--text-primary)]">需要审批</span>
        {summary === null ? null : (
          <code className="font-[family-name:var(--font-mono)] text-xs text-[var(--text-secondary)]">
            {summary.toolName}
          </code>
        )}
      </div>

      {summary === null ? null : (
        <p className="m-0 max-w-[68ch] break-words font-[family-name:var(--font-mono)] text-xs leading-relaxed text-[var(--text-secondary)]">
          {summary.argsSummary}
        </p>
      )}

      {state.phase === "error" ? (
        <p
          data-slot="thread-approval-error"
          className="m-0 text-xs text-[var(--color-danger)]"
          role="alert"
        >
          {state.errorMessage}
        </p>
      ) : null}

      {state.phase === "submitting" ? (
        <p data-slot="thread-approval-hint" className="m-0 text-xs text-[var(--text-tertiary)]">
          提交中…
        </p>
      ) : null}

      {state.phase === "resolved" ? (
        <p data-slot="thread-approval-outcome" className="m-0 text-xs text-[var(--text-secondary)]">
          {OUTCOME_LABEL[state.decision]}
        </p>
      ) : null}

      {state.phase === "pending" || state.phase === "submitting" || state.phase === "error" ? (
        <div className="flex gap-2">
          <button
            type="button"
            data-slot="thread-approval-approve"
            disabled={locked}
            onClick={() => { onApprove?.(state.approvalId) }}
            className="h-7 rounded-[var(--radius-control)] border border-[var(--border-primary)] bg-[var(--color-accent-subtle)] px-2.5 text-xs font-medium text-[var(--text-primary)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            批准
          </button>
          <button
            type="button"
            data-slot="thread-approval-reject"
            disabled={locked}
            onClick={() => { onReject?.(state.approvalId) }}
            className="h-7 rounded-[var(--radius-control)] border border-[var(--border-primary)] px-2.5 text-xs font-medium text-[var(--text-secondary)] disabled:cursor-not-allowed disabled:opacity-50"
          >
            拒绝
          </button>
        </div>
      ) : null}
    </div>
  )
}

/**
 * 内联审批框。idle 态返回 null（不留空壳节点）；其余四态渲染状态条 + 决议按钮。
 */
export function ApprovalPrompt(props: ApprovalPromptProps) {
  if (props.state.phase === "idle") return null
  return <ApprovalBody {...props} />
}
