import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

import {
  createRemoteCommandHost,
  isStaleCommand,
  readRemoteCommand,
  REMOTE_COMMAND_MAX_AGE_MS,
  REMOTE_COMMAND_POLL_INTERVAL_MS,
  REMOTE_COMMAND_TIMEOUT_MESSAGE,
  REMOTE_COMMAND_TIMEOUT_MS,
  resolveCommandId,
  type RemoteCommandHostOptions,
  type RemoteCommandStatus,
} from "./useRemoteCommandHost"
import type { StreamFailure } from "./useStreamSend"

const CONV = "conv-remote"

interface Harness {
  readonly dispatch: (detail: unknown) => void
  readonly failures: StreamFailure[]
  readonly userCommands: string[]
  readonly opened: string[]
  readonly polls: string[]
  readonly dispose: () => void
}

/** 用 EventTarget 驱动远程命令宿主（等价于页面 effect 订阅 app 事件） */
function mountHost(overrides: Partial<RemoteCommandHostOptions> = {}): Harness {
  const failures: StreamFailure[] = []
  const userCommands: string[] = []
  const opened: string[] = []
  const polls: string[] = []
  const target = new EventTarget()
  const host = createRemoteCommandHost({
    onUserCommand: (content) => { userCommands.push(content) },
    onOpenConversation: async (conversationId) => { opened.push(conversationId) },
    onFailure: (failure) => { failures.push(failure) },
    fetchCommandStatus: async (commandId) => { polls.push(commandId); return { command: { status: "pending" } } },
    ...overrides,
  })
  target.addEventListener("remote-command", (e) => { void host.handleEvent(e) })
  return {
    dispatch: (detail) => { target.dispatchEvent(new CustomEvent("remote-command", { detail })) },
    failures,
    userCommands,
    opened,
    polls,
    dispose: host.dispose,
  }
}

describe("useRemoteCommandHost 的载荷解析", () => {
  it("接受 CustomEvent、扁平载荷与旧协议 { command } 包装三种形状", () => {
    const payload = { content: "部署预发", id: "cmd-1" }

    expect(readRemoteCommand(new CustomEvent("remote-command", { detail: payload }))).toEqual(payload)
    expect(readRemoteCommand(payload)).toEqual(payload)
    expect(readRemoteCommand({ command: payload })).toEqual(payload)
  })

  it("没有 content 的载荷一律视为无效（不产生任何副作用）", () => {
    expect(readRemoteCommand({ id: "cmd-1" })).toBeUndefined()
    expect(readRemoteCommand(new CustomEvent("remote-command"))).toBeUndefined()
  })

  it("commandId 优先，缺失时回退到 id", () => {
    expect(resolveCommandId({ content: "x", commandId: "c-1", id: "i-1" })).toBe("c-1")
    expect(resolveCommandId({ content: "x", id: "i-1" })).toBe("i-1")
    expect(resolveCommandId({ content: "x" })).toBeUndefined()
  })

  it("receivedAt 超过 60s 判定为陈旧；缺失 receivedAt 不算陈旧", () => {
    const now = 1_000_000
    expect(isStaleCommand({ content: "x", receivedAt: now - REMOTE_COMMAND_MAX_AGE_MS - 1 }, now)).toBe(true)
    expect(isStaleCommand({ content: "x", receivedAt: now }, now)).toBe(false)
    expect(isStaleCommand({ content: "x" }, now)).toBe(false)
  })
})

describe("useRemoteCommandHost 的回执轮询", () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it("轮询到 conversationId 时打开会话并清掉超时（不产生失败态）", async () => {
    // Given
    const done: RemoteCommandStatus = { command: { conversationId: CONV } }
    const remote = mountHost({ fetchCommandStatus: async () => done })

    // When
    remote.dispatch({ content: "打开会话", id: "cmd-open" })
    await vi.advanceTimersByTimeAsync(REMOTE_COMMAND_POLL_INTERVAL_MS + 10)

    // Then
    expect(remote.opened).toEqual([CONV])
    await vi.advanceTimersByTimeAsync(REMOTE_COMMAND_TIMEOUT_MS + 1)
    expect(remote.failures).toEqual([])
  })

  it("轮询按 commandId ?? id 取数：旧协议只给 commandId 也能查到回执", async () => {
    // Given
    const requested: string[] = []
    const remote = mountHost({
      fetchCommandStatus: async (commandId) => {
        requested.push(commandId)
        return { command: { conversationId: CONV } }
      },
    })

    // When
    remote.dispatch({ content: "旧协议", commandId: "legacy-1" })
    await vi.advanceTimersByTimeAsync(REMOTE_COMMAND_POLL_INTERVAL_MS + 10)

    // Then
    expect(requested).toEqual(["legacy-1"])
    expect(remote.opened).toEqual([CONV])
  })

  it("轮询失败状态时以系统失败态收敛，附带桌面端错误信息", async () => {
    // Given
    const failed: RemoteCommandStatus = { command: { status: "failed", error: "AI Provider 未配置" } }
    const remote = mountHost({ fetchCommandStatus: async () => failed })

    // When
    remote.dispatch({ content: "跑一遍单测", id: "cmd-failed" })
    await vi.advanceTimersByTimeAsync(REMOTE_COMMAND_POLL_INTERVAL_MS + 10)

    // Then
    expect(remote.failures).toHaveLength(1)
    expect(remote.failures[0]?.message).toContain("AI Provider 未配置")
    expect(remote.failures[0]?.retryable).toBe(true)
  })

  it("轮询取数抛错时静默重试，不产生失败态", async () => {
    // Given
    let attempts = 0
    const remote = mountHost({
      fetchCommandStatus: async () => {
        attempts += 1
        if (attempts === 1) throw new Error("network down")
        return { command: { conversationId: CONV } }
      },
    })

    // When
    remote.dispatch({ content: "网络抖动", id: "cmd-retry" })
    await vi.advanceTimersByTimeAsync(REMOTE_COMMAND_POLL_INTERVAL_MS * 2 + 10)

    // Then
    expect(attempts).toBe(2)
    expect(remote.failures).toEqual([])
    expect(remote.opened).toEqual([CONV])
  })
})

