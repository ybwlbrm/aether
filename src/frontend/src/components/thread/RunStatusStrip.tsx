/**
 * RunStatusStrip —— Run 状态条（T17 核心 / T5 展示元数据 + T2 动作端点）。
 *
 * 两条硬约束：
 * 1. **按钮可见性只由 T5 判定**：`RUN_STATUS_META[status].cancellable / pausable /
 *    resumable` 镜像后端**路由层** allow-list（src/backend/src/modules/runs/routes.ts），
 *    所以本组件永远不会发出必然 409 的请求。典型后果：retrying 不显示「继续」——
 *    RunLifecycleManager 允许，但路由层只接受 waiting。
 * 2. **不接受「进行中 / 已结束 / 流式中」这类布尔 prop**：整个条只认一个
 *    `status: RunStatus`，状态判定全部下沉到 T5 的穷尽 Record。布尔组合无法穷尽
 *    11 态，漏一个组合就会出现"显示取消按钮但服务端 409"的错位。
 *
 * 组件零 state / 零 effect：动作经 props 冒泡；需要直连后端时用
 * `createRunStatusHandlers`（下方）把 T2 的 runsApi 接上。
 */
import type { ReactNode } from "react"
import type { RunStatus } from "@pacc/shared"

import { runsApi } from "../../api/runs"
import { RUN_STATUS_META, type RunStatusMeta, type RunStatusTone } from "../../lib/run-status"

/** 生命周期动作处理器：统一透传 runId，具体实现由外部注入 */
export interface RunStatusActionHandlers {
  readonly onPause?: (runId: string) => void
  readonly onResume?: (runId: string) => void
  readonly onCancel?: (runId: string) => void
}

export interface RunStatusStripProps extends RunStatusActionHandlers {
  readonly runId: string
  readonly status: RunStatus
  /** 附加信息（重试次数 / 结束原因 / 预算），渲染在状态标签之后 */
  readonly detail?: ReactNode
}

/** tone → 语义色 token（与 tokens.css 的 --status-* 层同源，不硬编码色值） */
const TONE_TOKEN: Readonly<Record<RunStatusTone, string>> = {
  neutral: "var(--color-neutral)",
  info: "var(--color-info)",
  success: "var(--color-success)",
  warning: "var(--color-warning)",
  danger: "var(--color-danger)",
}

const ACTION_CLASS =
  "h-7 rounded-[var(--radius-control)] border border-[var(--border-primary)] px-2.5 text-xs font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)]"

/** 生命周期动作按钮：仅在 T5 判定该状态下合法时才渲染 */
function RunActions({ meta, runId, handlers }: { readonly meta: RunStatusMeta; readonly runId: string; readonly handlers: RunStatusActionHandlers }) {
  return (
    <div data-slot="thread-run-actions" className="ml-auto flex items-center gap-2">
      {meta.pausable ? (
        <button
          type="button"
          data-slot="thread-run-pause"
          onClick={() => { handlers.onPause?.(runId) }}
          className={ACTION_CLASS}
        >
          暂停
        </button>
      ) : null}
      {meta.resumable ? (
        <button
          type="button"
          data-slot="thread-run-resume"
          onClick={() => { handlers.onResume?.(runId) }}
          className={ACTION_CLASS}
        >
          继续
        </button>
      ) : null}
      {meta.cancellable ? (
        <button
          type="button"
          data-slot="thread-run-cancel"
          onClick={() => { handlers.onCancel?.(runId) }}
          className={ACTION_CLASS}
        >
          取消
        </button>
      ) : null}
    </div>
  )
}

/** Run 状态条：状态点 + 中文标签 + 可选 detail + 合法动作。 */
export function RunStatusStrip({ runId, status, detail, ...handlers }: RunStatusStripProps) {
  const meta = RUN_STATUS_META[status]
  return (
    <div
      data-slot="thread-run-status"
      data-status={status}
      data-tone={meta.tone}
      data-terminal={meta.terminal}
      data-busy={meta.busy}
      className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-[var(--border-secondary)] py-2 text-xs"
    >
      <span
        data-slot="thread-run-status-dot"
        aria-hidden="true"
        style={{ background: `var(${meta.tokenVar})` }}
        className="inline-block size-1.5 shrink-0 rounded-full"
      />
      <span data-slot="thread-run-status-label" className="font-medium text-[var(--text-primary)]">
        {meta.label}
      </span>
      <span
        data-slot="thread-run-status-tone"
        style={{ color: TONE_TOKEN[meta.tone] }}
        className="text-[var(--text-tertiary)]"
      >
        {meta.tone}
      </span>
      {detail === undefined ? null : (
        <span data-slot="thread-run-status-detail" className="text-[var(--text-tertiary)]">
          {detail}
        </span>
      )}
      <RunActions meta={meta} runId={runId} handlers={handlers} />
    </div>
  )
}

/**
 * 把 T2 的 runsApi 接成 RunStatusStrip 的动作处理器。
 *
 * 失败一律经 `onError` 上报（409 INVALID_TRANSITION / 404 RUN_NOT_FOUND 等），
 * 绝不 catch 后静默吞掉 —— 状态条必须如实告诉用户动作没生效。
 */
export function createRunStatusHandlers(onError: (error: unknown) => void): Required<RunStatusActionHandlers> {
  const report = (operation: Promise<unknown>): void => {
    operation.catch(onError)
  }
  return {
    onPause: (runId) => { report(runsApi.pauseRun(runId)) },
    onResume: (runId) => { report(runsApi.resumeRun(runId)) },
    onCancel: (runId) => { report(runsApi.cancelRun(runId)) },
  }
}
