import { eq } from 'drizzle-orm'
import type { BackendConfig } from '../../config/index.js'
import { workflowRuns } from '../../db/schema/index.js'
import type { getDb } from '../../db/client.js'
import { RunLifecycleManager } from '../../core/runtime/index.js'
import { RuntimeError } from '../../core/errors/index.js'
import { runCancellationRegistry } from '../../lib/run-cancellation-registry.js'
import { createWorkflowRunInternal } from './store.js'
import {
  executeWaveNode,
  settledNodeResult,
  toResultRecord,
  type ExecuteNodeFn,
  type NodeResultRecord,
  type WaveNodeResult,
} from './node-execution.js'
import type { WorkflowEdge, WorkflowNode } from './types.js'

export { repairOrphanWorkflowRuns } from './store.js'

type WorkflowDatabase = ReturnType<typeof getDb>
type WorkflowEventEmitter = (type: string, payload: Record<string, unknown>) => void
type WorkflowRequest = {
  readonly raw: {
    readonly socket?: {
      readonly destroyed?: boolean
    }
  }
}

type WorkflowTerminal =
  | { readonly status: 'completed' }
  | { readonly status: 'failed'; readonly error: string }
  | { readonly status: 'cancelled'; readonly error: string }

type TerminalPersistence =
  | { readonly kind: 'persisted' }
  | { readonly kind: 'cancelled' }
  | { readonly kind: 'failed'; readonly error: string }

type WorkflowRunTerminalUpdate = {
  readonly db: WorkflowDatabase
  readonly runId: string
  readonly terminal: WorkflowTerminal
  readonly results: Record<string, NodeResultRecord>
  readonly completedAt: string
}

export interface ExecuteWorkflowOptions {
  readonly workflowId: string
  readonly nodes: WorkflowNode[]
  readonly edges: WorkflowEdge[]
  readonly input?: Record<string, unknown>
  readonly config: BackendConfig
  readonly executeNode: ExecuteNodeFn
  readonly signal?: AbortSignal
  readonly db: WorkflowDatabase
  readonly saveDb: (config: BackendConfig) => void
  readonly request: WorkflowRequest
  readonly onEvent?: WorkflowEventEmitter
}

export interface ExecuteWorkflowResult {
  readonly runId: string
  readonly status: 'completed' | 'failed' | 'cancelled'
  readonly results: Record<string, NodeResultRecord>
  readonly error?: string
  readonly startedAt: string
  readonly completedAt: string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function maxParallelism(config: BackendConfig): number {
  const configured = Reflect.get(config, 'workflowMaxParallel')
  return typeof configured === 'number' && Number.isInteger(configured) && configured > 0
    ? configured
    : 4
}

/** 按边关系做拓扑排序；有环时返回 null（调用方 fail-fast，LC-020） */
export function topoSort(nodes: WorkflowNode[], edges: WorkflowEdge[]): WorkflowNode[] | null {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  const indegree = new Map(nodes.map((node) => [node.id, 0]))
  const adjacency = new Map<string, string[]>()
  for (const edge of edges) {
    if (!byId.has(edge.source) || !byId.has(edge.target)) continue
    const targets = adjacency.get(edge.source) ?? []
    targets.push(edge.target)
    adjacency.set(edge.source, targets)
    indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1)
  }

  const queue = nodes
    .filter((node) => (indegree.get(node.id) ?? 0) === 0)
    .map((node) => node.id)
  const order: string[] = []
  while (queue.length > 0) {
    const id = queue.shift()
    if (id === undefined) break
    order.push(id)
    for (const target of adjacency.get(id) ?? []) {
      const degree = (indegree.get(target) ?? 0) - 1
      indegree.set(target, degree)
      if (degree === 0) queue.push(target)
    }
  }
  if (order.length !== nodes.length) return null

  const sorted: WorkflowNode[] = []
  for (const id of order) {
    const node = byId.get(id)
    if (node) sorted.push(node)
  }
  return sorted
}