describe("useRemoteCommandHost 的陈旧判定与超时兜底", () => {
  beforeEach(() => { vi.useFakeTimers() })
  afterEach(() => { vi.useRealTimers() })

  it("receivedAt 超过 60s 的指令被忽略：既不回显也不轮询", async () => {
    // Given
    const remote = mountHost()

    // When: 61 秒前收到的指令（重放历史事件）
    remote.dispatch({ content: "历史指令", id: "cmd-stale", receivedAt: Date.now() - REMOTE_COMMAND_MAX_AGE_MS - 1_000 })
    await vi.advanceTimersByTimeAsync(REMOTE_COMMAND_TIMEOUT_MS + 1)

    // Then
    expect(remote.userCommands).toEqual([])
    expect(remote.polls).toEqual([])
    expect(remote.failures).toEqual([])
  })

  it("60s 内没有回执时以精确的超时文案进入失败态", async () => {
    // Given: 回执永远 pending
    const remote = mountHost()

    // When
    remote.dispatch({ content: "部署预发环境", id: "cmd-timeout" })
    await vi.advanceTimersByTimeAsync(REMOTE_COMMAND_TIMEOUT_MS + 1)

    // Then: 唯一允许写入消息数组的通道是用户指令回显；失败只经 onFailure
    expect(remote.userCommands).toEqual(["部署预发环境"])
    expect(remote.failures).toEqual([{ message: REMOTE_COMMAND_TIMEOUT_MESSAGE, retryable: true }])
  })

  it("dispose() 同时清掉轮询 interval 与超时 timeout", async () => {
    // Given
    const remote = mountHost()
    remote.dispatch({ content: "会被卸载打断", id: "cmd-dispose" })
    const pollsBefore = remote.polls.length

    // When: 卸载发生在两个计时器都还活着的时候
    remote.dispose()
    await vi.advanceTimersByTimeAsync(REMOTE_COMMAND_TIMEOUT_MS + 1)

    // Then: 轮询不再发生，超时也不再触发
    expect(remote.polls).toHaveLength(pollsBefore)
    expect(remote.failures).toEqual([])
  })

  it("dispose() 之后到达的事件被完全忽略", async () => {
    // Given
    const remote = mountHost()
    remote.dispose()

    // When
    remote.dispatch({ content: "卸载后到达", id: "cmd-late" })
    await vi.advanceTimersByTimeAsync(REMOTE_COMMAND_TIMEOUT_MS + 1)

    // Then
    expect(remote.userCommands).toEqual([])
    expect(remote.failures).toEqual([])
  })

  it("新指令到达时清掉上一条命令残留的轮询与超时", async () => {
    // Given: 第一条指令开始轮询
    const remote = mountHost()
    remote.dispatch({ content: "第一条", id: "cmd-1" })
    await vi.advanceTimersByTimeAsync(REMOTE_COMMAND_POLL_INTERVAL_MS + 10)
    expect(remote.polls.length).toBeGreaterThan(0)
    const pollsAfterFirst = remote.polls.length

    // When: 第二条指令替换它
    remote.dispatch({ content: "第二条", id: "cmd-2" })
    await vi.advanceTimersByTimeAsync(REMOTE_COMMAND_POLL_INTERVAL_MS + 10)

    // Then: 旧指令的超时已被撤销（不产生失败态），轮询只服务新指令
    expect(remote.polls).toHaveLength(pollsAfterFirst + 1)
    expect(remote.failures).toEqual([])
    expect(remote.userCommands).toEqual(["第一条", "第二条"])
  })
})
