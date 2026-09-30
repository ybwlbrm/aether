/**
 * Thread —— Codex 风格滚动容器（T17）。
 *
 * 组合：ThreadEmpty / 消息列表（ThreadMessage）/ ConversationActivityStream（既有，
 * 不重造）/ 内联 ToolActivity / RunStatusStrip / ApprovalPrompt / ReasoningBar（能力门控），
 * 外加 children 作为 composer 插槽。
 *
 * **零 effect、零内部 state**：滚动容器只做布局（overflow + 行宽约束），不监听滚动、
 * 不自动滚底 —— 跟随流式输出的滚动由外层挂载方按需实现（本目录刻意不引入
 * jsdom 依赖的滚动副作用）。能力开关（capabilities）同样由 props 表达。
 */
import type { ReactNode } from "react"

import { ConversationActivityStream } from "../conversation/activity-stream"
import type { ConversationMessage } from "../conversation/message-bubble"
import { ApprovalPrompt, type ApprovalPromptProps } from "./ApprovalPrompt"
import { RunStatusStrip, type RunStatusStripProps } from "./RunStatusStrip"
import { ThreadEmpty } from "./ThreadEmpty"
import { ThreadMessage, threadMessageKey } from "./ThreadMessage"
import { ToolActivity, type ToolActivityItem } from "./ToolActivity"

/** 能力开关：决定哪些区块参与渲染（缺省全开，调用方按 capability 逐项收窄） */
export interface ThreadCapabilities {
  /** 思考过程横条 */
  readonly reasoning: boolean
  /** 内联工具活动行 */
  readonly toolActivity: boolean
  /** Run 状态条与生命周期动作 */
  readonly runStatus: boolean
}

export const DEFAULT_THREAD_CAPABILITIES: ThreadCapabilities = {
  reasoning: true,
  toolActivity: true,
  runStatus: true,
}

export interface ThreadProps {
  /** 会话 id：透传给既有 ConversationActivityStream（null 时不渲染时间线） */
  readonly conversationId: string | null
  readonly messages: readonly ConversationMessage[]
  readonly capabilities?: Partial<ThreadCapabilities>
  /** 思考过程内容（仅在 capabilities.reasoning 为真时渲染） */
  readonly reasoning?: ReactNode | null
  /** Run 状态条参数（仅在 capabilities.runStatus 为真时渲染） */
  readonly run?: RunStatusStripProps | null
  /** 内联审批框（仅在 messages 之后、composer 之前） */
  readonly approval?: ApprovalPromptProps | null
  /** 会话级工具活动行（仅在 capabilities.toolActivity 为真时渲染） */
  readonly toolActivities?: readonly ToolActivityItem[]
  /** 空态提示语 */
  readonly emptyHint?: string
  /** composer 插槽：渲染在滚动区之外 */
  readonly children?: ReactNode
}

/** 消息列表：用稳定复合键渲染，空数组交给 ThreadEmpty */
function ThreadMessageList({ messages, emptyHint }: { readonly messages: readonly ConversationMessage[]; readonly emptyHint?: string }) {
  if (messages.length === 0) return <ThreadEmpty hint={emptyHint} />
  return (
    <div data-slot="thread-messages" className="flex flex-col gap-4">
      {messages.map((message, index) => (
        <ThreadMessage key={threadMessageKey(message, index)} message={message} index={index} />
      ))}
    </div>
  )
}

/** 会话级工具活动行 */
function ThreadToolActivityList({ items }: { readonly items: readonly ToolActivityItem[] }) {
  return (
    <div data-slot="thread-tool-activities" className="flex flex-col gap-1">
      {items.map((item) => (
        <ToolActivity key={item.entry.eventId} {...item} />
      ))}
    </div>
  )
}

export function Thread({
  conversationId,
  messages,
  capabilities,
  reasoning,
  run,
  approval,
  toolActivities,
  emptyHint,
  children,
}: ThreadProps) {
  const caps: ThreadCapabilities = { ...DEFAULT_THREAD_CAPABILITIES, ...capabilities }
  return (
    <section data-slot="thread" className="flex min-h-0 flex-1 flex-col">
      {run === undefined || run === null || !caps.runStatus ? null : (
        <div className="px-4">
          <RunStatusStrip {...run} />
        </div>
      )}

      <div
        data-slot="thread-scroll"
        className="min-h-0 flex-1 overflow-y-auto px-4"
        style={{ maxWidth: "var(--content-prose)", marginInline: "auto", width: "100%" }}
      >
        <ThreadMessageList messages={messages} emptyHint={emptyHint} />

        {toolActivities === undefined || toolActivities.length === 0 || !caps.toolActivity ? null : (
          <ThreadToolActivityList items={toolActivities} />
        )}

        <ConversationActivityStream conversationId={conversationId} />
      </div>

      {reasoning === undefined || reasoning === null || !caps.reasoning ? null : (
        <div data-slot="thread-reasoning" className="px-4">
          {reasoning}
        </div>
      )}

      {approval === undefined || approval === null ? null : (
        <div data-slot="thread-approval-slot" className="px-4 pb-2">
          <ApprovalPrompt {...approval} />
        </div>
      )}

      <div data-slot="thread-composer" className="border-t border-[var(--border-secondary)] px-4 py-3">
        {children}
      </div>
    </section>
  )
}
