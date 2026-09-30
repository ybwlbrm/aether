/**
 * ThreadMessage —— 单条消息行包装（T17）。
 *
 * 只做三件事：
 * 1. 包裹既有 ConversationMessageBubble（components/conversation/message-bubble.tsx，
 *    保持不动）—— 气泡的排版/图片/markdown 语义不在本目录重造。
 * 2. 提供**内联插槽**：工具活动行、审批框、Retry / Loop affordance。插槽内容由外部
 *    注入，本组件不实现任何重试或循环逻辑。
 * 3. 提供稳定复合键 `threadMessageKey`（role + createdAt + index），让流式占位消息
 *    换成完成消息时 React 不重挂气泡（保住 markdown 高亮与滚动位置）。
 */
import type { ReactNode } from "react"

import { ConversationMessageBubble, type ConversationMessage } from "../conversation/message-bubble"
import { ApprovalPrompt, type ApprovalPromptProps } from "./ApprovalPrompt"
import { ToolActivity, type ToolActivityItem } from "./ToolActivity"

/** 临时占位消息前缀（hooks/useStreamSend.ts 的乐观流式消息） */
const TEMP_ID_PREFIX = "temp-"

/**
 * 稳定复合键：`role | createdAt | index`。
 *
 * 刻意**不含** message.id —— 流式收尾时 `temp-ai-streaming` 会被换成
 * `temp-ai-streaming-done`（useStreamSend.ts:354-358），id 变了而气泡应当留在原位。
 * 同理，占位消息的 createdAt 每次重放都是新的 `new Date()`，不是身份信号，故归一为空串；
 * 真实消息的 createdAt 来自服务端、参与 key，能区分同角色同位置的两次发言。
 */
export function threadMessageKey(message: ConversationMessage, index: number): string {
  const stamp = message.id.startsWith(TEMP_ID_PREFIX) ? "" : (message.createdAt ?? "")
  return `${message.role}|${stamp}|${index}`
}

export interface ThreadMessageProps {
  readonly message: ConversationMessage
  /** 列表位置：既用于气泡入场延迟，也参与稳定 key */
  readonly index: number
  /** 内联工具活动行（由调用方从 projectToolActivity + 事件载荷组装） */
  readonly toolActivities?: readonly ToolActivityItem[]
  /** 内联审批框（state + 回调整体透传） */
  readonly approval?: ApprovalPromptProps | null
  /** 重试 affordance 插槽（逻辑由外部注入） */
  readonly retrySlot?: ReactNode
  /** 循环重跑 affordance 插槽（逻辑由外部注入） */
  readonly loopSlot?: ReactNode
}

function ToolActivityList({ items }: { readonly items: readonly ToolActivityItem[] }) {
  return (
    <div data-slot="thread-message-tool-activity" className="flex flex-col gap-1">
      {items.map((item) => (
        <ToolActivity key={item.entry.eventId} {...item} />
      ))}
    </div>
  )
}

export function ThreadMessage({ message, index, toolActivities, approval, retrySlot, loopSlot }: ThreadMessageProps) {
  return (
    <div data-slot="thread-message" data-message-id={message.id} data-role={message.role} className="flex flex-col">
      <ConversationMessageBubble message={message} index={index} />
      {toolActivities === undefined || toolActivities.length === 0 ? null : (
        <ToolActivityList items={toolActivities} />
      )}
      {approval === undefined || approval === null ? null : <ApprovalPrompt {...approval} />}
      {retrySlot === undefined ? null : (
        <div data-slot="thread-message-retry-slot" className="flex gap-2">
          {retrySlot}
        </div>
      )}
      {loopSlot === undefined ? null : (
        <div data-slot="thread-message-loop-slot" className="flex gap-2">
          {loopSlot}
        </div>
      )}
    </div>
  )
}