/** 执行工作流核心逻辑 */
export async function executeWorkflow(opts: ExecuteWorkflowOptions): Promise<ExecuteWorkflowResult> {
  const { workflowId, nodes, edges, input, config, executeNode, db, saveDb, request, onEvent } = opts
  if (nodes.length === 0) throw new Error('工作流没有节点，无法执行')

  const { runId, now } = await createWorkflowRunInternal({
    workflowId,
    firstNodeId: nodes[0]?.id,
    config,
    db,
    saveDb,
  })
  const cancellationController = new AbortController()
  runCancellationRegistry.register(runId, runId, cancellationController)
  const abortFromCaller = (): void => cancellationController.abort()
  if (opts.signal?.aborted) abortFromCaller()
  else opts.signal?.addEventListener('abort', abortFromCaller, { once: true })

  const signal = cancellationController.signal
  const emit: WorkflowEventEmitter = (type, payload) => {
    onEvent?.(type, { workflowId, runId, ...payload })
  }
  emit('workflow.started', { startedAt: now, nodeCount: nodes.length })

  let results: Record<string, NodeResultRecord> = {}
  const context: Record<string, unknown> = { ...(input ?? {}) }
  let terminal: WorkflowTerminal = { status: 'completed' }

  try {
    const ordered = topoSort(nodes, edges)
    if (!ordered) throw new Error('工作流存在循环依赖，无法执行。请检查节点连接关系。')

    const edgeMap = new Map<string, WorkflowEdge[]>()
    const indegree = new Map<string, number>(nodes.map((node) => [node.id, 0]))
    for (const edge of edges) {
      const outgoing = edgeMap.get(edge.source) ?? []
      outgoing.push(edge)
      edgeMap.set(edge.source, outgoing)
      if (indegree.has(edge.target)) {
        indegree.set(edge.target, (indegree.get(edge.target) ?? 0) + 1)
      }
    }

    const nodeById = new Map(ordered.map((node) => [node.id, node]))
    const ready = ordered
      .filter((node) => (indegree.get(node.id) ?? 0) === 0)
      .map((node) => node.id)
    const visited = new Set<string>()
    const maxParallel = maxParallelism(config)

    while (ready.length > 0) {
      if (signal.aborted) {
        terminal = { status: 'cancelled', error: '工作流执行已取消' }
        break
      }

      const wave: WorkflowNode[] = []
      while (ready.length > 0 && wave.length < maxParallel) {
        const nodeId = ready.shift()
        if (nodeId === undefined || visited.has(nodeId)) continue
        const node = nodeById.get(nodeId)
        if (!node) continue
        visited.add(nodeId)
        wave.push(node)
      }
      if (wave.length === 0) break

      const settled = await Promise.allSettled(wave.map((node) => executeWaveNode({
        node,
        config,
        context,
        signal,
        db,
        runId,
        emit,
        executeNode,
      })))
      const waveResults: WaveNodeResult[] = []
      for (const [index, entry] of settled.entries()) {
        const node = wave[index]
        if (node) waveResults.push(settledNodeResult(node, entry))
      }

      for (const result of waveResults) {
        results = { ...results, [result.node.id]: toResultRecord(result) }
        if (result.status === 'completed') context[result.node.id] = result.output
      }

      if (signal.aborted) {
        terminal = { status: 'cancelled', error: '工作流执行已取消' }
        break
      }
      // AEX-P0-016: 客户端断开等同取消，不是失败 —— abort 让同 run 的其他
      // 订阅者（runCancellationRegistry）也看到取消，终态记 cancelled。
      if (request.raw.socket?.destroyed === true) {
        cancellationController.abort()
        terminal = { status: 'cancelled', error: '客户端已断开连接，工作流执行已取消' }
        break
      }
      const failed = waveResults.find((result) => result.status === 'failed')
      if (failed?.status === 'failed') {
        terminal = { status: 'failed', error: `节点 ${failed.node.id} 执行失败: ${failed.error}` }
        break
      }

      for (const result of waveResults) {
        if (result.status !== 'completed') continue
        const passed = result.node.type === 'condition' ? conditionPassed(result.data) : null
        for (const edge of edgeMap.get(result.node.id) ?? []) {
          if (!shouldTraverseEdge(result.node, edge, passed)) continue
          if (visited.has(edge.target)) continue
          const degree = (indegree.get(edge.target) ?? 1) - 1
          indegree.set(edge.target, degree)
          if (degree === 0) ready.push(edge.target)
        }
      }
    }
  } catch (error: unknown) {
    terminal = signal.aborted
      ? { status: 'cancelled', error: '工作流执行已取消' }
      : { status: 'failed', error: errorMessage(error) }
  } finally {
    opts.signal?.removeEventListener('abort', abortFromCaller)
    runCancellationRegistry.unregister(runId)
  }

  if (signal.aborted) terminal = { status: 'cancelled', error: '工作流执行已取消' }
  const completedAt = new Date().toISOString()
  terminal = persistTerminalState({ db, runId, terminal, results, completedAt })
  saveDb(config)

  if (terminal.status === 'completed') {
    emit('workflow.completed', { completedAt, resultCount: Object.keys(results).length })
  } else if (terminal.status === 'cancelled') {
    emit('workflow.cancelled', {
      error: terminal.error,
      completedAt,
    })
  } else {
    emit('workflow.failed', {
      error: terminal.error,
      completedAt,
      terminalStatus: terminal.status,
    })
  }

  return {
    runId,
    status: terminal.status,
    results,
    error: terminal.status === 'completed' ? undefined : terminal.error,
    startedAt: now,
    completedAt,
  }
}

