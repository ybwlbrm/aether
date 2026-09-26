import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it } from "vitest"

import type { AgentEventEnvelope } from "@pacc/shared"
import { useActivityStore } from "../../store/activityStore"
import { ConversationActivityStream, ConversationRunActivityStream } from "./activity-stream"

/**
 * 每个用例独占一个 conversation：activityStore.clearConv 不清理 per-run 去重 Set
 * （_eventIdentitySetByRun），跨用例复用 eventId 会被当成重复事件丢弃。
 */
const CONV_A = "conv-run-a"
const CONV_B = "conv-run-b"
const CONV_EMPTY = "conv-run-empty"

/** v1 协议下 runKey = `${sessionId}:${taskId}` —— 同会话不同 taskId 即两个 Run */
function runIdOf(conversationId: string, taskId: string): string {
  return `${conversationId}:${taskId}`
}

function envelope(
  conversationId: string,
  taskId: string,
  partial: Partial<AgentEventEnvelope> & Pick<AgentEventEnvelope, "eventType">,
): AgentEventEnvelope {
  return {
    eventId: `${conversationId}-${taskId}-${partial.seq ?? 0}`,
    sessionId: conversationId,
    taskId,
    agentId: "main",
    agentType: "conversation",
    timestamp: "2026-08-24T00:00:00Z",
    seq: partial.seq ?? 0,
    ...partial,
  }
}

/** 一个完整 Run：task.started → agent.started → tool → agent 输出 → task.completed */
function seedRun(
  conversationId: string,
  taskId: string,
  fingerprint: { toolTarget: string; agentOutput: string },
): void {
  const store = useActivityStore.getState()
  const toolEventId = `${conversationId}-${taskId}-tool`
  store.appendEvent(
    conversationId,
    envelope(conversationId, taskId, { eventType: "task.started", seq: 1 }),
  )
  store.appendEvent(
    conversationId,
    envelope(conversationId, taskId, {
      eventType: "agent.started",
      seq: 2,
      agentId: "sisyphus",
      agentType: "orchestrator",
      content: `编排 ${taskId}`,
    }),
  )
  store.appendEvent(
    conversationId,
    envelope(conversationId, taskId, {
      eventType: "tool.started",
      seq: 3,
      eventId: toolEventId,
      tool: { toolName: "read_file", toolInput: fingerprint.toolTarget },
    }),
  )
  store.appendEvent(
    conversationId,
    envelope(conversationId, taskId, {
      eventType: "tool.completed",
      seq: 4,
      eventId: `${toolEventId}-done`,
      parentEventId: toolEventId,
      tool: { toolName: "read_file", toolInput: fingerprint.toolTarget, toolOutput: "ok" },
    }),
  )
  store.appendEvent(
    conversationId,
    envelope(conversationId, taskId, {
      eventType: "agent.message.delta",
      seq: 5,
      agentId: "sisyphus",
      content: fingerprint.agentOutput,
    }),
  )
  store.appendEvent(
    conversationId,
    envelope(conversationId, taskId, { eventType: "task.completed", seq: 6, endReason: "stop" }),
  )
}

afterEach(() => {
  useActivityStore.getState().clearConv(CONV_A)
  useActivityStore.getState().clearConv(CONV_B)
  useActivityStore.getState().clearConv(CONV_EMPTY)
})

describe("AEX-P0-012：Activity Timeline 的 Run 作用域", () => {
  it("只投影指定 runId 的事件与任务卡，不混入其它 Run", () => {
    seedRun(CONV_A, "run-a", { toolTarget: "alpha.ts", agentOutput: "输出-A" })
    seedRun(CONV_A, "run-b", { toolTarget: "beta.ts", agentOutput: "输出-B" })

    const markup = renderToStaticMarkup(
      <ConversationRunActivityStream runId={runIdOf(CONV_A, "run-b")} />,
    )

    expect(markup).toContain("beta.ts")
    expect(markup).toContain("输出-B")
    expect(markup).not.toContain("alpha.ts")
    expect(markup).not.toContain("输出-A")
  })

  it("会话容器解析出最近一个已启动的 Run，并只渲染该 Run 的时间线", () => {
    seedRun(CONV_B, "run-a", { toolTarget: "alpha.ts", agentOutput: "输出-A" })
    seedRun(CONV_B, "run-b", { toolTarget: "beta.ts", agentOutput: "输出-B" })

    const markup = renderToStaticMarkup(<ConversationActivityStream conversationId={CONV_B} />)

    expect(markup).toContain("beta.ts")
    expect(markup).toContain("输出-B")
    expect(markup).not.toContain("alpha.ts")
    expect(markup).not.toContain("输出-A")
  })

  it("会话无 Run 时不渲染空时间线", () => {
    seedRun(CONV_EMPTY, "run-a", { toolTarget: "alpha.ts", agentOutput: "输出-A" })

    expect(renderToStaticMarkup(<ConversationActivityStream conversationId={null} />)).toBe("")
    expect(renderToStaticMarkup(<ConversationActivityStream conversationId="conv-has-no-run" />)).toBe("")
    expect(renderToStaticMarkup(<ConversationRunActivityStream runId={null} />)).toBe("")
  })
})
