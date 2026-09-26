/**
 * 节点级执行：结果归一化 + 节点行持久化 + 按节点粒度重试（AEX-P0-015/017/018）。
 *
 * 从 execution-engine.ts 拆出，使引擎只关心 DAG 调度与终态落库，
 * 节点的「跑一次 / 落一行 / 失败重试」语义集中在这里。
 */

import { eq } from 'drizzle-orm'
import { ExecutionRetryController, isToolRetryable } from '../../core/runtime/execution-retry.js'
import type { RetryEvent } from '../../core/runtime/execution-retry.js'
import { RetryExhaustedError } from '../../core/errors/index.js'
import { workflowRuns } from '../../db/schema/index.js'
import type { getDb } from '../../db/client.js'
import type { BackendConfig } from '../../config/index.js'
import { createNodeExecutionError } from './node-error.js'
import type { NodeFailureDetail } from './node-error.js'
import {
  markNodeRunAttempt,
  markNodeRunCancelled,
  markNodeRunCompleted,
  markNodeRunFailed,
  type NodeRunStore,
} from './node-run-store.js'
import type { NodeExecutionResult, NodeFailureCode, WorkflowNode } from './types.js'

type WorkflowDatabase = ReturnType<typeof getDb>
type WorkflowEventEmitter = (type: string, payload: Record<string, unknown>) => void

/** 节点结果在 workflow_runs.results JSON 中的投影（同时是 HTTP 响应契约） */
export type NodeResultRecord = {
  readonly label: string
  readonly type: WorkflowNode['type']
  readonly output: string
  readonly data?: unknown
  readonly status: 'completed' | 'failed' | 'cancelled'
  readonly error?: string
  readonly code?: NodeFailureCode
}

type NodeRunSucceeded = {
  readonly node: WorkflowNode
  readonly status: 'completed'
  readonly output: string
  readonly data: unknown
}

type NodeRunFailed = {
  readonly node: WorkflowNode
  readonly status: 'failed'
  readonly output: string
  readonly error: string
  readonly detail: NodeFailureDetail
}

type NodeRunCancelled = {
  readonly node: WorkflowNode
  readonly status: 'cancelled'
  readonly output: string
  readonly error: string
}

export type WaveNodeResult = NodeRunSucceeded | NodeRunFailed | NodeRunCancelled

/** normalizeNodeResult 的结果域：不含 cancelled（取消由 executeWaveNode 的 signal 分支产生） */
type NodeNormalizeResult = NodeRunSucceeded | NodeRunFailed

export type ExecuteNodeFn = (
  node: WorkflowNode,
  config: BackendConfig,
  context: Record<string, unknown>,
  signal?: AbortSignal,
) => Promise<NodeExecutionResult>

export type WaveNodeExecution = {
  readonly node: WorkflowNode
  readonly config: BackendConfig
  readonly context: Record<string, unknown>
  readonly signal: AbortSignal
  readonly db: WorkflowDatabase
  readonly runId: string
  readonly emit: WorkflowEventEmitter
  readonly executeNode: ExecuteNodeFn
}

const DEFAULT_NODE_MAX_RETRIES = 2
const DEFAULT_NODE_RETRY_BASE_DELAY_MS = 200
const DEFAULT_NODE_RETRY_MAX_DELAY_MS = 5_000

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function readProperty(value: unknown, key: string): unknown {
  return typeof value === 'object' && value !== null ? Reflect.get(value, key) : undefined
}

/** 重试耗尽时把根因取回来：RetryExhaustedError 只是包装器 */
function rootCause(error: unknown): unknown {
  return error instanceof RetryExhaustedError ? error.lastError : error
}

function detailFromThrown(error: unknown): NodeFailureDetail {
  const cause = rootCause(error)
  const code = readProperty(cause, 'code')
  const statusCode = readProperty(cause, 'statusCode')
  return {
    code: typeof code === 'string' && code !== '' ? code : 'NODE_EXECUTION_FAILED',
    retryable: false,
    ...(typeof statusCode === 'number' ? { statusCode } : {}),
  }
}

function failedNode(
  node: WorkflowNode,
  output: string,
  error: string,
  detail: NodeFailureDetail,
): NodeRunFailed {
  return { node, status: 'failed', output, error, detail }
}

function positiveInt(config: BackendConfig, key: string, fallback: number): number {
  const configured = Reflect.get(config, key)
  return typeof configured === 'number' && Number.isInteger(configured) && configured > 0
    ? configured
    : fallback
}

function readNonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function invalidResult(
  node: WorkflowNode,
  output: string,
  message: string,
): NodeRunFailed {
  return failedNode(node, output, message, { code: 'NODE_INVALID_RESULT', retryable: false })
}

/**
 * 把 executor 的返回值归一化成 WaveNodeResult（AEX-P0-017）。
 *
 * 失败判定从「只看 error 字段」扩展为「消费结构化字段」：
 * code / statusCode / retryable 会被带到重试判定与持久化，不再拼进中文串。
 */
