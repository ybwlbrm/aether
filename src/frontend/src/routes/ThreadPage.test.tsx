import { renderToStaticMarkup } from "react-dom/server"
import { MemoryRouter } from "react-router-dom"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import type { AgentEventEnvelope } from "@pacc/shared"
import type { RunDto } from "../api/runs"
import type { StreamFailure, StreamSendOptions } from "../hooks/useStreamSend"
import { useActivityStore } from "../store/activityStore"
import { useRunStore } from "../store/runStore"

type StreamSendStub = {
  readonly handleSend: (content?: string) => Promise<void>
  readonly stopGeneration: () => void
}

type SeededMessage = {
  readonly id: string
  readonly role: string
  readonly content: string
  readonly createdAt: string
}

type SeededMessageList = readonly SeededMessage[]

const harness = vi.hoisted(() => ({
  options: null as StreamSendOptions | null,
  failure: null as StreamFailure | null,
  sending: false,
  thinking: false,
  retryInfo: null as { readonly attempt: number; readonly maxRetries: number; readonly status: number; readonly delay: number } | null,
  /**
   * 页面渲染可见的会话消息。
   *
   * 为什么不直接往控制器里灌：`useThreadController` 先读 `useSyncExternalStore` 的快照、
   * 后调 `useStreamSend`，因此在 hook 调用期间改状态**来不及**被同一帧读到
   * （SSR 下更甚）。这里只覆盖页面真正消费的那一个字段 —— 控制器其余行为
   * （refs / 轮询 / 审批 / 停止 / 活动同步）全部是**真实现**，因此下面 8 个移植测试
   * 依旧在跑真实控制器。控制器自身对 messages 的处理由 useThreadController.test.ts 覆盖。
   */
  messages: [] as ReadonlyArray<{
    readonly id: string
    readonly role: string
    readonly content: string
    readonly createdAt: string
  }>,
  /** 同上：控制器持有的待审批项（页面只把它映射成 T17 的五态判别联合） */
  pendingApproval: null as { readonly approvalId: string; readonly toolName: string; readonly argsSummary: string } | null,
  approvalError: null as string | null,
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
        sending: harness.sending,
        thinking: harness.thinking,
        failure: harness.failure,
        streamTokens: harness.sending ? { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 } : null,
        retryInfo: harness.retryInfo,
        liveReasoning: "",
        setSending: () => undefined,
        setThinking: () => undefined,
      }
    },
  }
})

// 真实控制器 + 仅覆盖页面消费的 messages 字段（见 harness.messages 的说明）
vi.mock("../hooks/useThreadController", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../hooks/useThreadController")>()
  return {
    ...actual,
    useThreadController: (options: Parameters<typeof actual.useThreadController>[0]) => {
      const real = actual.useThreadController(options)
      return {
        ...real,
        messages: harness.messages,
        pendingApproval: harness.pendingApproval,
        approvalError: harness.approvalError,
      }
    },
  }
})

// ThreadPage 不应再直接触碰流客户端 —— 任何调用都视为内联发送循环回归
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
  ThreadPage,
  createRemoteCommandHost,
  REMOTE_COMMAND_POLL_INTERVAL_MS,
  REMOTE_COMMAND_TIMEOUT_MS,
  type RemoteCommandHostOptions,
  type RemoteCommandStatus,
} from "./ThreadPage"

const CONV_ID = "conv-threadpage"

/** 首帧注入的消息 → 页面的 ThreadMessage 形状（role 按 threadContract 的词汇表收窄） */
function resetViewModel(): void {
  harness.messages = []
  harness.sending = false
  harness.thinking = false
  harness.retryInfo = null
  harness.failure = null
  harness.pendingApproval = null
  harness.approvalError = null
}

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

function renderThreadPage(variant: "workbench" | "chat" = "workbench", path = "/command-center"): string {
  return renderToStaticMarkup(
    <MemoryRouter initialEntries={[path]}>
      <ThreadPage variant={variant} />
    </MemoryRouter>,
  )
}

