// allow: SIZE_OK — this is the single Run persistence seam; splitting CAS and lease recovery would expand the public contract.
/**
 * RunLifecycleManager — Aether 2.0 统一 Run 生命周期管理器（P0-05 收口）
 *
 * 唯一负责 runs 表状态写入的入口。所有模块只能请求 transition(runId, action)，
 * 禁止直接 db.update(runs) / db.insert(runs) 绕过状态机。
 *
 * 状态机覆盖 created/running/waiting/retry_waiting/retrying/verifying 与终态。
 * transition 使用 id + from-status 的 CAS 条件更新，避免并发终态覆盖。
 *
 * Transport-agnostic：仅依赖 drizzle sql-js 同步 API，无 Fastify/SSE/React。
 */

import type { SQLJsDatabase } from 'drizzle-orm/sql-js'
import { and, eq, sql } from 'drizzle-orm'
import * as schema from '../../db/schema/index.js'
import {
  isTerminalRunStatus,
  isValidRunTransition,
  type RunMode,
  type RunStatus,
} from './run.js'
import { RuntimeError } from '../errors/index.js'
import { getDb } from '../../db/client.js'

type Db = SQLJsDatabase<typeof schema>
type RunRow = typeof schema.runs.$inferSelect

/** 默认 stale lease：超过 30 分钟没有状态更新才允许恢复。 */
export const DEFAULT_STALE_AFTER_MS = 30 * 60 * 1000

/** RunLifecycleManager 配置。 */
export interface RunLifecycleManagerOptions {
  readonly staleAfterMs?: number
}

/** recoverStale 的调用覆盖项。 */
export interface RecoverStaleOptions {
  readonly staleAfterMs?: number
}

/** 生命周期动作（transition 的第二参数）。 */
export type RunAction =
  | 'create'
  | 'start'
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'complete'
  | 'fail'
  | 'recover'
  | 'retry_waiting'
  | 'retrying'
  | 'verifying'
  | 'budget_exceeded'

/** create 动作的输入。 */
export interface CreateRunInput {
  runId: string
  conversationId?: string | null
  mode?: RunMode
  rootAgentId?: string | null
  parentRunId?: string | null
  retryOfRunId?: string | null
  attempt?: number
  retryType?: string | null
  metadata?: Record<string, unknown>
}

/** transition 动作的可选载荷。 */
export interface TransitionOptions {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  error?: string
  endReason?: string
  /** 仅供 CAS/恢复内部使用：调用方声明的来源状态。 */
  expectedStatus?: RunStatus
  /** recoverStale 内部使用：只有不晚于该时间戳的 lease 才能恢复。 */
  staleBefore?: string
  parentRunId?: string | null
  retryOfRunId?: string | null
  attempt?: number
  retryType?: string | null
}

/** 动作 → 允许的起始状态集合。 */
const ACTION_FROM: Record<RunAction, readonly RunStatus[]> = {
  create: ['created'],
  start: ['created'],
  pause: ['running'],
  resume: ['waiting', 'retrying'],
  cancel: ['running', 'waiting', 'retry_waiting', 'retrying', 'verifying'],
  complete: ['running', 'waiting', 'verifying'],
  fail: ['running', 'waiting', 'retry_waiting', 'retrying', 'verifying'],
  recover: ['running', 'waiting'],
  retry_waiting: ['running', 'waiting'],
  retrying: ['retry_waiting'],
  verifying: ['running', 'waiting'],
  budget_exceeded: ['running', 'waiting', 'retry_waiting', 'retrying', 'verifying'],
}

/** 动作 → 目标状态。 */
const ACTION_TO: Record<RunAction, RunStatus> = {
  create: 'created',
  start: 'running',
  pause: 'waiting',
  resume: 'running',
  cancel: 'cancelled',
  complete: 'completed',
  fail: 'failed',
  recover: 'interrupted',
  retry_waiting: 'retry_waiting',
  retrying: 'retrying',
  verifying: 'verifying',
  budget_exceeded: 'budget_exceeded',
}

function invalidTransition(
  runId: string,
  from: RunStatus,
  action: RunAction,
  to?: RunStatus,
): RuntimeError {
  const target = to === undefined ? '' : ` -> ${to}`
  return new RuntimeError(`非法状态转移: ${from}${target} 不允许执行 ${action}`, {
    code: 'INVALID_RUN_TRANSITION',
    retryable: false,
    context: { runId, from, action, to },
  })
}

