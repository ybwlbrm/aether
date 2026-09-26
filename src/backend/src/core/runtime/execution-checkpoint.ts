/**
 * ExecutionCheckpoint — W6 Loop 可恢复检查点基础模块。
 *
 * 本模块与既有 checkpoint.ts 并存：旧 Checkpoint 导出保持不变，本模块
 * 提供面向 Loop 重试的执行步骤、工具结果、错误与尝试次数快照。
 */

import { RuntimeError } from '../errors/index.js'

export type JsonValue = string | number | boolean | null | JsonObject | readonly JsonValue[]

export type JsonObject = {
  readonly [key: string]: JsonValue
}

export interface ExecutionStepResult {
  readonly step: string
  readonly result: JsonValue
  readonly status?: 'completed' | 'failed'
  readonly error?: string
}

export interface ExecutionCheckpoint {
  readonly runId: string
  readonly turn: number
  readonly seq: number
  readonly completedSteps: readonly string[]
  readonly pendingSteps: readonly string[]
  readonly toolResults: readonly ExecutionStepResult[]
  readonly lastError: string | null
  readonly currentObjective: string
  readonly attempt: number
}

export type CreateExecutionCheckpointInput = {
  readonly runId: string
  readonly turn: number
  readonly seq?: number
  readonly completedSteps: readonly string[]
  readonly pendingSteps: readonly string[]
  readonly toolResults: readonly ExecutionStepResult[]
  readonly lastError: string | null
  readonly currentObjective: string
  readonly attempt: number
}

export type ExecutionCheckpointPosition = Pick<ExecutionCheckpoint, 'seq' | 'turn'>

export class ExecutionCheckpointError extends RuntimeError {
  constructor(message: string, options: { cause?: unknown; context?: Record<string, unknown> } = {}) {
    super(message, {
      code: 'INVALID_EXECUTION_CHECKPOINT',
      retryable: false,
      cause: options.cause,
      context: options.context,
    })
    this.name = 'ExecutionCheckpointError'
    Object.setPrototypeOf(this, ExecutionCheckpointError.prototype)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isArray(value: unknown): value is readonly unknown[] {
  return Array.isArray(value)
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

function isJsonValue(value: unknown, ancestors: WeakSet<object> = new WeakSet<object>()): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value)
  if (typeof value !== 'object') return false
  if (ancestors.has(value)) return false

  ancestors.add(value)
  const valid = isArray(value)
    ? value.every(item => isJsonValue(item, ancestors))
    : Object.values(value).every(item => isJsonValue(item, ancestors))
  ancestors.delete(value)
  return valid
}

function invalid(message: string, context?: Record<string, unknown>, cause?: unknown): ExecutionCheckpointError {
  return new ExecutionCheckpointError(`Invalid execution checkpoint: ${message}`, { context, cause })
}

function requiredString(record: Record<string, unknown>, key: string, path: string): string {
  const value = record[key]
  if (typeof value !== 'string' || value.length === 0) {
    throw invalid(`${path}.${key} must be a non-empty string`, { field: `${path}.${key}` })
  }
  return value
}

function requiredInteger(record: Record<string, unknown>, key: string, path: string): number {
  const value = record[key]
  if (!isNonNegativeInteger(value)) {
    throw invalid(`${path}.${key} must be a non-negative safe integer`, { field: `${path}.${key}` })
  }
  return value
}

function requiredStringArray(record: Record<string, unknown>, key: string, path: string): readonly string[] {
  const value = record[key]
  if (!isArray(value) || value.some(item => typeof item !== 'string' || item.length === 0)) {
    throw invalid(`${path}.${key} must be an array of non-empty strings`, { field: `${path}.${key}` })
  }
  return value.map(item => {
    if (typeof item !== 'string') throw invalid(`${path}.${key} contains a non-string value`)
    return item
  })
}

function parseStepResult(value: unknown, path: string): ExecutionStepResult {
  if (!isRecord(value)) throw invalid(`${path} must be an object`, { field: path })
  if (!isJsonValue(value)) throw invalid(`${path} contains a value incompatible with JSON`, { field: path })

  const step = requiredString(value, 'step', path)
  const result = value.result
  if (result === undefined) throw invalid(`${path}.result is required`, { field: `${path}.result` })
  if (!isJsonValue(result)) {
    throw invalid(`${path}.result must be JSON-compatible`, { field: `${path}.result` })
  }

  const status = value.status
  if (status !== undefined && status !== 'completed' && status !== 'failed') {
    throw invalid(`${path}.status must be completed or failed`, { field: `${path}.status` })
  }
  const error = value.error
  if (error !== undefined && typeof error !== 'string') {
    throw invalid(`${path}.error must be a string`, { field: `${path}.error` })
  }

  return {
    step,
    result,
    ...(status === undefined ? {} : { status }),
    ...(error === undefined ? {} : { error }),
  }
}

function requiredStepResults(record: Record<string, unknown>, path: string): readonly ExecutionStepResult[] {
  const value = record.toolResults
  if (!isArray(value)) throw invalid(`${path}.toolResults must be an array`, { field: `${path}.toolResults` })
  return value.map((item, index) => parseStepResult(item, `${path}.toolResults[${index}]`))
}

function parseCheckpoint(value: unknown, path = 'checkpoint'): ExecutionCheckpoint {
  if (!isRecord(value)) throw invalid(`${path} must be an object`, { field: path })

  const lastError = value.lastError
  if (lastError !== null && typeof lastError !== 'string') {
    throw invalid(`${path}.lastError must be a string or null`, { field: `${path}.lastError` })
  }
  const currentObjective = value.currentObjective
  if (typeof currentObjective !== 'string') {
    throw invalid(`${path}.currentObjective must be a string`, { field: `${path}.currentObjective` })
  }

  return {
    runId: requiredString(value, 'runId', path),
    turn: requiredInteger(value, 'turn', path),
    seq: requiredInteger(value, 'seq', path),
    completedSteps: requiredStringArray(value, 'completedSteps', path),
    pendingSteps: requiredStringArray(value, 'pendingSteps', path),
    toolResults: requiredStepResults(value, path),
    lastError,
    currentObjective,
    attempt: requiredInteger(value, 'attempt', path),
  }
}

function assertMonotonic(
  checkpoint: ExecutionCheckpoint,
  previous: ExecutionCheckpointPosition | undefined,
): void {
  if (previous === undefined) return
  if (checkpoint.seq < previous.seq) {
    throw invalid(`seq must be monotonic: ${checkpoint.seq} < ${previous.seq}`, {
      currentSeq: checkpoint.seq,
      previousSeq: previous.seq,
    })
  }
  if (checkpoint.turn < previous.turn) {
    throw invalid(`turn must be monotonic: ${checkpoint.turn} < ${previous.turn}`, {
      currentTurn: checkpoint.turn,
      previousTurn: previous.turn,
    })
  }
}

export function createExecutionCheckpoint(input: CreateExecutionCheckpointInput): ExecutionCheckpoint {
  return parseCheckpoint({
    runId: input.runId,
    turn: input.turn,
    seq: input.seq ?? input.turn,
    completedSteps: input.completedSteps,
    pendingSteps: input.pendingSteps,
    toolResults: input.toolResults,
    lastError: input.lastError,
    currentObjective: input.currentObjective,
    attempt: input.attempt,
  })
}

export function serializeCheckpoint(checkpoint: ExecutionCheckpoint): string {
  const validated = parseCheckpoint(checkpoint)
  const envelope = {
    v: 1,
    checkpoint: validated,
  }

  try {
    const serialized = JSON.stringify(envelope)
    if (serialized === undefined) throw invalid('checkpoint could not be encoded as JSON')
    return serialized
  } catch (cause: unknown) {
    if (cause instanceof ExecutionCheckpointError) throw cause
    const detail = cause instanceof Error ? cause.message : String(cause)
    throw invalid(`checkpoint is not JSON-compatible: ${detail}`, undefined, cause)
  }
}

export function deserializeCheckpoint(
  raw: string,
  previous?: ExecutionCheckpointPosition,
): ExecutionCheckpoint {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause)
    throw invalid(`malformed JSON: ${detail}`, undefined, cause)
  }

  if (!isRecord(parsed) || parsed.v !== 1) {
    throw invalid('unsupported or missing envelope version', { version: isRecord(parsed) ? parsed.v : undefined })
  }
  const checkpoint = parseCheckpoint(parsed.checkpoint)
  assertMonotonic(checkpoint, previous)
  return checkpoint
}

