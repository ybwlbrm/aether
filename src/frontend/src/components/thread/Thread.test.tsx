import { renderToStaticMarkup } from "react-dom/server"
import { afterEach, describe, expect, it } from "vitest"

import type { AgentEventEnvelope } from "@pacc/shared"
import { useActivityStore } from "../../store/activityStore"
import type { ConversationMessage } from "../conversation/message-bubble"
import { Thread, type ThreadProps } from "./Thread"
import { ThreadEmpty } from "./ThreadEmpty"
import { threadMessageKey } from "./ThreadMessage"

const CONV = "conv-thread-t17"
const CONV_TOOL = "conv-thread-t17-tool"

/** 占位流式消息与完成消息：id / createdAt 都变，复合 key 必须保持一致 */
const STREAMING: ConversationMessage = {
  id: "temp-ai-streaming",
  role: "assistant",
  content: "先读入口",
  createdAt: "2026-08-24T00:00:00.100Z",
}
const DONE: ConversationMessage = {
  id: "temp-ai-streaming-done",
  role: "assistant",
  content: "先读入口，再改配置",
  createdAt: "2026-08-24T00:00:04.200Z",
}
const USER: ConversationMessage = {
  id: "m-user",
  role: "user",
  content: "这个仓库怎么跑起来",
  createdAt: "2026-08-24T00:00:00Z",
}
const ASSISTANT: ConversationMessage = {
  id: "m-ai",
  role: "assistant",
  content: "先读入口，再改配置",
  createdAt: "2026-08-24T00:00:06Z",
}

function render(props: Partial<ThreadProps> = {}): string {
  return renderToStaticMarkup(
    <Thread conversationId={CONV} messages={[]} {...props}>
      <div data-slot="composer-stub">composer</div>
    </Thread>,
  )
}

function envelope(partial: Partial<AgentEventEnvelope> & { eventType: string }): AgentEventEnvelope {
  return {
    eventId: `thread-${CONV_TOOL}-${partial.seq ?? 0}`,
    sessionId: CONV_TOOL,
    taskId: "t-1",
    agentId: "main",
    agentType: "conversation",
    timestamp: "2026-08-24T00:00:00Z",
    seq: partial.seq ?? 0,
    ...partial,
  } as AgentEventEnvelope
}

afterEach(() => {
  useActivityStore.getState().clearConv(CONV)
  useActivityStore.getState().clearConv(CONV_TOOL)
})

describe("Thread：Codex 风格滚动容器", () => {
  it("按消息顺序渲染全部消息", () => {
    const markup = render({ messages: [USER, STREAMING] })

    expect(markup).toContain('data-slot="thread"')
    const userAt = markup.indexOf("这个仓库怎么跑起来")
    const assistantAt = markup.indexOf("先读入口")
    expect(userAt).toBeGreaterThanOrEqual(0)
    expect(assistantAt).toBeGreaterThan(userAt)
  })

  it("流式占位换成完成消息后消息行数不变（key 稳定 → 气泡不重挂）", () => {
    const before = render({ messages: [USER, STREAMING] })
    const after = render({ messages: [USER, DONE] })

    const countRows = (markup: string): number => markup.split('data-slot="thread-message"').length - 1
    expect(countRows(before)).toBe(2)
    expect(countRows(after)).toBe(2)
    expect(threadMessageKey(STREAMING, 1)).toBe(threadMessageKey(DONE, 1))
  })

  it("空态渲染左对齐提示语，不是居中 hero", () => {
    const markup = render({ messages: [] })

    expect(markup).toContain('data-slot="thread-empty"')
    expect(markup).toContain("描述你的任务")
    expect(markup).toContain("text-left")
    expect(markup).not.toContain("text-center")
    expect(markup).not.toContain("justify-center")
    expect(markup).not.toContain("items-center")
  })

  it("有消息时不渲染空态", () => {
    expect(render({ messages: [USER] })).not.toContain('data-slot="thread-empty"')
  })

  it("空态组件单独渲染时同样左对齐", () => {
    const markup = renderToStaticMarkup(<ThreadEmpty />)

    expect(markup).toContain("描述你的任务")
    expect(markup).toContain('data-align="start"')
    expect(markup).not.toContain("text-center")
  })

  it("reasoning 能力开启时渲染思考横条", () => {
    const markup = render({
      messages: [USER],
      capabilities: { reasoning: true },
      reasoning: <span>正在拆解任务边界</span>,
    })

    expect(markup).toContain('data-slot="thread-reasoning"')
    expect(markup).toContain("正在拆解任务边界")
  })

  it("reasoning 能力关闭时思考横条缺席（capability 门控）", () => {
    const markup = render({
      messages: [USER],
      capabilities: { reasoning: false },
      reasoning: <span>正在拆解任务边界</span>,
    })

    expect(markup).not.toContain('data-slot="thread-reasoning"')
    expect(markup).not.toContain("正在拆解任务边界")
  })

  it("run 状态条组合进容器，且受 runStatus 能力门控", () => {
    const on = render({
      messages: [USER],
      capabilities: { runStatus: true },
      run: { runId: "run-1", status: "running" },
    })
    expect(on).toContain('data-slot="thread-run-status"')
    expect(on).toContain('data-status="running"')

    const off = render({
      messages: [USER],
      capabilities: { runStatus: false },
      run: { runId: "run-1", status: "running" },
    })
    expect(off).not.toContain('data-slot="thread-run-status"')
  })

  it("工具活动行组合进容器，且受 toolActivity 能力门控", () => {
    const item = {
      entry: {
        eventId: "tool-1",
        toolName: "read_file",
        label: "Read",
        kind: "read" as const,
        target: "package.json",
        status: "completed" as const,
        startedAt: "2026-08-24T00:00:01Z",
        endedAt: "2026-08-24T00:00:02Z",
        hasDetail: false,
      },
      hasFullToolPayload: false,
      defaultExpanded: false,
    }

    const on = render({ messages: [USER], capabilities: { toolActivity: true }, toolActivities: [item] })
    expect(on).toContain('data-slot="thread-tool-activity"')
    expect(on).toContain("package.json")

    const off = render({ messages: [USER], capabilities: { toolActivity: false }, toolActivities: [item] })
    expect(off).not.toContain('data-slot="thread-tool-activity"')
  })

  it("复用既有 ConversationActivityStream：有事件时渲染活动时间线", () => {
    const store = useActivityStore.getState()
    store.appendEvent(
      CONV_TOOL,
      envelope({
        eventType: "tool.started",
        seq: 1,
        tool: { toolName: "read_file", toolInput: "vite.config.ts" },
      }),
    )

    const markup = render({ conversationId: CONV_TOOL, messages: [USER] })
    expect(markup).toContain("vite.config.ts")
  })

  it("composer slot（children）渲染在滚动区之外", () => {
    const markup = render({ messages: [USER] })

    expect(markup).toContain('data-slot="thread-composer"')
    expect(markup).toContain("composer")
    expect(markup.indexOf('data-slot="thread-composer"')).toBeGreaterThan(
      markup.indexOf('data-slot="thread-scroll"'),
    )
  })

  it("审批框组合进容器", () => {
    const markup = render({
      messages: [USER],
      approval: {
        state: { phase: "pending", approvalId: "ap-1", toolName: "delete_file", argsSummary: "old.log" },
        onApprove: () => undefined,
        onReject: () => undefined,
      },
    })

    expect(markup).toContain('data-slot="thread-approval"')
    expect(markup).toContain("delete_file")
  })
})
