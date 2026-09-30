import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { AgentEventEnvelope } from "@pacc/shared"
import type { StreamFailure, StreamSendOptions } from "../hooks/useStreamSend"
import { useActivityStore } from "../store/activityStore"

type StreamSendStub = {
  readonly handleSend: (content?: string) => Promise<void>
  readonly stopGeneration: () => void
}

const harness = vi.hoisted(() => ({
  options: null as StreamSendOptions | null,
  failure: null as StreamFailure | null,
  useStreamSendCalls: 0,
  streamConversationCalls: 0,
  streamOrchestrateCalls: 0,
  send: async (_content?: string): Promise<void> => undefined,
  stop: (): void => undefined,
}))

// 只替换 useStreamSend 本身，保留 createStreamFailure 等纯函数（importOriginal 无副作用）
vi.mock("../hooks/useStreamSend", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/useStreamSend")>()
  return {
    ...actual,
    useStreamSend: (options: StreamSendOptions) => {
      harness.useStreamSendCalls += 1
      harness.options = options
      const stub: StreamSendStub = { handleSend: harness.send, stopGeneration: harness.stop }
      return {
        ...stub,
        sending: false,
        thinking: false,
        failure: harness.failure,
        streamTokens: null,
        retryInfo: null,
        liveReasoning: "",
        setSending: () => undefined,
        setThinking: () => undefined,
      }
    },
  }
})

// CodingHome 不应再直接触碰流客户端 —— 任何调用都视为内联发送循环回归
vi.mock("../api/streamClient", () => ({
  streamConversation: () => {
    harness.streamConversationCalls += 1
  },
  streamOrchestrate: () => {
    harness.streamOrchestrateCalls += 1
  },
  fetchEvents: async () => [],
}))

import {
  CodingHome,
  createRemoteCommandHost,
  REMOTE_COMMAND_POLL_INTERVAL_MS,
  REMOTE_COMMAND_TIMEOUT_MS,
  type RemoteCommandHostOptions,
  type RemoteCommandStatus,
} from "./CodingHome"

const CONV_ID = "conv-accumulate"

function envelope(partial: Partial<AgentEventEnvelope> & Pick<AgentEventEnvelope, "eventType">): AgentEventEnvelope {
  return {
    eventId: `e-${partial.taskId ?? "t"}-${partial.seq ?? 0}`,
    sessionId: CONV_ID,
    taskId: "t-1",
    agentId: "main",
    agentType: "conversation",
    timestamp: "2026-08-24T00:00:00Z",
    seq: 0,
    ...partial,
  }
}

const realClearConv = useActivityStore.getState().clearConv

/**
 * 在 store 状态对象上替换 clearConv：zustand 的 set() 通过 Object.assign 复制上一份状态，
 * 因此这里打上的替换会随之后所有 getState() 快照传播，可覆盖组件内的真实调用点。
 */
function watchClearConv(): string[] {
  const calls: string[] = []
  useActivityStore.getState().clearConv = (convId: string) => {
    calls.push(convId)
  }
  return calls
}

function renderCodingHome(): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={["/command-center"]}>
      <CodingHome />
    </MemoryRouter>,
  )
}

function capturedOptions(): StreamSendOptions {
  if (!harness.options) throw new Error("useStreamSend was never called")
  return harness.options
}

/** 用 EventTarget 驱动远程命令宿主（等价于组件 useEffect 注册的窗口监听） */
function mountRemoteCommandHost(overrides: Partial<RemoteCommandHostOptions>): {
  readonly dispatch: (detail: unknown) => void
  readonly failures: StreamFailure[]
  readonly userCommands: string[]
  readonly opened: string[]
} {
  const failures: StreamFailure[] = []
  const userCommands: string[] = []
  const opened: string[] = []
  const target = new EventTarget()
  const host = createRemoteCommandHost({
    onUserCommand: (content) => { userCommands.push(content) },
    onOpenConversation: async (conversationId) => { opened.push(conversationId) },
    onFailure: (failure) => { failures.push(failure) },
    fetchCommandStatus: async () => ({ command: { status: "pending" } }),
    ...overrides,
  })
  target.addEventListener("remote-command", (e) => { void host.handleEvent(e) })
  return {
    dispatch: (detail) => { target.dispatchEvent(new CustomEvent("remote-command", { detail })) },
    failures,
    userCommands,
    opened,
  }
}