function conditionPassed(data: unknown): boolean | null {
  if (typeof data !== 'object' || data === null) return null
  const passed = Reflect.get(data, 'passed')
  return typeof passed === 'boolean' ? passed : null
}

function shouldTraverseEdge(
  node: WorkflowNode,
  edge: WorkflowEdge,
  passed: boolean | null,
): boolean {
  if (node.type !== 'condition') return true
  if (edge.condition === 'passed') return passed === true
  if (edge.condition === 'failed') return passed === false
  return false
}

function assertNever(value: never): never {
  throw new Error(`未知工作流终态: ${String(value)}`)
}

function isExternalCancellation(
  error: unknown,
  lifecycle: RunLifecycleManager,
  runId: string,
): boolean {
  if (!(error instanceof RuntimeError) || error.code !== 'INVALID_RUN_TRANSITION') return false
  return lifecycle.get(runId)?.status === 'cancelled'
}

function terminalWithPersistenceError(
  terminal: WorkflowTerminal,
  message: string,
): WorkflowTerminal {
  if (terminal.status === 'failed') {
    return { status: 'failed', error: `${terminal.error}; ${message}` }
  }
  return { status: 'failed', error: message }
}

function persistWorkflowRunTerminal(input: WorkflowRunTerminalUpdate): void {
  const { db, runId, terminal, completedAt } = input
  const workflowRun = db.select().from(workflowRuns).where(eq(workflowRuns.id, runId)).get()
  if (!workflowRun) {
    throw new RuntimeError(`workflow_runs 记录不存在: ${runId}`, {
      code: 'WORKFLOW_RUN_NOT_FOUND',
      retryable: false,
    })
  }
  const currentNodeId = terminal.status === 'completed' ? undefined : workflowRun.currentNodeId
  db.update(workflowRuns).set({
    status: terminal.status,
    currentNodeId,
    results: JSON.stringify(input.results),
    error: terminal.status === 'completed' ? null : terminal.error,
    completedAt,
  }).where(eq(workflowRuns.id, runId)).run()
}

function persistTerminalState(input: WorkflowRunTerminalUpdate): WorkflowTerminal {
  let terminal = input.terminal
  try {
    input.db.transaction((tx) => {
      const runPersistence = persistRunTerminal(tx, input.runId, terminal)
      if (runPersistence.kind === 'cancelled') {
        terminal = { status: 'cancelled', error: '工作流已由外部取消' }
      } else if (runPersistence.kind === 'failed') {
        terminal = terminalWithPersistenceError(terminal, runPersistence.error)
      }
      persistWorkflowRunTerminal({ ...input, db: tx, terminal })
    })
  } catch (error: unknown) {
    if (error instanceof RuntimeError && error.code === 'WORKFLOW_TERMINAL_PERSISTENCE_FAILED') {
      throw error
    }
    throw new RuntimeError(`工作流终态写入失败: ${errorMessage(error)}`, {
      code: 'WORKFLOW_TERMINAL_PERSISTENCE_FAILED',
      cause: error,
    })
  }
  return terminal
}

function persistRunTerminal(
  db: WorkflowDatabase,
  runId: string,
  terminal: WorkflowTerminal,
): TerminalPersistence {
  const lifecycle = new RunLifecycleManager(db)
  try {
    switch (terminal.status) {
      case 'completed':
        lifecycle.transition(runId, 'complete', { endReason: 'completed' })
        return { kind: 'persisted' }
      case 'failed':
        lifecycle.transition(runId, 'fail', { error: terminal.error, endReason: 'error' })
        return { kind: 'persisted' }
      case 'cancelled':
        lifecycle.transition(runId, 'cancel', { error: terminal.error, endReason: 'cancelled' })
        return { kind: 'persisted' }
      default:
        return assertNever(terminal)
    }
  } catch (error: unknown) {
    if (isExternalCancellation(error, lifecycle, runId)) {
      return { kind: 'cancelled' }
    }
    const message = `runs 终态写入失败: ${errorMessage(error)}`
    try {
      lifecycle.transition(runId, 'fail', { error: message, endReason: 'error' })
    } catch (fallbackError: unknown) {
      if (isExternalCancellation(fallbackError, lifecycle, runId)) {
        return { kind: 'cancelled' }
      }
      throw new RuntimeError(`${message}; runs 失败回退写入失败: ${errorMessage(fallbackError)}`, {
        code: 'WORKFLOW_TERMINAL_PERSISTENCE_FAILED',
        cause: fallbackError,
      })
    }
    return { kind: 'failed', error: message }
  }
}
