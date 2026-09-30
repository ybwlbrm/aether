import { useEffect } from 'react';
import { subscribeAppEvent, type RemoteCommandPayload } from '../lib/events';
import type { StreamFailure } from './useStreamSend';

// ============================================================
// AEX-P0-013：远程命令的系统失败语义
// ============================================================

/** 超过该年龄的指令视为过期，直接忽略（避免处理历史指令） */
export const REMOTE_COMMAND_MAX_AGE_MS = 60_000
/** 回执轮询间隔 */
export const REMOTE_COMMAND_POLL_INTERVAL_MS = 2_000
/** 兜底超时：桌面端未在窗口内给出回执 */
export const REMOTE_COMMAND_TIMEOUT_MS = 60_000
export const REMOTE_COMMAND_TIMEOUT_MESSAGE =
  '桌面端响应超时：60 秒内未收到桌面端 Aether 的回执。请确认桌面端 Aether 正在运行且已配置 AI Provider。'

export interface RemoteCommandStatus {
  readonly command?: {
    readonly conversationId?: string
    readonly status?: string
    readonly error?: string
  }
}

export interface RemoteCommandHostOptions {
  /** 乐观回显远程指令（用户消息）—— 唯一允许写入消息数组的通道 */
  readonly onUserCommand: (content: string) => void
  readonly onOpenConversation: (conversationId: string) => Promise<void>
  /** 系统传输失败 → 独立失败态（错误卡片），绝不伪装成 AI 回答 */
  readonly onFailure: (failure: StreamFailure) => void
  readonly fetchCommandStatus: (commandId: string) => Promise<RemoteCommandStatus>
}

export interface RemoteCommandHost {
  /** 处理 remote-command 事件（DOM 事件与已解包的 detail 都接受） */
  readonly handleEvent: (event: RemoteCommandInput) => Promise<void>
  /** 卸载清理：停止轮询/超时并忽略后续事件 */
  readonly dispose: () => void
}

/** 载荷的三种来源：DOM 事件 / 旧协议 { command } 包装 / 新协议扁平载荷 */
export type RemoteCommandInput = Event | RemoteCommandPayload | { readonly command?: RemoteCommandPayload }

/**
 * 防御性解析：Layout 发送 CustomEvent(detail=扁平载荷)，旧协议发送 CustomEvent(detail={command})，
 * 而已解包的调用方直接给载荷本身。三者归一为一份 RemoteCommandPayload（无内容时返回 undefined）。
 */
export function readRemoteCommand(input: RemoteCommandInput): RemoteCommandPayload | undefined {
  const detail: unknown = input instanceof CustomEvent
    ? input.detail
    : input
  const wrapped = (detail as { readonly command?: RemoteCommandPayload } | null | undefined)?.command
  const cmd = wrapped ?? (detail as RemoteCommandPayload | null | undefined)
  return cmd?.content ? cmd : undefined
}

/** 字段归一：Layout 发送 id，旧协议发送 commandId */
export function resolveCommandId(cmd: RemoteCommandPayload): string | undefined {
  return cmd.commandId ?? cmd.id
}

/** 过期判定：receivedAt 缺失时不作年龄判断（按新鲜处理） */
export function isStaleCommand(cmd: RemoteCommandPayload, now: number): boolean {
  return typeof cmd.receivedAt === 'number' && now - cmd.receivedAt > REMOTE_COMMAND_MAX_AGE_MS
}

/**
 * 远程命令宿主：把窗口事件收敛成 { 打开会话 | 轮询回执 | 系统失败态 } 三种结果。
 * 失败只有 onFailure 一个出口 —— 结构上不可能把传输失败写成 assistant 消息。
 *
 * 纯工厂：不依赖 React，行为完全由 options 决定。
 */
