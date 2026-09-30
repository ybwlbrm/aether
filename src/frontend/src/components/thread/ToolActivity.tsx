/**
 * ToolActivity —— 内联可折叠工具活动行（T17 核心）。
 *
 * 三条硬约束：
 * 1. **无 effect、无 state**：`defaultExpanded` 是 prop，展开意图经 `onToggle` 冒泡给
 *    外部持有者，组件自身不记得自己展开过 —— 因此 `renderToStaticMarkup` 可直接断言
 *    折叠/展开两态的 markup。
 * 2. **只读 envelope**：`tool-call` StreamEvent 在服务端是刻意 no-op，工具活动的唯一
 *    事实源是 envelope（`projectToolActivity` 的 ToolActivityEntry + 事件自带的
 *    ToolEventPayload）。组件不猜测、不合成任何服务端没给的字段。
 * 3. **诚实降级**：`hasFullToolPayload === false`（packed 回放丢载荷）时渲染显式
 *    "detail unavailable after replay"，绝不拿 target 字符串伪造完整文件内容。
 */
import type { ReactNode } from "react"

import { classifyTool } from "../../lib/tool-models"
import type { ToolActivityEntry, ToolActivityStatus } from "../../store/projections"

/** 一行工具活动（投影条目 + 两帧载荷细节 + 展开态 + 切换意图） */
export interface ToolActivityItem {
  /** T9 projectToolActivity 产出的条目（label / target / status / 时间戳） */
  readonly entry: ToolActivityEntry
  /** 锚点帧（tool.started）的 inputDetail */
  readonly inputDetail?: unknown
  /** 终态帧（tool.completed/error）的 outputDetail */
  readonly outputDetail?: unknown
  /** T9 hasFullToolPayload 的结论：false 时只展示降级提示 */
  readonly hasFullToolPayload: boolean
  /** 展开态（props，不是 state） */
  readonly defaultExpanded: boolean
  /** 展开意图冒泡：外部翻这个 prop 后重渲染 */
  readonly onToggle?: () => void
}

export interface ToolActivityProps extends ToolActivityItem {}

const STATUS_LABEL: Readonly<Record<ToolActivityStatus, string>> = {
  running: "进行中",
  completed: "已完成",
  error: "失败",
  retry: "重试中",
}

/** 状态 → 语义色 token（与 RUN_STATUS_META 的 --status-* 层同源） */
const STATUS_TOKEN: Readonly<Record<ToolActivityStatus, string>> = {
  running: "var(--color-info)",
  completed: "var(--color-success)",
  error: "var(--color-danger)",
  retry: "var(--color-warning)",
}

/**
 * 两个 ISO 时间戳之差 → "2.0s"。任一侧不可解析时返回 null
 * —— 调用方据此不显示时长，而不是显示 NaN / 0.0s 之类的假数字。
 */
export function formatToolDuration(startedAt: string, endedAt: string): string | null {
  const from = Date.parse(startedAt)
  const to = Date.parse(endedAt)
  if (Number.isNaN(from) || Number.isNaN(to)) return null
  return `${((to - from) / 1000).toFixed(1)}s`
}

/** 折叠行右侧的时长 / 进行中提示 */
function DurationHint({ entry }: { readonly entry: ToolActivityEntry }) {
  if (entry.endedAt === undefined) {
    return (
      <span data-slot="thread-tool-duration" className="text-xs text-[var(--text-tertiary)]">
        {entry.status === "running" ? "进行中" : "未结束"}
      </span>
    )
  }
  const duration = formatToolDuration(entry.startedAt, entry.endedAt)
  if (duration === null) return null
  return (
    <span data-slot="thread-tool-duration" className="text-xs tabular-nums text-[var(--text-tertiary)]">
      {duration}
    </span>
  )
}

/** 完整载荷的一侧（inputDetail / outputDetail） */
function DetailBlock({ title, value }: { readonly title: string; readonly value: unknown }) {
  let json: string
  try {
    json = JSON.stringify(value, null, 2) ?? String(value)
  } catch {
    json = String(value)
  }
  return (
    <div data-slot="thread-tool-detail-block" data-detail={title} className="flex flex-col gap-1">
      <span className="text-[11px] uppercase tracking-wide text-[var(--text-tertiary)]">{title}</span>
      <pre className="m-0 max-h-64 overflow-auto whitespace-pre-wrap break-words rounded-[var(--radius-subtle)] bg-[var(--bg-surface)] p-2 font-[family-name:var(--font-mono)] text-xs leading-relaxed text-[var(--text-secondary)]">
        {json}
      </pre>
    </div>
  )
}

/** 展开区：完整载荷，或 packed 回放下的诚实降级提示 */
function ToolDetail({ item }: { readonly item: ToolActivityProps }) {
  if (!item.hasFullToolPayload) {
    return (
      <p
        data-slot="thread-tool-detail-unavailable"
        className="m-0 text-xs italic text-[var(--text-tertiary)]"
      >
        detail unavailable after replay — 需要完整事件回放才能展开
      </p>
    )
  }
  const blocks: ReactNode[] = []
  if (item.inputDetail !== undefined) {
    blocks.push(<DetailBlock key="input" title="inputDetail" value={item.inputDetail} />)
  }
  if (item.outputDetail !== undefined) {
    blocks.push(<DetailBlock key="output" title="outputDetail" value={item.outputDetail} />)
  }
  if (blocks.length === 0) return null
  return (
    <div data-slot="thread-tool-detail" className="flex flex-col gap-2 pl-4">
      {blocks}
    </div>
  )
}

/** 折叠态主行：状态点 + 工具标签 + 目标 + 机器类别 + 时长 */
function ToolSummaryRow({ item }: { readonly item: ToolActivityProps }) {
  const { entry, defaultExpanded } = item
  const target = entry.target.trim()
  return (
    <button
      type="button"
      data-slot="thread-tool-activity-toggle"
      aria-expanded={defaultExpanded}
      onClick={item.onToggle}
      className="flex w-full items-center gap-2 py-1 text-left text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
    >
      <span
        data-slot="thread-tool-status-dot"
        aria-hidden="true"
        style={{ background: STATUS_TOKEN[entry.status] }}
        className="inline-block size-1.5 shrink-0 rounded-full"
      />
      <span className="font-medium text-[var(--text-primary)]">{entry.label}</span>
      {target === "" ? (
        <span className="text-[var(--text-tertiary)]">未知目标</span>
      ) : (
        <span className="truncate font-[family-name:var(--font-mono)] text-[var(--text-secondary)]">{target}</span>
      )}
      <span className="ml-auto shrink-0 text-[var(--text-tertiary)]">{classifyTool(entry.toolName)}</span>
      <DurationHint entry={entry} />
      <span data-slot="thread-tool-status-label" className="shrink-0 text-[var(--text-tertiary)]">
        {STATUS_LABEL[entry.status]}
      </span>
    </button>
  )
}

/**
 * 单行工具活动。折叠 = 一行摘要；展开 = inputDetail / outputDetail 的 JSON。
 * 状态与展开态全部来自 props，组件是纯函数（可 SSR 断言）。
 */
export function ToolActivity(props: ToolActivityProps) {
  const { entry, defaultExpanded } = props
  return (
    <div
      data-slot="thread-tool-activity"
      data-tool={entry.toolName}
      data-status={entry.status}
      data-expanded={defaultExpanded}
      className="flex flex-col gap-1 border-l border-[var(--border-secondary)] pl-3"
    >
      <ToolSummaryRow item={props} />
      {defaultExpanded ? <ToolDetail item={props} /> : null}
    </div>
  )
}
