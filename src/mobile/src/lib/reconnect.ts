/**
 * 重连状态重建协调器（AEX-P1-077）
 *
 * 断线期间 Realtime 事件会丢失，且消息本身无法重建执行状态。
 * 重连后必须按「终态优先 + 增量游标」重建，而不是只 reload messages：
 *
 *   1. 命令终态优先：先向服务端重新查询每条在途命令的 canonical 终态并结算
 *      （Realtime 只是通知，不是日志；终态必须重新向 canonical 源取）
 *   2. 消息增量合并：再按游标（created_at）拉取断线期间的新消息 merge 进本地
 *   3. 顺序不可颠倒：终态结算先于消息合并，否则迟到的消息会把已结算的 phase 拉回 busy
 *
 * 本模块不直接依赖 Supabase：所有 IO 经构造参数注入，便于单测与复用。
 * 注册方（MessageView）自己持有游标，本模块只负责「何时、按什么顺序、恢复谁」。
 */

import type { RemoteCommandSnapshot } from './remote-command';
import type { OverallStatus } from './channel-registry';

export interface ReconnectCommandReference {
  readonly serverId: string | null
  readonly clientCommandId: string | null
}

/** 命令终态拉取器：返回 canonical 终态；命令不存在/尚未落库返回 null */
export type FetchTerminalState = (
  reference: ReconnectCommandReference,
) => Promise<RemoteCommandSnapshot | null>

/** 会话消息增量合并器：由注册方自行使用游标拉取并 merge */
export type ConversationRecovery = () => Promise<void>

export interface ReconnectRebuildReport {
  readonly commandsSettled: number
  readonly conversationsMerged: number
  readonly errors: number
}

export interface ReconnectRebuilderDeps {
  readonly fetchTerminal: FetchTerminalState
}

interface CommandRegistration {
  readonly key: string
  readonly reference: ReconnectCommandReference
  readonly settle: (snapshot: RemoteCommandSnapshot) => void
  refCount: number
}

function commandKeyOf(reference: ReconnectCommandReference): string | null {
  return reference.serverId ?? reference.clientCommandId
}

const EMPTY_REPORT: ReconnectRebuildReport = { commandsSettled: 0, conversationsMerged: 0, errors: 0 }

export class ReconnectStateRebuilder {
  private readonly fetchTerminal: FetchTerminalState
  private readonly commands = new Map<string, CommandRegistration>()
  private readonly conversations = new Map<string, ConversationRecovery>()
  private lastStatus: OverallStatus | null = null
  private inFlight: Promise<ReconnectRebuildReport> | null = null
  private lastRun: Promise<ReconnectRebuildReport> | null = null

  constructor(deps: ReconnectRebuilderDeps) {
    this.fetchTerminal = deps.fetchTerminal
  }

  /**
   * 注册一条在途命令的终态结算。
   * 同一引用重复注册（组件重渲染 / 双处订阅）按引用计数合并，只查询一次。
   */
  registerCommand(
    reference: ReconnectCommandReference,
    settle: (snapshot: RemoteCommandSnapshot) => void,
  ): () => void {
    const key = commandKeyOf(reference)
    if (!key) return () => {}
    const existing = this.commands.get(key)
    if (existing) {
      existing.refCount++
      return () => this.releaseCommand(key)
    }
    this.commands.set(key, { key, reference, settle, refCount: 1 })
    return () => this.releaseCommand(key)
  }

  /** 注册一个会话的消息增量恢复器（同一会话重复注册以最后一次为准） */
  registerConversation(conversationId: string, recover: ConversationRecovery): () => void {
    this.conversations.set(conversationId, recover)
    return () => {
      if (this.conversations.get(conversationId) === recover) this.conversations.delete(conversationId)
    }
  }

  /**
   * 同步状态桥：只有「非 connected → connected」才触发一轮重建。
   * 稳定在线期间重复的 connected/degraded 不重复触发，避免重复 IO 与重复订阅。
   */
  noteSyncStatus(status: OverallStatus): void {
    const recovered = status === 'connected' && this.lastStatus !== 'connected'
    this.lastStatus = status
    if (recovered) void this.rebuild()
  }

  /** 手动触发一轮重建（并发调用合并为同一轮） */
  rebuild(): Promise<ReconnectRebuildReport> {
    if (this.inFlight) return this.inFlight
    const run = this.runRebuild().finally(() => { this.inFlight = null })
    this.inFlight = run
    this.lastRun = run
    return run
  }

  /** 等待最近一轮重建结束（测试与显式恢复用） */
  whenIdle(): Promise<ReconnectRebuildReport> {
    return this.inFlight ?? this.lastRun ?? Promise.resolve(EMPTY_REPORT)
  }

  /** 登出清理 */
  reset(): void {
    this.commands.clear()
    this.conversations.clear()
    this.lastStatus = null
    this.inFlight = null
    this.lastRun = null
  }

  private releaseCommand(key: string): void {
    const current = this.commands.get(key)
    if (!current) return
    current.refCount--
    if (current.refCount <= 0) this.commands.delete(key)
  }

  private async runRebuild(): Promise<ReconnectRebuildReport> {
    const report = { ...EMPTY_REPORT }
    // 1) 命令终态优先：执行状态只能由 canonical 终态重建
    for (const registration of [...this.commands.values()]) {
      try {
        const snapshot = await this.fetchTerminal(registration.reference)
        if (!snapshot) continue
        registration.settle(snapshot)
        report.commandsSettled++
      } catch {
        report.errors++
      }
    }
    // 2) 消息增量合并（终态结算之后）
    for (const recover of [...this.conversations.values()]) {
      try {
        await recover()
        report.conversationsMerged++
      } catch {
        report.errors++
      }
    }
    return report
  }
}