// ============================================================
// 进程内 checkpoint 仓库（Phase 4：Loop 每轮写入，本轮不做持久化）
// ============================================================

/** 仓库容量上限：按 runId 先进先出淘汰，避免长驻进程内存无界增长。 */
const MAX_TRACKED_CHECKPOINTS = 200

const executionCheckpoints = new Map<string, ExecutionCheckpoint>()

/** 记录（覆盖）某个 runId 的最新 checkpoint。 */
export function recordExecutionCheckpoint(checkpoint: ExecutionCheckpoint): void {
  const validated = parseCheckpoint(checkpoint)
  executionCheckpoints.delete(validated.runId)
  while (executionCheckpoints.size >= MAX_TRACKED_CHECKPOINTS) {
    const oldest = executionCheckpoints.keys().next()
    if (oldest.done === true) break
    executionCheckpoints.delete(oldest.value)
  }
  executionCheckpoints.set(validated.runId, validated)
}

/** 读取某个 runId 的最新 checkpoint（供后续 Retry 恢复）。 */
export function getExecutionCheckpoint(runId: string): ExecutionCheckpoint | undefined {
  return executionCheckpoints.get(runId)
}

/** 清空仓库（测试隔离用）。 */
export function clearExecutionCheckpoints(): void {
  executionCheckpoints.clear()
}

export function mergeStepResult(
  checkpoint: ExecutionCheckpoint,
  toolResult: ExecutionStepResult,
): ExecutionCheckpoint {
  const current = parseCheckpoint(checkpoint)
  const result = parseStepResult(toolResult, 'toolResult')
  const failed = result.status === 'failed' || result.error !== undefined

  if (failed) {
    return {
      ...current,
      lastError: result.error ?? `工具步骤 ${result.step} 执行失败`,
    }
  }

  const completedSteps = current.completedSteps.includes(result.step)
    ? current.completedSteps
    : [...current.completedSteps, result.step]
  const pendingSteps = current.pendingSteps.filter(step => step !== result.step)
  const toolResults = [
    ...current.toolResults.filter(existing => existing.step !== result.step),
    result,
  ]

  return {
    ...current,
    completedSteps,
    pendingSteps,
    toolResults,
    lastError: null,
  }
}