describe("CodingHome 收敛到共享 useStreamSend", () => {
  beforeEach(() => {
    harness.options = null
    harness.failure = null
    harness.useStreamSendCalls = 0
    harness.streamConversationCalls = 0
    harness.streamOrchestrateCalls = 0
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    useActivityStore.setState({ clearConv: realClearConv })
    useActivityStore.getState().clearConv(CONV_ID)
  })

  it("sends through the shared useStreamSend hook instead of an inline stream loop", () => {
    renderCodingHome()

    expect(harness.useStreamSendCalls).toBe(1)
    expect(harness.streamConversationCalls).toBe(0)
    expect(harness.streamOrchestrateCalls).toBe(0)

    const options = capturedOptions()
    expect(options.mode).toBe("normal")
    expect(options.deepThinking).toBe(false)
    expect(options.webSearch).toBe(true)
    expect(options.loopMode).toBe(false)
    expect(options.attachments).toEqual([])
    expect(options.currentConvRef).toBeDefined()
    expect(options.abortRef).toBeDefined()
    expect(options.onMessagesUpdate).toBeTypeOf("function")
    expect(options.onLoadMessages).toBeTypeOf("function")
    expect(options.onLoadConversations).toBeTypeOf("function")
  })

  it("keeps Activity events across turns because the send path never clears the conversation", () => {
    // 测试环境为 node：send 结束时会 dispatch 侧栏刷新事件，补一个最小 EventTarget 作为 window
    const fakeWindow = new EventTarget()
    vi.stubGlobal("window", fakeWindow)
    let sidebarRefreshes = 0
    fakeWindow.addEventListener("conversations-changed", () => { sidebarRefreshes += 1 })
    const clearCalls = watchClearConv()

    renderCodingHome()
    const options = capturedOptions()

    // 两轮发送：CodingHome 提供的全部生命周期回调都不得清空 Activity
    options.onSendStart?.()
    useActivityStore.getState().appendEvent(
      CONV_ID,
      envelope({ eventType: "task.started", taskId: "run-1", seq: 1 }),
    )
    options.onTokens?.({ prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 })
    options.onSendStart?.()
    useActivityStore.getState().appendEvent(
      CONV_ID,
      envelope({ eventType: "task.completed", taskId: "run-2", seq: 2, endReason: "stop" }),
    )
    options.onSendEnd?.(true)

    expect(clearCalls).toEqual([])
    expect(sidebarRefreshes).toBe(1)
    expect(useActivityStore.getState().getEvents(CONV_ID)).toHaveLength(2)
  })

  it("renders a stream failure through the shared ErrorState instead of the assistant transcript", () => {
    harness.failure = { message: "network error: fetch failed", retryable: true }

    const markup = renderCodingHome()

    expect(markup).toContain('data-slot="error-state"')
    expect(markup).toContain("network error: fetch failed")
    expect(markup).toContain("重试")
    expect(markup).not.toContain("❌ network error")
  })

  it("renders the shared page shell, header, panel and empty state contracts", () => {
    const markup = renderCodingHome()

    expect(markup).toContain('data-slot="page-shell"')
    expect(markup).toContain('data-slot="page-header"')
    expect(markup).toContain('data-slot="page-header-title"')
    expect(markup).toContain("Aether")
    expect(markup).toContain('data-slot="panel"')
    expect(markup).toContain('data-slot="empty-state"')
    expect(markup).toContain("What can I build for you?")
  })

  it("keeps the stream failure retry button enabled instead of a disabled placeholder", () => {
    harness.failure = { message: "network error: fetch failed", retryable: true }

    const action = renderCodingHome().match(/<div data-slot="error-state-action">([\s\S]*?)<\/div>/)?.[1] ?? ""

    expect(action).toContain("重试")
    expect(action).not.toContain("disabled")
  })
})

describe("AEX-P0-013：远程命令的系统失败态不得伪装成 AI 回答", () => {
  beforeEach(() => {
    harness.failure = null
    harness.useStreamSendCalls = 0
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("surfaces the 60s desktop timeout as a failure state, never as an assistant message", async () => {
    vi.useFakeTimers()
    const remote = mountRemoteCommandHost({})

    remote.dispatch({ content: "部署预发环境", id: "cmd-timeout" })
    await vi.advanceTimersByTimeAsync(REMOTE_COMMAND_TIMEOUT_MS + 1)

    // 唯一允许写入消息数组的通道是"用户指令"回显，且内容原样来自远程指令
    expect(remote.userCommands).toEqual(["部署预发环境"])
    expect(remote.failures).toHaveLength(1)
    const failure = remote.failures[0]
    expect(failure?.retryable).toBe(true)
    expect(failure?.message).toContain("桌面端")
    expect(failure?.message).toContain("超时")

    // 失败必须渲染为错误卡片，且页面不再出现旧的伪造文案
    harness.failure = failure ?? null
    const markup = renderCodingHome()
    expect(markup).toContain('data-slot="error-state"')
    expect(markup).toContain(failure?.message ?? "")
    expect(markup).not.toContain("⚠️ 等待桌面端响应超时")
    expect(markup).not.toContain("❌ 远程命令处理失败")
  })

  it("surfaces a failed command status as a failure state, never as an assistant message", async () => {
    vi.useFakeTimers()
    const failedStatus: RemoteCommandStatus = { command: { status: "failed", error: "AI Provider 未配置" } }
    const remote = mountRemoteCommandHost({ fetchCommandStatus: async () => failedStatus })

    remote.dispatch({ content: "跑一遍单测", id: "cmd-failed" })
    await vi.advanceTimersByTimeAsync(REMOTE_COMMAND_POLL_INTERVAL_MS + 10)

    expect(remote.userCommands).toEqual(["跑一遍单测"])
    expect(remote.failures).toHaveLength(1)
    const failure = remote.failures[0]
    expect(failure?.message).toContain("AI Provider 未配置")

    harness.failure = failure ?? null
    const markup = renderCodingHome()
    expect(markup).toContain('data-slot="error-state"')
    expect(markup).toContain(failure?.message ?? "")
    expect(markup).not.toContain("❌ 远程命令处理失败")
  })

  it("opens the remote conversation and drops the failure state without inventing a reply", async () => {
    vi.useFakeTimers()
    const remote = mountRemoteCommandHost({})

    remote.dispatch({ content: "打开会话", id: "cmd-open", conversationId: "conv-remote" })
    await vi.advanceTimersByTimeAsync(REMOTE_COMMAND_TIMEOUT_MS + 1)

    expect(remote.opened).toEqual(["conv-remote"])
    expect(remote.failures).toEqual([])
  })
})
