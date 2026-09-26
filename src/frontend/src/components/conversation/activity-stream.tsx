import { useMemo } from "react"

import type { AgentEventEnvelope } from "@pacc/shared"
import { useActivityStore } from "../../store/activityStore"
import type { TaskCard } from "../../store/activityStore"
import { ActivityStream } from "../activity/ActivityStream"

/** runId 为空时的稳定空快照：避免每次渲染新建数组 */
const NO_EVENTS: AgentEventEnvelope[] = []

export interface ConversationRunActivityStreamProps {
  /** 单个 Run —— ActivityTimeline 的拥有者（Conversation 不再是事件事实源） */
  readonly runId: string | null
}

/**
 * Run 作用域 Activity Timeline（AEX-P0-012）。
 * 一个 Run 一条时间线：事件经 getEventsByRun 读取、任务卡经 projectTaskCardByRun 投影，
 * 既不跨 Run 混合，也不随消息重复投影。
 *
 * 订阅说明：store 内 Run 事件数组是"原地追加"（appendEvent push 进同一引用），
 * 直接把数组本身当 selector 结果会因引用相等而永不 re-render，因此以 length 作为
 * 细粒度变更信号，数组本体在 useMemo 中按该信号从 getState() 读取。
 */
export function ConversationRunActivityStream({ runId }: ConversationRunActivityStreamProps) {
  const eventCount = useActivityStore(s => (runId ? s.getEventsByRun(runId).length : 0))
  const events = useMemo(
    () => (runId ? useActivityStore.getState().getEventsByRun(runId) : NO_EVENTS),
    [runId, eventCount],
  )
  const taskCard = useMemo<TaskCard | null>(
    () => (runId ? useActivityStore.getState().projectTaskCardByRun(runId) : null),
    [runId, eventCount],
  )
  if (events.length === 0) return null
  return <ActivityStream events={events} taskCard={taskCard} />
}

export interface ConversationActivityStreamProps {
  readonly conversationId: string | null
}

/**
 * 定位会话当前的活动 Run：runsByConversation 逆序取第一个含 task.started 的 Run
 * （每轮新任务由 task.started 定位新 Run）；没有任何 Run 启动时退回最近到达的 Run。
 * 返回字符串，Zustand 引用比较稳定 —— 容器只在"活动 Run 真正切换"时重渲染。
 */
function resolveActiveRunId(conversationId: string): string | null {
  const store = useActivityStore.getState()
  const runIds = store.runsByConversation[conversationId] ?? []
  for (let i = runIds.length - 1; i >= 0; i--) {
    const runId = runIds[i]
    if (store.eventsByRun[runId]?.some(e => e.eventType === "task.started")) return runId
  }
  return runIds.length > 0 ? runIds[runIds.length - 1] : null
}

/**
 * 共享会话 Activity 容器 —— Chat 与 CodingHome 同一实现。
 * 容器只负责 Run 定位（页面拥有会话选择权，不拥有 Run 身份），投影一律下沉到
 * ConversationRunActivityStream，确保"Run owns ActivityTimeline"只有一处实现。
 */
export function ConversationActivityStream({ conversationId }: ConversationActivityStreamProps) {
  const activeRunId = useActivityStore(s => (conversationId ? resolveActiveRunId(conversationId) : null))
  return <ConversationRunActivityStream runId={activeRunId} />
}