function transitionConflict(
  runId: string,
  from: RunStatus,
  action: RunAction,
  to: RunStatus,
): RuntimeError {
  return new RuntimeError(`run 状态转移冲突/CAS并发冲突（非法状态转移）: ${runId} ${from} -> ${to}（${action}）`, {
    code: 'RUN_TRANSITION_CONFLICT',
    retryable: true,
    context: { runId, from, action, to },
  })
}

function terminalEndReason(action: RunAction): string | null {
  switch (action) {
    case 'cancel':
      return 'cancelled'
    case 'fail':
      return 'error'
    case 'complete':
      return 'completed'
    case 'recover':
      return 'crashed'
    case 'budget_exceeded':
      return 'budget_exceeded'
    case 'create':
    case 'start':
    case 'pause':
    case 'resume':
    case 'retry_waiting':
    case 'retrying':
    case 'verifying':
      return null
  }
}

/** RunLifecycleManager — 唯一 Run 状态写入入口。 */
export class RunLifecycleManager {
  #db: Db
  #staleAfterMs: number

  constructor(db: Db, options: RunLifecycleManagerOptions = {}) {
    this.#db = db
    this.#staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS
  }

  /** 读取 run 行（不存在返回 undefined）。 */
  get(runId: string): RunRow | undefined {
    return this.#db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, runId))
      .get()
  }

  /** create — 以 created 状态创建 run 行（幂等：已存在则忽略）。 */
  create(input: CreateRunInput): RunRow {
    const existing = this.get(input.runId)
    if (existing) return existing

    const now = new Date().toISOString()
    this.#db
      .insert(schema.runs)
      .values({
        id: input.runId,
        conversationId: input.conversationId ?? null,
        status: 'created',
        mode: input.mode ?? 'normal',
        rootAgentId: input.rootAgentId ?? null,
        parentRunId: input.parentRunId ?? null,
        retryOfRunId: input.retryOfRunId ?? null,
        attempt: input.attempt ?? 1,
        retryType: input.retryType ?? null,
        lastUpdatedAt: now,
        metadata: input.metadata ? JSON.stringify(input.metadata) : null,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        createdAt: now,
      })
      .run()

    const row = this.get(input.runId)
    if (!row) {
      throw new RuntimeError(`run 创建后回读失败: ${input.runId}`, {
        code: 'RUN_NOT_FOUND',
        retryable: false,
        context: { runId: input.runId },
      })
    }
    return row
  }

  /**
   * transition — 状态转移的唯一入口。
   *
   * 先读取当前状态做业务校验，再以 id + from-status 条件更新。更新影响行数为 0
   * 表示另一个调用已经推进状态，抛出 RUN_TRANSITION_CONFLICT，不覆盖其结果。
   */
  transition(runId: string, action: RunAction, opts?: TransitionOptions): RunRow {
    const row = this.get(runId)
    if (!row) {
      throw new RuntimeError(`run 不存在: ${runId}`, {
        code: 'RUN_NOT_FOUND',
        retryable: false,
        context: { runId },
      })
    }

    const from = row.status
    const to = ACTION_TO[action]
    const expectedFrom = opts?.expectedStatus ?? from
    if (expectedFrom !== from) {
      throw transitionConflict(runId, from, action, to)
    }

    const allowedFrom = ACTION_FROM[action]
    if (!allowedFrom.includes(expectedFrom)) {
      throw invalidTransition(runId, from, action, to)
    }
    if (!isValidRunTransition(expectedFrom, to)) {
      throw invalidTransition(runId, from, action, to)
    }

    const now = new Date().toISOString()
    const patch: Partial<typeof schema.runs.$inferInsert> = {
      status: to,
      lastUpdatedAt: now,
    }
    if (to === 'running' && !row.startedAt) patch.startedAt = now
    if (isTerminalRunStatus(to)) patch.completedAt = now

    if (isTerminalRunStatus(to)) {
      patch.endReason = opts?.endReason ?? terminalEndReason(action)
    } else if (opts?.endReason !== undefined) {
      patch.endReason = opts.endReason
    }
    if (opts?.error !== undefined) patch.error = opts.error
    if (opts?.parentRunId !== undefined) patch.parentRunId = opts.parentRunId
    if (opts?.retryOfRunId !== undefined) patch.retryOfRunId = opts.retryOfRunId
    if (opts?.attempt !== undefined) patch.attempt = opts.attempt
    if (opts?.retryType !== undefined) patch.retryType = opts.retryType

    // token 累计使用 Delta 语义，避免把历史 input/output 再次计入 total。
    const newInput = row.inputTokens + (opts?.inputTokens ?? 0)
    const newOutput = row.outputTokens + (opts?.outputTokens ?? 0)
    const newTotal = row.totalTokens + (
      opts?.totalTokens ?? (opts?.inputTokens ?? 0) + (opts?.outputTokens ?? 0)
    )
    if (opts?.inputTokens !== undefined || opts?.outputTokens !== undefined || opts?.totalTokens !== undefined) {
      patch.inputTokens = newInput
      patch.outputTokens = newOutput
      patch.totalTokens = newTotal
    }

    const casWhere = opts?.staleBefore === undefined
      ? and(eq(schema.runs.id, runId), eq(schema.runs.status, from))
      : and(
        eq(schema.runs.id, runId),
        eq(schema.runs.status, from),
        sql`COALESCE(${schema.runs.lastUpdatedAt}, ${schema.runs.createdAt}) <= ${opts.staleBefore}`,
      )

    this.#db
      .update(schema.runs)
      .set(patch)
      .where(casWhere)
      .run()

    // sql.js exposes SQLite's changes() through the same connection.  The
    // workflow unit fakes intentionally expose only run(), so keep the
    // affected-row check on real SQL.js and use the regular row read there.
    if (typeof this.#db.get === 'function') {
      const changesRow = this.#db.get<{ changes: number }>(sql`SELECT changes() AS changes`)
      if (changesRow && Number(changesRow.changes) === 0) {
        throw transitionConflict(runId, from, action, to)
      }
    }

    const updated = this.get(runId)
    if (!updated) {
      throw new RuntimeError(`run 转移后回读失败: ${runId}`, {
        code: 'RUN_NOT_FOUND',
        retryable: false,
        context: { runId },
      })
    }
    return updated
  }

