/**
 * T6 数据修复步骤集合 —— `POST /api/selfcheck/repair` 的执行单元。
 *
 * 约束（不可违背）：
 * 1. 纯函数式、不依赖 Fastify：每步只接收 RepairContext（config + 可注入 now），
 *    因此可被 HTTP 路由 / CLI / Electron 主进程直接调用并被单测直接断言。
 * 2. 单步失败不阻断整批：每步 body 由 finish()/finishAsync() 包 try/catch，
 *    抛错（含 await 内的 rejection）收敛为 outcome='failed' + detail=错误信息，
 *    其余步骤继续执行。步骤可以是同步或异步（runRepairSteps 会 await 每一步）。
 * 3. 前置条件缺失（DB 未初始化 / dataDir 不存在）是 'skipped' 而不是 'failed'。
 * 4. 绝不破坏用户数据：
 *    - pacc.db.bak（迁移快照）与 pacc.db.corrupt.*（损坏库备份）永不删除；
 *    - 活跃 Run 的 `__seq_claim` 行永不删除 —— 删除会让 MAX(seq) 回退，
 *      下一次分配复用已用过的 seq，撞 UNIQUE(run_id, seq) 后重试错乱，
 *      直接破坏正在进行的直播流。
 */
import { existsSync, readdirSync, statSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { and, eq, exists, inArray, notExists, notInArray, or, sql } from 'drizzle-orm'
import type { BackendConfig } from '../../config/index.js'
import { flushDbSync, getDb, getLastFlushError, retryPendingFlush, runInTransaction, saveDb } from '../../db/client.js'
import { conversations, events, messages, runs } from '../../db/schema/index.js'
import { SEQ_CLAIM_EVENT_TYPE } from '../../core/events/sequence-allocator.db.js'
import { RunLifecycleManager, type RunStatus } from '../../core/runtime/index.js'
import { repairOrphanWorkflowRuns } from '../workflows/store.js'
import { clearReadFileCache } from '../../lib/files.js'
import { clearPendingApprovals } from '../../lib/approvals-center.js'
import { closeAllMcpClients } from '../../lib/mcp-client.js'
import { getSupabaseClient, getSyncConfig, ensureSyncRuntime } from '../sync/index.js'

/** 单步修复结果分类。 */
export type RepairOutcome = 'fixed' | 'already-healthy' | 'skipped' | 'failed'

/** 前端 UI 按此结构逐条渲染修复报告。 */
export interface RepairStepResult {
  id: string
  label: string
  outcome: RepairOutcome
  changed: number
  detail: string
}

/** 修复上下文：now 可注入，便于测试确定性地判断文件年龄。 */
export interface RepairContext {
  config: BackendConfig
  now?: number
}

type Db = ReturnType<typeof getDb>
type StepBody = Omit<RepairStepResult, 'id' | 'label'>
/** 步骤执行体可以是同步或异步：同步步骤直接返回值，异步步骤返回 Promise。 */
export type RepairStepRun = (ctx: RepairContext) => RepairStepResult | Promise<RepairStepResult>

const STEP_LABELS = {
  'database-flush': '数据库落盘',
  'orphan-messages': '孤立消息清理',
  'stale-runs': '崩溃遗留 Run 恢复',
  'orphan-workflow-runs': '孤立工作流运行修复',
  'ghost-seq-claims': '幽灵序号占位行清理',
  'in-memory-caches': '内存缓存与 MCP 连接重置',
  'orphan-temp-files': '残留临时文件清理',
  'sync_runtime': '恢复同步监听',
} as const

type RepairStepId = keyof typeof STEP_LABELS

/** 落盘临时文件名前缀（与 db/client.ts 的 atomicWrite 一致）。 */
const TMP_FILE_PREFIX = 'pacc.db.tmp.'
/** 临时文件保留期：短于此值视为"可能正在落盘"，不删。 */
const TMP_FILE_MAX_AGE_MS = 60 * 60 * 1000
/** 仍可能继续分配 seq 的 Run 状态 —— 其占位行一律保留。 */
const ACTIVE_RUN_STATUSES: RunStatus[] = ['created', 'running', 'waiting', 'retry_waiting', 'retrying', 'verifying']

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 前置条件缺失（DB 尚未初始化）—— skipped，不是 failed。 */
function skip(detail: string): StepBody {
  return { outcome: 'skipped', changed: 0, detail }
}

function activeDb(): Db | null {
  try {
    return getDb()
  } catch {
    return null
  }
}

/** 统一收口：补 id/label，把 body 抛出的异常降级为 outcome='failed'。 */
function finish(id: RepairStepId, body: () => StepBody): RepairStepResult {
  try {
    return { id, label: STEP_LABELS[id], ...body() }
  } catch (error: unknown) {
    const detail = errorMessage(error)
    console.error(`[SelfCheck/repair] 步骤 ${id} 失败: ${detail}`)
    return { id, label: STEP_LABELS[id], outcome: 'failed', changed: 0, detail }
  }
}

/**
 * finish 的异步孪生：步骤体本身是 async 时用本函数，
 * 保证「单步异常（含 await 中的 rejection）→ outcome='failed'，不中断整批」在两种步骤下同义。
 */
async function finishAsync(id: RepairStepId, body: () => Promise<StepBody>): Promise<RepairStepResult> {
  try {
    return { id, label: STEP_LABELS[id], ...(await body()) }
  } catch (error: unknown) {
    const detail = errorMessage(error)
    console.error(`[SelfCheck/repair] 步骤 ${id} 失败: ${detail}`)
    return { id, label: STEP_LABELS[id], outcome: 'failed', changed: 0, detail }
  }
}

/**
 * 步骤 id 解析：把调用方（HTTP body / CLI 参数）写的步骤名映射到 canonical id。
 * 连字符与下划线写法自动等价；语义相同的简写（如 db_flush）需在此显式登记。
 */
const STEP_ALIASES: Readonly<Record<string, RepairStepId>> = {
  db_flush: 'database-flush',
}

/** 未知 id 返回 null（HTTP 层据此回 400，绝不静默忽略）。 */
export function findStepId(id: string): RepairStepId | null {
  const raw = id.trim()
  const alias = STEP_ALIASES[raw]
  if (alias !== undefined) return alias
  const underscored = raw.replace(/-/g, '_')
  return STEP_DEFS.find(def => def.id === raw || def.id.replace(/-/g, '_') === underscored)?.id ?? null
}

/** 步骤 1：把失败队列重试并强制落盘（flushNow 的重试队列只以 lastFlushError 暴露）。 */
export function repairDatabaseFlush(ctx: RepairContext): RepairStepResult {
  return finish('database-flush', () => {
    if (!existsSync(ctx.config.dataDir)) return skip(`数据目录不存在: ${ctx.config.dataDir}`)
    const pendingError = getLastFlushError()
    const retried = retryPendingFlush(ctx.config)
    const flushed = flushDbSync(ctx.config)
    if (!retried || !flushed) {
      return { outcome: 'failed', changed: 0, detail: `落盘失败: ${getLastFlushError() ?? 'retryPendingFlush 未成功'}` }
    }
    if (pendingError !== null) {
      return { outcome: 'fixed', changed: 1, detail: `重试队列已落盘（上次错误: ${pendingError}）` }
    }
    return { outcome: 'already-healthy', changed: 0, detail: '无待重试数据，已强制落盘' }
  })
}

/** 步骤 2：删除 conversation_id 无对应会话的消息（迁移前遗留的脏数据），事务保护。 */
export function repairOrphanMessages(ctx: RepairContext): RepairStepResult {
  return finish('orphan-messages', () => {
    const db = activeDb()
    if (db === null) return skip('数据库未初始化')
    const orphanIds = db
      .select({ id: messages.id })
      .from(messages)
      .where(notExists(db.select({ one: sql`1` }).from(conversations).where(eq(conversations.id, messages.conversationId))))
      .all()
      .map(row => row.id)
    if (orphanIds.length === 0) return { outcome: 'already-healthy', changed: 0, detail: '无孤立消息' }
    runInTransaction(ctx.config, () => {
      db.delete(messages).where(inArray(messages.id, orphanIds)).run()
    })
    return { outcome: 'fixed', changed: orphanIds.length, detail: `清理 ${orphanIds.length} 条无对应会话的消息` }
  })
}

/** 步骤 3：Crash Recovery —— 遗留 running/waiting 的 Run 标记为 interrupted。 */
export function repairStaleRuns(ctx: RepairContext): RepairStepResult {
  return finish('stale-runs', () => {
    const db = activeDb()
    if (db === null) return skip('数据库未初始化')
    const marked = new RunLifecycleManager(db).recoverStale()
    if (marked === 0) return { outcome: 'already-healthy', changed: 0, detail: '无崩溃遗留 Run' }
    saveDb(ctx.config)
    return { outcome: 'fixed', changed: marked, detail: `标记 ${marked} 个崩溃遗留 Run 为 interrupted` }
  })
}

/**
 * 步骤 4：workflow_runs 与 runs 状态不一致的孤儿记录修复。
 * 上游 repairOrphanWorkflowRuns 自身吞掉异常并返回 0（失败不外泄），
 * 因此本步骤把"返回 0"视为无需修复而非失败。
 */
export function repairOrphanWorkflowRunsStep(ctx: RepairContext): RepairStepResult {
  return finish('orphan-workflow-runs', () => {
    const db = activeDb()
    if (db === null) return skip('数据库未初始化')
    const repaired = repairOrphanWorkflowRuns(db, ctx.config)
    if (repaired === 0) return { outcome: 'already-healthy', changed: 0, detail: '无孤立工作流运行记录' }
    return { outcome: 'fixed', changed: repaired, detail: `修复 ${repaired} 条状态不一致的工作流运行记录` }
  })
}

/**
 * 步骤 5：清理幽灵 `__seq_claim` 占位行。
 * 删除口径（保守）：
 *  (a) run_id 无对应 runs 行 —— 外键缺失只可能来自历史脏数据；
 *  (b) 该 Run 已进入终态且没有任何真实事件行 —— 它永远不会再分配 seq。
 * 活跃 Run 的占位行一律保留：删掉会让 MAX(seq) 回退造成 seq 复用。
 */
export function repairGhostSequenceClaims(ctx: RepairContext): RepairStepResult {
  return finish('ghost-seq-claims', () => {
    const db = activeDb()
    if (db === null) return skip('数据库未初始化')
    const runGone = notExists(db.select({ id: runs.id }).from(runs).where(eq(runs.id, events.runId)))
    const runTerminated = exists(
      db
        .select({ id: runs.id })
        .from(runs)
        .where(and(eq(runs.id, events.runId), notInArray(runs.status, ACTIVE_RUN_STATUSES))),
    )
    // events 与自身相关联，drizzle builder 无法区分内外同名表，因此这里显式写出括号。
    const runHasNoRealEvent = sql`NOT EXISTS (SELECT 1 FROM events e WHERE e.run_id = ${events.runId} AND e.event_type <> ${SEQ_CLAIM_EVENT_TYPE})`
    const ghostIds = db
      .select({ id: events.id })
      .from(events)
      .where(and(eq(events.eventType, SEQ_CLAIM_EVENT_TYPE), or(runGone, and(runTerminated, runHasNoRealEvent))))
      .all()
      .map(row => row.id)
    if (ghostIds.length === 0) return { outcome: 'already-healthy', changed: 0, detail: '无幽灵序号占位行' }
    runInTransaction(ctx.config, () => {
      db.delete(events).where(inArray(events.id, ghostIds)).run()
    })
    return { outcome: 'fixed', changed: ghostIds.length, detail: `清理 ${ghostIds.length} 条幽灵序号占位行` }
  })
}

/** 步骤 6：重置进程内状态（文件读取缓存、待审批、已连接的 MCP 客户端）。 */
export function repairInMemoryCaches(_ctx: RepairContext): RepairStepResult {
  return finish('in-memory-caches', () => {
    clearReadFileCache()
    clearPendingApprovals()
    // closeAllMcpClients 是 async，而本步骤只需要"已派发关闭"这个事实，
    // 不需要等它结束 —— 因此保持同步返回并显式捕获 rejection；
    // 未处理的 Promise 拒绝会在进程层面终止整个修复批次。
    void closeAllMcpClients().catch((error: unknown) => {
      console.warn('[SelfCheck/repair] MCP 连接关闭失败:', errorMessage(error))
    })
    return { outcome: 'fixed', changed: 1, detail: '已清空文件读取缓存与待审批，并派发 MCP 连接关闭' }
  })
}

/**
 * 步骤 7：清理崩溃残留的落盘临时文件。
 * 只碰 `pacc.db.tmp.*`，且仅删除超过 1h 的（更年轻的可能正在写盘）；
 * `pacc.db.bak` / `pacc.db.corrupt.*` 是用户数据兜底，不匹配前缀因而永不进入删除集合。
 */
export function repairOrphanTempFiles(ctx: RepairContext): RepairStepResult {
  return finish('orphan-temp-files', () => {
    const dataDir = ctx.config.dataDir
    if (!existsSync(dataDir)) return skip(`数据目录不存在: ${dataDir}`)
    const now = ctx.now ?? Date.now()
    let removed = 0
    for (const name of readdirSync(dataDir)) {
      if (!name.startsWith(TMP_FILE_PREFIX)) continue
      const fullPath = join(dataDir, name)
      const stats = statSync(fullPath)
      if (!stats.isFile() || now - stats.mtimeMs <= TMP_FILE_MAX_AGE_MS) continue
      unlinkSync(fullPath)
      removed += 1
    }
    if (removed === 0) return { outcome: 'already-healthy', changed: 0, detail: '无残留临时文件' }
    return { outcome: 'fixed', changed: removed, detail: `清理 ${removed} 个残留落盘临时文件` }
  })
}

/**
 * 步骤 8：恢复远程同步监听（Supabase Realtime + 轮询兜底）。
 * 对应 GET /api/selfcheck 的「远程同步 = warn（已配置但监听未启动）」信号 ——
 * 唯一能真正修好它的动作就是重启监听（ensureSyncRuntime 自身幂等，可重复调用）。
 * 未配置同步时是 skipped 而不是 failed：用户没开同步不是「故障」。
 */
export async function repairSyncRuntime(ctx: RepairContext): Promise<RepairStepResult> {
  return finishAsync('sync_runtime', async () => {
    if (getSyncConfig() === null || getSupabaseClient() === null) return skip('未配置同步')
    const started = await ensureSyncRuntime(ctx.config)
    if (!started) return { outcome: 'failed', changed: 0, detail: '同步监听未能启动' }
    return { outcome: 'fixed', changed: 1, detail: '已恢复 Supabase Realtime 监听与轮询兜底' }
  })
}

const STEP_DEFS: readonly {
  readonly id: RepairStepId
  readonly label: string
  readonly run: RepairStepRun
}[] = [
  { id: 'database-flush', label: STEP_LABELS['database-flush'], run: repairDatabaseFlush },
  { id: 'orphan-messages', label: STEP_LABELS['orphan-messages'], run: repairOrphanMessages },
  { id: 'stale-runs', label: STEP_LABELS['stale-runs'], run: repairStaleRuns },
  { id: 'orphan-workflow-runs', label: STEP_LABELS['orphan-workflow-runs'], run: repairOrphanWorkflowRunsStep },
  { id: 'ghost-seq-claims', label: STEP_LABELS['ghost-seq-claims'], run: repairGhostSequenceClaims },
  { id: 'in-memory-caches', label: STEP_LABELS['in-memory-caches'], run: repairInMemoryCaches },
  { id: 'orphan-temp-files', label: STEP_LABELS['orphan-temp-files'], run: repairOrphanTempFiles },
  { id: 'sync_runtime', label: STEP_LABELS['sync_runtime'], run: repairSyncRuntime },
]

/** 全部修复步骤（批次默认执行顺序）。 */
export const REPAIR_STEPS: readonly RepairStepRun[] = STEP_DEFS.map(def => def.run)

/** 合法步骤 id 清单 —— HTTP 层据此拒绝未知步骤（400）。 */
export const REPAIR_STEP_IDS: readonly string[] = STEP_DEFS.map(def => def.id)

/**
 * 执行修复批次：ids 省略时跑全部步骤，否则只跑指定 id（连字符/下划线/已登记的简写均可）。
 * 每步内部已收敛异常为 outcome='failed'，因此本函数不会因单步失败而中断；
 * 异步步骤按 STEP_DEFS 顺序逐个 await，保证前端看到的报告顺序稳定。
 */
export async function runRepairSteps(ctx: RepairContext, ids?: readonly string[]): Promise<RepairStepResult[]> {
  const wanted = ids === undefined ? null : new Set(ids.map(findStepId).filter((id): id is RepairStepId => id !== null))
  const results: RepairStepResult[] = []
  for (const def of STEP_DEFS) {
    if (wanted !== null && !wanted.has(def.id)) continue
    results.push(await def.run(ctx))
  }
  return results
}