function normalizeNodeResult(node: WorkflowNode, value: unknown): NodeNormalizeResult {
  if (typeof value === 'string') {
    return failedNode(node, value, `节点 ${node.id} 返回了未结构化输出`, {
      code: 'NODE_UNSTRUCTURED_OUTPUT',
      retryable: false,
    })
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalidResult(node, '', `节点 ${node.id} 返回了无效执行结果`)
  }

  const output = Reflect.get(value, 'output')
  if (typeof output !== 'string') {
    return invalidResult(node, '', `节点 ${node.id} 返回结果缺少字符串 output`)
  }
  const error = Reflect.get(value, 'error')
  if (error !== undefined && typeof error !== 'string') {
    return invalidResult(node, output, `节点 ${node.id} 返回了无效 error 标志`)
  }

  const message = readNonEmptyString(error)
  if (message === undefined) {
    return { node, status: 'completed', output, data: Reflect.get(value, 'data') }
  }
  const code = readNonEmptyString(Reflect.get(value, 'code'))
  const statusCode = Reflect.get(value, 'statusCode')
  const retryable = Reflect.get(value, 'retryable')
  return {
    node,
    status: 'failed',
    output,
    error: message,
    detail: {
      code: code ?? 'NODE_EXECUTION_FAILED',
      ...(typeof retryable === 'boolean' ? { retryable } : {}),
      ...(typeof statusCode === 'number' ? { statusCode } : {}),
    },
  }
}

export function toResultRecord(result: WaveNodeResult): NodeResultRecord {
  const base = { label: result.node.label, type: result.node.type, output: result.output }
  switch (result.status) {
    case 'failed':
      return { ...base, status: 'failed', error: result.error, code: result.detail.code }
    case 'cancelled':
      return { ...base, status: 'cancelled', error: result.error, code: 'CANCELLED' }
    case 'completed':
      return { ...base, status: 'completed', data: result.data }
  }
}

export function settledNodeResult(
  node: WorkflowNode,
  settled: PromiseSettledResult<WaveNodeResult>,
): WaveNodeResult {
  if (settled.status === 'fulfilled') return settled.value
  return failedNode(node, '', errorMessage(settled.reason), {
    code: 'NODE_EXECUTION_FAILED',
    retryable: false,
  })
}

/**
 * 重试事件转发：跳过 attempt.started（与 workflow.node.started 语义重复），
 * 其余 retry.* 事件带 nodeId 进入既有 onEvent 通道。
 */
function forwardRetryEvent(emit: WorkflowEventEmitter, node: WorkflowNode, event: RetryEvent): void {
  if (event.type === 'attempt.started') return
  emit(`workflow.node.${event.type}`, {
    nodeId: node.id,
    nodeType: node.type,
    nodeLabel: node.label,
    ...event.payload,
  })
}

/**
 * 执行单个节点（AEX-P0-015/018）。
 *
 * - 每次尝试开始时 upsert 节点行（status=running / attempt / retryCount）
 * - 成功或最终失败/取消时写终态行
 * - 失败以抛出 createNodeExecutionError 的方式交给 ExecutionRetryController，
 *   由 isToolRetryable 决定是否重试；CancellationError 不重试（取消不是失败）
 */
export async function executeWaveNode(input: WaveNodeExecution): Promise<WaveNodeResult> {
  const { node } = input
  const store: NodeRunStore = { db: input.db, runId: input.runId }

  input.db.update(workflowRuns)
    .set({ currentNodeId: node.id })
    .where(eq(workflowRuns.id, input.runId))
    .run()
  input.emit('workflow.node.started', {
    nodeId: node.id,
    nodeType: node.type,
    nodeLabel: node.label,
  })

  const retry = new ExecutionRetryController({
    runId: input.runId,
    taskId: node.id,
    maxRetries: positiveInt(input.config, 'workflowNodeMaxRetries', DEFAULT_NODE_MAX_RETRIES),
    baseDelayMs: positiveInt(
      input.config,
      'workflowNodeRetryBaseDelayMs',
      DEFAULT_NODE_RETRY_BASE_DELAY_MS,
    ),
    maxDelayMs: positiveInt(
      input.config,
      'workflowNodeRetryMaxDelayMs',
      DEFAULT_NODE_RETRY_MAX_DELAY_MS,
    ),
    jitter: 0,
    signal: input.signal,
    shouldRetry: isToolRetryable,
    onEvent: (event) => { forwardRetryEvent(input.emit, node, event) },
  })

  let lastOutput = ''
  try {
    const result = await retry.run(async (attempt) => {
      markNodeRunAttempt(store, node, attempt)
      const execution = await input.executeNode(node, input.config, input.context, input.signal)
      const normalized = normalizeNodeResult(node, execution)
      if (normalized.status === 'failed') {
        lastOutput = normalized.output
        // 错误信息保留节点自身原文；节点 id 的上下文由 run 级终态消息补齐
        throw createNodeExecutionError(normalized.error, normalized.detail)
      }
      return normalized
    })
    markNodeRunCompleted(store, node.id, result.output)
    input.emit('workflow.node.completed', {
      nodeId: node.id,
      nodeType: node.type,
      nodeLabel: node.label,
    })
    return result
  } catch (error: unknown) {
    // 取消不是失败：节点行标记 cancelled，run 终态由引擎判为 cancelled
    if (input.signal.aborted) {
      markNodeRunCancelled(store, node.id, lastOutput)
      return { node, status: 'cancelled', output: lastOutput, error: '节点执行已取消' }
    }
    const message = errorMessage(rootCause(error))
    markNodeRunFailed(store, node.id, message, lastOutput)
    return failedNode(node, lastOutput, message, detailFromThrown(error))
  }
}
