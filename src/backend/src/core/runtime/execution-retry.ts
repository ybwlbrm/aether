import {
  ModelError,
  RetryExhaustedError,
  RuntimeError,
  ToolError,
} from '../errors/index.js'
import { extractRetryAfterMs } from '../models/retry-policy.js'
import { CancellationError, isCancellationError } from './cancellation.js'

export type RetryType = 'automatic' | 'manual'
export type RetryLayer = 'provider' | 'task' | 'tool'
export type RetryEventType =
  | 'attempt.started'
  | 'retry.scheduled'
  | 'retry.started'
  | 'retry.completed'
  | 'retry.failed'
  | 'retry.exhausted'

export interface RetryEventPayload {
  readonly runId: string
  readonly taskId: string
  readonly attempt: number
  readonly maxAttempts: number
  readonly retryType: RetryType
  readonly retryLayer: RetryLayer
  readonly reason?: string
  readonly errorCode?: string
  readonly statusCode?: number
  readonly delayMs?: number
  readonly nextRetryAt?: string
}

export interface RetryEvent {
  readonly type: RetryEventType
  readonly payload: RetryEventPayload
}

export type RetryEventEmitter = (event: RetryEvent) => void
export type RetrySleep = (delayMs: number, signal?: AbortSignal) => Promise<void>
export type RetryPredicate = (error: unknown, attempt: number) => boolean

export interface RetryRunOptions {
  readonly signal?: AbortSignal
  readonly retryType?: RetryType
  readonly shouldRetry?: RetryPredicate
  readonly onRetry?: (error: unknown, attempt: number) => void | Promise<void>
}

export interface ExecutionRetryOptions extends RetryRunOptions {
  readonly maxRetries?: number
  readonly baseDelayMs?: number
  readonly maxDelayMs?: number
  readonly jitter?: number
  readonly runId?: string
  readonly taskId?: string
  readonly onEvent?: RetryEventEmitter
  readonly sleep?: RetrySleep
  readonly now?: () => number
}

export interface ToolRecoveryOptions extends ExecutionRetryOptions {
  readonly completedToolIds?: ReadonlySet<string>
  readonly completedToolResults?: ReadonlyMap<string, string>
  readonly checkpoint?: RetryCheckpoint
}

export interface ToolRecoveryRunOptions extends RetryRunOptions {
  readonly arguments?: string
}

export class RetryCheckpoint {
  readonly #completedToolIds = new Set<string>()
  readonly #completedToolResults = new Map<string, string>()
  readonly #toolFingerprints = new Map<string, string>()

  constructor(
    completedToolIds?: ReadonlySet<string>,
    completedToolResults?: ReadonlyMap<string, string>,
  ) {
    for (const id of completedToolIds ?? []) this.#completedToolIds.add(id)
    for (const [id, result] of completedToolResults ?? []) {
      this.#completedToolIds.add(id)
      this.#completedToolResults.set(id, result)
    }
  }

  get completedToolIds(): ReadonlySet<string> {
    return this.#completedToolIds
  }

  get completedToolResults(): ReadonlyMap<string, string> {
    return this.#completedToolResults
  }

  clear(): void {
    this.#completedToolIds.clear()
    this.#completedToolResults.clear()
    this.#toolFingerprints.clear()
  }

  markToolCompleted(toolId: string, result: string, args?: string): void {
    this.#completedToolIds.add(toolId)
    this.#completedToolResults.set(toolId, result)
    if (args !== undefined) this.#toolFingerprints.set(toolId, args)
  }

