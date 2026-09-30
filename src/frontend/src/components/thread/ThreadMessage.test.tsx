import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it } from "vitest"

import type { ConversationMessage } from "../conversation/message-bubble"
import type { ToolActivityEntry } from "../../store/projections"
import { ThreadMessage, threadMessageKey, type ThreadMessageProps } from "./ThreadMessage"

const USER_MSG: ConversationMessage = {
  id: "m-user",
  role: "user",
  content: "帮我看一眼入口文件",
  createdAt: "2026-08-24T00:00:00Z",
}
const ASSISTANT_MSG: ConversationMessage = {
  id: "m-ai",
  role: "assistant",
  content: "入口是 main.ts，已核对",
  createdAt: "2026-08-24T00:00:05Z",
}

const TOOL_ENTRY: ToolActivityEntry = {
  eventId: "tool-1",
  toolName: "read_file",
  label: "Read",
  kind: "read",
  target: "src/main.ts",
  status: "completed",
  startedAt: "2026-08-24T00:00:01Z",
  endedAt: "2026-08-24T00:00:02Z",
  hasDetail: true,
}

function render(props: ThreadMessageProps): string {
  return renderToStaticMarkup(<ThreadMessage {...props} />)
}

describe("ThreadMessage：包裹既有气泡 + 内联插槽", () => {
  it("按消息顺序渲染用户与助手消息", () => {
    const markup = renderToStaticMarkup(
      <>
        <ThreadMessage message={USER_MSG} index={0} />
        <ThreadMessage message={ASSISTANT_MSG} index={1} />
      </>,
    )

    const userAt = markup.indexOf("帮我看一眼入口文件")
    const assistantAt = markup.indexOf("入口是 main.ts，已核对")
    expect(userAt).toBeGreaterThanOrEqual(0)
    expect(assistantAt).toBeGreaterThan(userAt)
  })

  it("行包装带 data-message-id 便于回查", () => {
    const markup = render({ message: USER_MSG, index: 0 })

    expect(markup).toContain('data-slot="thread-message"')
    expect(markup).toContain('data-message-id="m-user"')
    expect(markup).toContain('data-role="user"')
  })

  it("pendingApproval 消息渲染内联 ApprovalPrompt", () => {
    const markup = render({
      message: ASSISTANT_MSG,
      index: 1,
      approval: {
        state: { phase: "pending", approvalId: "ap-1", toolName: "write_file", argsSummary: "src/a.ts" },
      },
    })

    expect(markup).toContain('data-slot="thread-approval"')
    expect(markup).toContain('data-phase="pending"')
    expect(markup).toContain("write_file")
    expect(markup).toContain('data-slot="thread-approval-approve"')
  })

  it("approval 为 idle 时不渲染审批框", () => {
    const markup = render({ message: ASSISTANT_MSG, index: 1, approval: { state: { phase: "idle" } } })

    expect(markup).not.toContain('data-slot="thread-approval"')
  })

  it("内联 ToolActivity 插在气泡之后（tool 角色消息无气泡仍出工具行）", () => {
    const toolMessage: ConversationMessage = {
      id: "m-tool",
      role: "tool",
      content: "read_file src/main.ts",
      createdAt: "2026-08-24T00:00:01Z",
    }
    const markup = render({
      message: toolMessage,
      index: 2,
      toolActivities: [
        {
          entry: TOOL_ENTRY,
          hasFullToolPayload: false,
          defaultExpanded: false,
        },
      ],
    })

    expect(markup).toContain('data-slot="thread-tool-activity"')
    expect(markup).toContain("src/main.ts")
  })

  it("retry / loop affordance 插槽原样渲染（逻辑由外部注入）", () => {
    const markup = render({
      message: ASSISTANT_MSG,
      index: 1,
      retrySlot: <button type="button">重试这一步</button>,
      loopSlot: <button type="button">在循环中重跑</button>,
    })

    expect(markup).toContain('data-slot="thread-message-retry-slot"')
    expect(markup).toContain('data-slot="thread-message-loop-slot"')
    expect(markup).toContain("重试这一步")
    expect(markup).toContain("在循环中重跑")
  })

  it("无插槽时不渲染空壳节点", () => {
    const markup = render({ message: ASSISTANT_MSG, index: 1 })

    expect(markup).not.toContain('data-slot="thread-message-retry-slot"')
    expect(markup).not.toContain('data-slot="thread-message-loop-slot"')
  })
})

describe("threadMessageKey：稳定复合键（role + createdAt + index）", () => {
  it("temp-ai-streaming → temp-ai-streaming-done 交换后 key 不变（气泡不重挂）", () => {
    const streaming: ConversationMessage = {
      id: "temp-ai-streaming",
      role: "assistant",
      content: "半句",
      createdAt: "2026-08-24T00:00:00.100Z",
    }
    const done: ConversationMessage = {
      id: "temp-ai-streaming-done",
      role: "assistant",
      content: "完整回答",
      createdAt: "2026-08-24T00:00:03.900Z",
    }

    expect(threadMessageKey(streaming, 2)).toBe(threadMessageKey(done, 2))
  })

  it("真实消息的 createdAt 与位置都参与 key", () => {
    const a: ConversationMessage = { id: "a", role: "user", content: "a", createdAt: "2026-08-24T00:00:00Z" }
    const b: ConversationMessage = { id: "b", role: "user", content: "b", createdAt: "2026-08-24T00:00:01Z" }

    expect(threadMessageKey(a, 0)).not.toBe(threadMessageKey(b, 0))
    expect(threadMessageKey(a, 0)).not.toBe(threadMessageKey(a, 1))
  })

  it("角色不同的同刻消息 key 不冲突", () => {
    const user: ConversationMessage = { id: "u", role: "user", content: "x", createdAt: "2026-08-24T00:00:00Z" }
    const assistant: ConversationMessage = { id: "a", role: "assistant", content: "x", createdAt: "2026-08-24T00:00:00Z" }

    expect(threadMessageKey(user, 0)).not.toBe(threadMessageKey(assistant, 0))
  })
})