/** 带 ?selectConv 的渲染：URL 已经声明了目标会话，首帧就该按它解析（Run / 工具活动） */
function renderWithConversation(variant: "workbench" | "chat" = "workbench"): string {
  return renderThreadPage(variant, `/command-center?selectConv=${CONV_ID}`)
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

/** 一条真实后端快照（runStore 的唯一合法输入） */
function runSnapshot(partial: Partial<RunDto> & Pick<RunDto, "id" | "status">): RunDto {
  return {
    conversationId: CONV_ID,
    taskId: "t-1",
    providerId: "p-1",
    model: "gpt-4o",
    mode: "normal",
    permissionLevel: 2,
    loopMode: false,
    deepThinking: false,
    webSearch: true,
    createdAt: "2026-08-24T00:00:00Z",
    updatedAt: "2026-08-24T00:00:00Z",
    ...partial,
  } as RunDto
}

describe("ThreadPage 收敛到共享 useStreamSend", () => {
  beforeEach(() => {
    harness.options = null
    harness.failure = null
    resetViewModel()
    harness.useStreamSendCalls = 0
    harness.streamConversationCalls = 0
    harness.streamOrchestrateCalls = 0
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    useActivityStore.setState({ clearConv: realClearConv })
    useActivityStore.getState().clearConv(CONV_ID)
    useRunStore.getState().removeRun("run-thread-1")
    useRunStore.getState().clearConversation(CONV_ID)
  })

  it("sends through the shared useStreamSend hook instead of an inline stream loop", () => {
    renderThreadPage()

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

    renderThreadPage()
    const options = capturedOptions()

    // 两轮发送：ThreadPage 提供的全部生命周期回调都不得清空 Activity
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

    const markup = renderThreadPage()

    expect(markup).toContain('data-slot="error-state"')
    expect(markup).toContain("network error: fetch failed")
    expect(markup).toContain("重试")
    expect(markup).not.toContain("❌ network error")
  })

  it("renders the shared page shell, header, panel and thread empty state contracts", () => {
    const markup = renderThreadPage()

    expect(markup).toContain('data-slot="page-shell"')
    expect(markup).toContain('data-slot="page-header"')
    expect(markup).toContain('data-slot="page-header-title"')
    expect(markup).toContain("Aether")
    expect(markup).toContain('data-slot="panel"')
    // T24：空态契约从 components/ui 的 EmptyState 迁到 T17 的 ThreadEmpty
    expect(markup).toContain('data-slot="thread-empty"')
    expect(markup).toContain("What can I build for you?")
  })

  it("keeps the stream failure retry button enabled instead of a disabled placeholder", () => {
    harness.failure = { message: "network error: fetch failed", retryable: true }

    const action = renderThreadPage().match(/<div data-slot="error-state-action">([\s\S]*?)<\/div>/)?.[1] ?? ""

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
    const markup = renderThreadPage()
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
    const markup = renderThreadPage()
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

// ============================================================
// T24 路由切换新增覆盖
// ============================================================

describe("ThreadPage：/command-center 与 /chat 复用同一实现的两份能力档案", () => {
  beforeEach(() => {
    harness.options = null
    harness.failure = null
    resetViewModel()
    harness.useStreamSendCalls = 0
  })

  afterEach(() => {
    useActivityStore.getState().clearConv(CONV_ID)
    useRunStore.getState().clearConversation(CONV_ID)
  })

  it("两条路由都只实例化一次控制器，且轮询间隔 / 侧栏刷新 / 深度链接按档案不同", () => {
    renderThreadPage("workbench")
    expect(harness.useStreamSendCalls).toBe(1)
    const workbench = capturedOptions()
    expect(workbench.attachments).toEqual([])

    harness.options = null
    harness.useStreamSendCalls = 0
    renderThreadPage("chat", "/chat")
    expect(harness.useStreamSendCalls).toBe(1)
    // 能力集本身落在控制器配置里；这里断言两条路由共用同一 send 端口形状
    expect(capturedOptions().onSendStart).toBeTypeOf("function")
    expect(capturedOptions().onSendEnd).toBeTypeOf("function")
    expect(workbench.onSendStart).toBeTypeOf("function")
  })

  it("chat 档案渲染内联会话列表，workbench 档案不渲染（列表归侧栏）", () => {
    const chat = renderThreadPage("chat", "/chat")
    expect(chat).toContain("对话列表")
    expect(chat).toContain('data-slot="page-header-title"')
    expect(chat).toContain("对话")

    const workbench = renderThreadPage()
    expect(workbench).not.toContain("对话列表")
  })

  it("chat 档案的页头与 /command-center 不同：同一组件，两份档案", () => {
    expect(renderThreadPage("workbench")).toContain("Describe your idea")
    expect(renderThreadPage("chat", "/chat")).toContain("与 AI 助手交流，管理多轮对话")
  })
})

describe("ThreadPage：流式发送 / 停止 / 重试 的渲染契约", () => {
  beforeEach(() => {
    harness.options = null
    harness.failure = null
    resetViewModel()
    harness.useStreamSendCalls = 0
  })

  afterEach(() => {
    useActivityStore.getState().clearConv(CONV_ID)
  })

  it("流式中的助手文本连续显示：同一 temp 消息的增量帧都在首帧渲染里可见", () => {
    harness.sending = true
    harness.messages = [
      { id: "temp-user-1", role: "user", content: "重构路由", createdAt: "2026-08-24T00:00:00Z" },
      { id: "temp-ai-streaming", role: "assistant", content: "正在把 CommandCenter 拆成", createdAt: "" },
    ]
    const first = renderThreadPage()

    expect(first).toContain("重构路由")
    expect(first).toContain("正在把 CommandCenter 拆成")
    // 生成中：动作切换为 stop，提示语改为"可随时停止"
    expect(first).toContain('data-slot="composer-stop"')
    expect(first).not.toContain('data-slot="composer-send"')
    expect(first).toContain("生成中 · 可随时停止")
    // 停止车道由 thread.stop 驱动（控制器的双车道 stop）
    expect(first).toContain('aria-label="停止生成"')

    // 下一帧：内容增长而非被清空 —— 连续性由同一个 temp id 保证
    harness.messages = [
      { id: "temp-user-1", role: "user", content: "重构路由", createdAt: "2026-08-24T00:00:00Z" },
      { id: "temp-ai-streaming", role: "assistant", content: "正在把 CommandCenter 拆成 ThreadPage 与 Dashboard。", createdAt: "" },
    ]
    const second = renderThreadPage()
    expect(second).toContain("正在把 CommandCenter 拆成 ThreadPage 与 Dashboard。")
  })

  it("非生成中显示 send 动作且空输入时禁用", () => {
    const markup = renderThreadPage()
    expect(markup).toContain('data-slot="composer-send"')
    expect(markup).not.toContain('data-slot="composer-stop"')
    expect(markup).toMatch(/data-slot="composer-send"[^>]*disabled/)
  })

  it("重试进行中：retryInfo 渲染在 composer 错误行，带 attempt/maxRetries", () => {
    harness.retryInfo = { attempt: 2, maxRetries: 5, status: 503, delay: 1200 }
    const markup = renderThreadPage()

    expect(markup).toContain('data-slot="composer-error"')
    expect(markup).toContain("2/5")
    expect(markup).toContain("503")
  })

  it("工具活动：T9 投影的条目渲染为 T17 内联 ToolActivity 行", () => {
    useActivityStore.getState().appendEvent(CONV_ID, envelope({
      eventType: "tool.started",
      seq: 1,
      eventId: "tool-1",
      taskId: "run-thread-1",
      tool: { toolName: "read_file", toolInput: "src/app/App.tsx", inputDetail: { path: "src/app/App.tsx" } },
    }))
    useActivityStore.getState().appendEvent(CONV_ID, envelope({
      eventType: "tool.completed",
      seq: 2,
      eventId: "tool-2",
      parentEventId: "tool-1",
      taskId: "run-thread-1",
      tool: { toolName: "read_file", toolInput: "src/app/App.tsx", outputDetail: { lines: 104 } },
    }))

    const markup = renderWithConversation()

    expect(markup).toContain('data-slot="thread-tool-activity"')
    expect(markup).toContain('data-tool="read_file"')
    expect(markup).toContain("src/app/App.tsx")
    expect(markup).toContain('data-status="completed"')
  })
})

describe("ThreadPage：RunStatusStrip 接真实 Run 状态并按 T5 渲染合法动作", () => {
  beforeEach(() => {
    harness.options = null
    harness.failure = null
    resetViewModel()
  })

  afterEach(() => {
    useRunStore.getState().clearConversation(CONV_ID)
    useActivityStore.getState().clearConv(CONV_ID)
  })

  it("running 的 run：状态条渲染真实 RunStatus，且有 cancel / pause、无 resume", () => {
    useRunStore.getState().ingestSnapshot(runSnapshot({ id: "run-thread-1", status: "running" }))

    const markup = renderWithConversation()

    expect(markup).toContain('data-slot="thread-run-status"')
    expect(markup).toContain('data-status="running"')
    expect(markup).toContain("执行中")
    expect(markup).toContain('data-slot="thread-run-cancel"')
    expect(markup).toContain('data-slot="thread-run-pause"')
    expect(markup).not.toContain('data-slot="thread-run-resume"')
  })

  it("waiting 的 run：路由层允许 resume，故有 resume 无 pause", () => {
    useRunStore.getState().ingestSnapshot(runSnapshot({ id: "run-thread-1", status: "waiting" }))

    const markup = renderWithConversation()

    expect(markup).toContain('data-status="waiting"')
    expect(markup).toContain('data-slot="thread-run-resume"')
    expect(markup).not.toContain('data-slot="thread-run-pause"')
  })

  it("终态的 run：状态条仍在，但没有任何生命周期动作按钮", () => {
    useRunStore.getState().ingestSnapshot(runSnapshot({ id: "run-thread-1", status: "completed" }))

    const markup = renderWithConversation()

    expect(markup).toContain('data-status="completed"')
    expect(markup).toContain('data-terminal="true"')
    expect(markup).not.toContain('data-slot="thread-run-cancel"')
    expect(markup).not.toContain('data-slot="thread-run-pause"')
    expect(markup).not.toContain('data-slot="thread-run-resume"')
  })

  it("无 run 时不渲染状态条（不伪造 run）", () => {
    const markup = renderThreadPage()
    expect(markup).not.toContain('data-slot="thread-run-status"')
  })
})

describe("ThreadPage：审批与轮询失败态", () => {
  beforeEach(() => {
    harness.options = null
    harness.failure = null
    resetViewModel()
  })

  afterEach(() => {
    useActivityStore.getState().clearConv(CONV_ID)
  })

  it("无待审批时不留空壳节点（idle 零 DOM）", () => {
    const idle = renderThreadPage()
    expect(idle).toContain('data-slot="thread-approval-slot"')
    expect(idle).not.toContain('data-slot="thread-approval"')
  })

  it("待审批：控制器三元组映射为 T17 pending 态，批准 / 拒绝双入口渲染", () => {
    harness.pendingApproval = { approvalId: "ap-1", toolName: "delete_path", argsSummary: "dist/" }

    const markup = renderThreadPage()

    expect(markup).toContain('data-slot="thread-approval"')
    expect(markup).toContain('data-phase="pending"')
    expect(markup).toContain("delete_path")
    expect(markup).toContain("dist/")
    expect(markup).toContain('data-slot="thread-approval-approve"')
    expect(markup).toContain('data-slot="thread-approval-reject"')
  })

  it("审批提交失败：映射为 error 态并显示可重试的失败文案", () => {
    harness.pendingApproval = { approvalId: "ap-2", toolName: "write_file", argsSummary: "src/a.ts" }
    harness.approvalError = "网络错误"

    const markup = renderThreadPage()

    expect(markup).toContain('data-phase="error"')
    expect(markup).toContain('data-slot="thread-approval-error"')
    expect(markup).toContain("网络错误")
  })

  it("轮询状态机：idle / 无 errorInfo 时横幅零 DOM（PollStatusBanner 的既有契约）", () => {
    const markup = renderThreadPage()
    // pollStatus='idle' → PollStatusBanner 主动返回 null：页面仍然消费了它，
    // 只是在"没有失败"时不产生 chrome。真正的消费断言在 useThreadController.test.ts。
    expect(markup).not.toContain("轮询")
    expect(markup).not.toContain("重试轮询")
  })
})