export function createRemoteCommandHost(options: RemoteCommandHostOptions): RemoteCommandHost {
  let disposed = false
  let pollTimer: ReturnType<typeof setInterval> | null = null
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null

  const clearTimers = (): void => {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
    if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null }
  }

  const openConversation = async (conversationId: string): Promise<void> => {
    if (disposed) return
    try { await options.onOpenConversation(conversationId) } catch { /* 对话可能尚未同步完成，等待下一次事件 */ }
  }

  const handleEvent = async (event: RemoteCommandInput): Promise<void> => {
    if (disposed) return
    const cmd = readRemoteCommand(event)
    if (!cmd) return
    // 新鲜度校验：过期命令直接忽略
    if (isStaleCommand(cmd, Date.now())) return
    const commandId = resolveCommandId(cmd)

    options.onUserCommand(cmd.content ?? '')
    // 新指令先清掉上一条命令残留的轮询/超时
    clearTimers()

    // 已有 conversationId 则直接打开
    if (cmd.conversationId) { await openConversation(cmd.conversationId); return }
    if (!commandId) return

    const pollCommandStatus = async (): Promise<void> => {
      if (disposed) return
      let status: RemoteCommandStatus
      try { status = await options.fetchCommandStatus(commandId) } catch { return } // 网络错误：下一轮重试
      if (disposed) return
      const command = status.command
      if (command?.conversationId) {
        clearTimers()
        await openConversation(command.conversationId)
        return
      }
      if (command?.status === 'failed') {
        clearTimers()
        options.onFailure({
          message: `桌面端处理远程指令失败：${command.error ?? '桌面端未提供错误信息'}`,
          retryable: true,
        })
      }
    }

    pollTimer = setInterval(() => { void pollCommandStatus() }, REMOTE_COMMAND_POLL_INTERVAL_MS)
    timeoutTimer = setTimeout(() => {
      if (disposed) return
      clearTimers()
      options.onFailure({ message: REMOTE_COMMAND_TIMEOUT_MESSAGE, retryable: true })
    }, REMOTE_COMMAND_TIMEOUT_MS)
  }

  return {
    handleEvent,
    dispose: () => { disposed = true; clearTimers() },
  }
}

/**
 * 轮询回执的真实取数。
 *
 * auth bypass（有意为之，勿"顺手修正"）：该端点由桌面端本机服务提供，调用方是同机浏览器，
 * 与站内其它 /api 调用不同 —— 这里只带 XHR 标记头，不附 Bearer Token。
 */
export async function fetchRemoteCommandStatus(commandId: string): Promise<RemoteCommandStatus> {
  const res = await fetch(`/api/sync/command-status?commandId=${encodeURIComponent(commandId)}`, {
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
  })
  if (!res.ok) throw new Error(`command-status ${res.status}`)
  return (await res.json()) as RemoteCommandStatus
}

export interface UseRemoteCommandHostOptions {
  readonly onUserCommand: (content: string) => void
  readonly onOpenConversation: (conversationId: string) => Promise<void>
  readonly onFailure: (failure: StreamFailure) => void
  /** 取数替身（测试注入；生产用裸 fetch） */
  readonly fetchCommandStatus?: (commandId: string) => Promise<RemoteCommandStatus>
}

/**
 * React 绑定：订阅 app 事件注册表里的 'remote-command'（事件名取自 lib/events，
 * 不在此处写字符串字面量），把 detail 交给纯工厂；卸载即 dispose 轮询与超时。
 */
export function useRemoteCommandHost(options: UseRemoteCommandHostOptions): void {
  const { onUserCommand, onOpenConversation, onFailure, fetchCommandStatus } = options
  useEffect(() => {
    const host = createRemoteCommandHost({
      onUserCommand,
      onOpenConversation,
      onFailure,
      fetchCommandStatus: fetchCommandStatus ?? fetchRemoteCommandStatus,
    })
    const unsubscribe = subscribeAppEvent('remote-command', (detail) => { void host.handleEvent(detail) })
    return () => { unsubscribe(); host.dispose() }
  }, [onUserCommand, onOpenConversation, onFailure, fetchCommandStatus])
}