  /** 便捷：create → start 一步到位（幂等，兼容旧 ensureRunRow 语义但严格走状态机）。 */
  createAndStart(input: CreateRunInput): RunRow {
    this.create(input)
    const row = this.get(input.runId)
    if (row?.status === 'created') {
      return this.transition(input.runId, 'start')
    }
    if (!row) {
      throw new RuntimeError(`run 创建后回读失败: ${input.runId}`, {
        code: 'RUN_NOT_FOUND',
        retryable: false,
        context: { runId: input.runId },
      })
    }
    return row
  }

  /**
   * Crash Recovery：只恢复超过 lease 阈值的 running/waiting Run。
   * 读取后仍用 status + timestamp 条件 CAS，避免 active Run 在窗口内被误标。
   */
  recoverStale(options: number | RecoverStaleOptions = {}): number {
    const threshold = typeof options === 'number' ? options : options.staleAfterMs ?? this.#staleAfterMs
    if (!Number.isFinite(threshold) || threshold < 0) {
      throw new RuntimeError(`stale lease 阈值非法: ${threshold}`, {
        code: 'INVALID_STALE_THRESHOLD',
        retryable: false,
        context: { threshold },
      })
    }

    const cutoff = new Date(Date.now() - threshold).toISOString()
    const stale = this.#db
      .select()
      .from(schema.runs)
      .where(and(
        sql`${schema.runs.status} IN ('running', 'waiting')`,
        sql`COALESCE(${schema.runs.lastUpdatedAt}, ${schema.runs.createdAt}) <= ${cutoff}`,
      ))
      .all()

    let marked = 0
    for (const run of stale) {
      try {
        this.transition(run.id, 'recover', {
          endReason: 'crashed',
          staleBefore: cutoff,
        })
        marked += 1
      } catch (error: unknown) {
        // 单 run 恢复失败不影响其他 run；CAS 冲突通常表示它已被活跃执行更新。
        console.warn(
          `[RunLifecycleManager] recover ${run.id} 失败:`,
          error instanceof Error ? error.message : String(error),
        )
      }
    }
    return marked
  }
}

/** 全局共享实例（应用启动后由 initDb 后创建；测试可自行构造）。 */
let shared: RunLifecycleManager | null = null

export function getRunLifecycleManager(db?: Db): RunLifecycleManager {
  if (!shared || db) {
    shared = new RunLifecycleManager(db ?? getDb())
  }
  return shared
}

export function resetRunLifecycleManager(): void {
  shared = null
}