  isToolCompleted(toolId: string, args?: string): boolean {
    if (!this.#completedToolIds.has(toolId)) return false
    if (args === undefined) return true
    const fingerprint = this.#toolFingerprints.get(toolId)
    return fingerprint === undefined || fingerprint === args
  }

  getToolResult(toolId: string, args?: string): string | undefined {
    if (!this.isToolCompleted(toolId, args)) return undefined
    return this.#completedToolResults.get(toolId)
  }
}

type RetryLoopConfig = {
  readonly runId: string
  readonly taskId: string
  readonly maxAttempts: number
  readonly baseDelayMs: number
  readonly maxDelayMs: number
  readonly jitter: number
  readonly retryType: RetryType
  readonly layer: RetryLayer
  readonly signal?: AbortSignal
  readonly onEvent?: RetryEventEmitter
  readonly sleep: RetrySleep
  readonly now: () => number
  readonly shouldRetry: RetryPredicate
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function recordOf(error: unknown): Record<string, unknown> | undefined {
  return isRecord(error) ? error : undefined
}

function codeOf(error: unknown): string | undefined {
  const code = recordOf(error)?.code
  return typeof code === 'string' ? code : undefined
}

function statusOf(error: unknown): number | undefined {
  const statusCode = recordOf(error)?.statusCode
  return typeof statusCode === 'number' ? statusCode : undefined
}

function isAbortFailure(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || isCancellationError(error) ||
    (error instanceof Error && error.name === 'AbortError')
}

function lastErrorOf(error: unknown): unknown {
  return error instanceof RetryExhaustedError ? error.lastError : error
}

function isTaskRetryable(error: unknown): boolean {
  if (isCancellationError(error)) return false
  if (error instanceof RetryExhaustedError) return true
  if (error instanceof ModelError || error instanceof ToolError || error instanceof RuntimeError) {
    return error.retryable
  }
  const record = recordOf(error)
  if (record?.retryable !== undefined && typeof record.retryable === 'boolean') {
    return record.retryable
  }
  return true
}

const NON_RETRYABLE_TOOL_CODES = new Set([
  'INVALID_INPUT',
  'INVALID_ARGUMENT',
  'INVALID_ARGUMENTS',
  'TOOL_NOT_FOUND',
  'FILE_NOT_FOUND',
  'PATH_NOT_FOUND',
  'ENOENT',
  'TOOL_DENIED',
  'PERMISSION_DENIED',
  'CANCELLED',
  'CANCELED',
])

const RETRYABLE_TOOL_CODES = new Set([
  'NETWORK_ERROR',
  'TIMEOUT',
  'TOOL_TIMEOUT',
  'PROCESS_BUSY',
  'RESOURCE_BUSY',
  'BUSY',
  'ETIMEDOUT',
  'ECONNRESET',
  'EAI_AGAIN',
  'STREAM_CLOSED',
])

export function isToolRetryable(error: unknown): boolean {
  if (isCancellationError(error)) return false
  if (error instanceof RetryExhaustedError) return false
  const explicitRetryable = recordOf(error)?.retryable
  if (typeof explicitRetryable === 'boolean') return explicitRetryable
  const code = codeOf(error)
  if (code && NON_RETRYABLE_TOOL_CODES.has(code)) return false
  if (code && RETRYABLE_TOOL_CODES.has(code)) return true
  const statusCode = statusOf(error)
  if (statusCode === 408 || statusCode === 425 || statusCode === 429 || (statusCode !== undefined && statusCode >= 500)) {
    return true
  }
  if (error instanceof ToolError || error instanceof RuntimeError) return error.retryable
  const record = recordOf(error)
  if (record?.retryable !== undefined && typeof record.retryable === 'boolean') {
    return record.retryable
  }
  return error instanceof TypeError
}

function defaultSleep(delayMs: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(new CancellationError('Retry cancelled', signal.reason))
  if (delayMs <= 0) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, delayMs)
    const onAbort = () => {
      clearTimeout(timer)
      reject(new CancellationError('Retry cancelled', signal?.reason))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function calculateDelay(config: RetryLoopConfig, attempt: number, error: unknown): number {
  const retryAfterMs = extractRetryAfterMs(error) ?? extractRetryAfterMs(lastErrorOf(error))
  if (retryAfterMs !== undefined) {
    return Math.min(Math.max(retryAfterMs, 0), config.maxDelayMs)
  }
  const exponential = Math.min(config.baseDelayMs * Math.pow(2, Math.max(0, attempt - 1)), config.maxDelayMs)
  const factor = 1 - config.jitter + Math.random() * 2 * config.jitter
  return Math.min(Math.max(0, Math.round(exponential * factor)), config.maxDelayMs)
}

function emitRetryEvent(
  config: RetryLoopConfig,
  type: RetryEventType,
  attempt: number,
  extra: Omit<RetryEventPayload, 'runId' | 'taskId' | 'attempt' | 'maxAttempts' | 'retryType' | 'retryLayer'> = {},
): void {
  const payload: RetryEventPayload = {
    runId: config.runId,
    taskId: config.taskId,
    attempt,
    maxAttempts: config.maxAttempts,
    retryType: config.retryType,
    retryLayer: config.layer,
    ...extra,
  }
  try {
    config.onEvent?.({ type, payload })
  } catch {
    // Event observers must not change retry control flow.
  }
}

function exhaustedError(error: unknown, maxAttempts: number): RetryExhaustedError {
  return new RetryExhaustedError(`retry exhausted after ${maxAttempts} attempts`, {
    maxAttempts,
    backoffMs: 0,
    code: 'RETRY_EXHAUSTED',
    cause: error,
    lastError: lastErrorOf(error),
  })
}

async function runRetryLoop<T>(
  config: RetryLoopConfig,
  operation: (attempt: number) => Promise<T> | T,
  runOptions: RetryRunOptions,
): Promise<T> {
  let attempt = 1
  let hasRetried = false
  const signal = runOptions.signal ?? config.signal
  const retryType = runOptions.retryType ?? config.retryType
  const effectiveConfig: RetryLoopConfig = { ...config, retryType, signal }
  while (true) {
    if (signal?.aborted) throw new CancellationError('Retry cancelled', signal.reason)
    emitRetryEvent(effectiveConfig, 'attempt.started', attempt)
    try {
      const result = await operation(attempt)
      if (hasRetried) {
        emitRetryEvent(effectiveConfig, 'retry.completed', attempt, { reason: 'retry_succeeded' })
      }
      return result
    } catch (error: unknown) {
      if (isAbortFailure(error, signal)) throw error
      const shouldRetry = runOptions.shouldRetry ?? config.shouldRetry
      const retryable = shouldRetry(error, attempt)
      const reason = messageOf(error)
      emitRetryEvent(effectiveConfig, 'retry.failed', attempt, {
        reason,
        ...(codeOf(error) === undefined ? {} : { errorCode: codeOf(error) }),
        ...(statusOf(error) === undefined ? {} : { statusCode: statusOf(error) }),
      })
      if (!retryable) throw error
      if (attempt >= effectiveConfig.maxAttempts) {
        const terminal = exhaustedError(error, effectiveConfig.maxAttempts)
        emitRetryEvent(effectiveConfig, 'retry.exhausted', effectiveConfig.maxAttempts, {
          reason,
          errorCode: 'RETRY_EXHAUSTED',
          ...(statusOf(error) === undefined ? {} : { statusCode: statusOf(error) }),
        })
        throw terminal
      }
      const delayMs = calculateDelay(effectiveConfig, attempt, error)
      const nextRetryAt = new Date(effectiveConfig.now() + delayMs).toISOString()
      emitRetryEvent(effectiveConfig, 'retry.scheduled', attempt, {
        reason,
        ...(codeOf(error) === undefined ? {} : { errorCode: codeOf(error) }),
        ...(statusOf(error) === undefined ? {} : { statusCode: statusOf(error) }),
        delayMs,
        nextRetryAt,
      })
      await runOptions.onRetry?.(error, attempt)
      await effectiveConfig.sleep(delayMs, signal)
      attempt += 1
      hasRetried = true
      emitRetryEvent(effectiveConfig, 'retry.started', attempt, {
        reason,
        delayMs,
        nextRetryAt,
      })
    }
  }
}

export class ExecutionRetryController {
  readonly maxRetries: number
  readonly maxAttempts: number
  readonly checkpoint: RetryCheckpoint
  readonly #config: RetryLoopConfig
  readonly #options: ExecutionRetryOptions

  constructor(options: ExecutionRetryOptions = {}) {
    this.#options = options
    this.maxRetries = options.maxRetries ?? 8
    this.maxAttempts = this.maxRetries + 1
    this.checkpoint = new RetryCheckpoint()
    this.#config = {
      runId: options.runId ?? 'unknown',
      taskId: options.taskId ?? options.runId ?? 'unknown',
      maxAttempts: this.maxAttempts,
      baseDelayMs: options.baseDelayMs ?? 10,
      maxDelayMs: options.maxDelayMs ?? 30_000,
      jitter: options.jitter ?? 0,
      retryType: options.retryType ?? 'automatic',
      layer: 'task',
      signal: options.signal,
      onEvent: options.onEvent,
      sleep: options.sleep ?? defaultSleep,
      now: options.now ?? Date.now,
      shouldRetry: (error) => isTaskRetryable(error),
    }
  }

  get runId(): string {
    return this.#config.runId
  }

  get taskId(): string {
    return this.#config.taskId
  }

  get completedToolIds(): ReadonlySet<string> {
    return this.checkpoint.completedToolIds
  }

  getCompletedToolIds(): ReadonlySet<string> {
    return this.completedToolIds
  }

  markToolCompleted(toolId: string, result: string, args?: string): void {
    this.checkpoint.markToolCompleted(toolId, result, args)
  }

  isToolCompleted(toolId: string, args?: string): boolean {
    return this.checkpoint.isToolCompleted(toolId, args)
  }

  getToolResult(toolId: string, args?: string): string | undefined {
    return this.checkpoint.getToolResult(toolId, args)
  }

  async run<T>(
    operation: (attempt: number) => Promise<T> | T,
    runOptions: RetryRunOptions = {},
  ): Promise<T> {
    return runRetryLoop(this.#config, operation, { ...this.#options, ...runOptions })
  }

  execute<T>(
    operation: (attempt: number) => Promise<T> | T,
    runOptions: RetryRunOptions = {},
  ): Promise<T> {
    return this.run(operation, runOptions)
  }
}

export class ToolRecoveryController {
  readonly maxRetries: number
  readonly maxAttempts: number
  readonly checkpoint: RetryCheckpoint
  readonly #config: RetryLoopConfig

  constructor(options: ToolRecoveryOptions = {}) {
    this.maxRetries = options.maxRetries ?? 3
    this.maxAttempts = this.maxRetries + 1
    this.checkpoint = options.checkpoint ?? new RetryCheckpoint(
      options.completedToolIds,
      options.completedToolResults,
    )
    this.#config = {
      runId: options.runId ?? 'unknown',
      taskId: options.taskId ?? options.runId ?? 'unknown',
      maxAttempts: this.maxAttempts,
      baseDelayMs: options.baseDelayMs ?? 10,
      maxDelayMs: options.maxDelayMs ?? 30_000,
      jitter: options.jitter ?? 0,
      retryType: options.retryType ?? 'automatic',
      layer: 'tool',
      signal: options.signal,
      onEvent: options.onEvent,
      sleep: options.sleep ?? defaultSleep,
      now: options.now ?? Date.now,
      shouldRetry: isToolRetryable,
    }
  }

  get completedToolIds(): ReadonlySet<string> {
    return this.checkpoint.completedToolIds
  }

  get completedToolResults(): ReadonlyMap<string, string> {
    return this.checkpoint.completedToolResults
  }

  getCompletedToolIds(): ReadonlySet<string> {
    return this.completedToolIds
  }

  getCompletedToolResults(): ReadonlyMap<string, string> {
    return this.completedToolResults
  }

  async run(
    toolId: string,
    operation: () => Promise<string> | string,
    runOptions: ToolRecoveryRunOptions = {},
  ): Promise<string> {
    const cached = this.checkpoint.getToolResult(toolId, runOptions.arguments)
    if (cached !== undefined) return cached
    const result = await runRetryLoop(this.#config, operation, {
      ...this.#config,
      ...runOptions,
    })
    this.checkpoint.markToolCompleted(toolId, result, runOptions.arguments)
    return result
  }

  execute(
    toolId: string,
    operation: () => Promise<string> | string,
    runOptions: ToolRecoveryRunOptions = {},
  ): Promise<string> {
    return this.run(toolId, operation, runOptions)
  }
}
