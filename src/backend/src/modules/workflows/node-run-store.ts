/**
 * AEX-P0-015 —— workflow_node_runs 节点行持久化。
 *
 * 主键是确定性的 `${runId}:${nodeId}`，因此「开始一次尝试」用 upsert
 * （select → insert / update）实现，重试不会产生重复行，并行节点各写各的行，
 * 互不覆盖。单节点在一次运行中只被调度一次（visited 集合保证），
 * 所以这里的 select-then-write 是安全的：sql.js 的写入是同步的。
 */

import { and, eq, inArray } from 'drizzle-orm'
import { workflowNodeRuns } from '../../db/schema/index.js'
import type { getDb } from '../../db/client.js'
import type { WorkflowNode } from './types.js'

type WorkflowDatabase = ReturnType<typeof getDb>

function nodeRunId(runId: string, nodeId: string): string {
  return `${runId}:${nodeId}`
}

/** 幂等 upsert：行不存在则插入，存在则按 patch 更新 */
function upsertNodeRun(
  db: WorkflowDatabase,
  id: string,
  create: typeof workflowNodeRuns.$inferInsert,
  patch: Partial<typeof workflowNodeRuns.$inferInsert>,
): void {
  const existing = db.select().from(workflowNodeRuns)
    .where(eq(workflowNodeRuns.id, id))
    .get()
  if (existing) {
    db.update(workflowNodeRuns).set(patch).where(eq(workflowNodeRuns.id, id)).run()
    return
  }
  db.insert(workflowNodeRuns).values(create).run()
}

export type NodeRunStore = {
  readonly db: WorkflowDatabase
  readonly runId: string
}

/** 标记节点开始一次尝试（attempt 从 1 起；重试时覆盖为新的 attempt） */
export function markNodeRunAttempt(
  store: NodeRunStore,
  node: WorkflowNode,
  attempt: number,
): void {
  const id = nodeRunId(store.runId, node.id)
  const startedAt = new Date().toISOString()
  upsertNodeRun(store.db, id, {
    id,
    workflowRunId: store.runId,
    nodeId: node.id,
    status: 'running',
    attempt,
    retryCount: Math.max(0, attempt - 1),
    startedAt,
    completedAt: null,
    error: null,
    output: null,
  }, {
    status: 'running',
    attempt,
    retryCount: Math.max(0, attempt - 1),
    startedAt,
    completedAt: null,
    error: null,
  })
}

/** 标记节点成功终态 */
export function markNodeRunCompleted(
  store: NodeRunStore,
  nodeId: string,
  output: string,
): void {
  const id = nodeRunId(store.runId, nodeId)
  upsertNodeRun(store.db, id, {
    id,
    workflowRunId: store.runId,
    nodeId,
    status: 'completed',
    attempt: 1,
    retryCount: 0,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    error: null,
    output,
  }, {
    status: 'completed',
    completedAt: new Date().toISOString(),
    error: null,
    output,
  })
}

/** 标记节点失败终态 */
export function markNodeRunFailed(
  store: NodeRunStore,
  nodeId: string,
  error: string,
  output: string,
): void {
  const id = nodeRunId(store.runId, nodeId)
  upsertNodeRun(store.db, id, {
    id,
    workflowRunId: store.runId,
    nodeId,
    status: 'failed',
    attempt: 1,
    retryCount: 0,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    error,
    output,
  }, {
    status: 'failed',
    completedAt: new Date().toISOString(),
    error,
    output,
  })
}

/** 标记节点被取消（取消不是失败：保留最后一次输出，error 说明取消原因） */
export function markNodeRunCancelled(
  store: NodeRunStore,
  nodeId: string,
  output: string,
): void {
  const id = nodeRunId(store.runId, nodeId)
  const completedAt = new Date().toISOString()
  upsertNodeRun(store.db, id, {
    id,
    workflowRunId: store.runId,
    nodeId,
    status: 'cancelled',
    attempt: 1,
    retryCount: 0,
    startedAt: completedAt,
    completedAt,
    error: '节点执行已取消',
    output,
  }, {
    status: 'cancelled',
    completedAt,
    error: '节点执行已取消',
    output,
  })
}

/**
 * 关闭孤儿运行遗留的 running 节点行（AEX-P0-015）。
 *
 * 进程被强杀时节点行停在 running；repairOrphanWorkflowRuns 把父 run 标成 failed，
 * 节点行必须一并收口，否则节点态这个「事实源」会永久漂在 running。
 */
export function closeDanglingNodeRuns(db: WorkflowDatabase, runIds: readonly string[]): void {
  if (runIds.length === 0) return
  db.update(workflowNodeRuns)
    .set({
      status: 'failed',
      error: 'orphan repair: 所属运行已终止',
      completedAt: new Date().toISOString(),
    })
    .where(and(
      inArray(workflowNodeRuns.workflowRunId, [...runIds]),
      eq(workflowNodeRuns.status, 'running'),
    ))
    .run()
}
