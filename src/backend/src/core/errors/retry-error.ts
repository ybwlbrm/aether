/**
 * RetryError & RetryExhaustedError — Errors for retry logic.
 *
 * Transport-agnostic: no Fastify, no SSE, no React, no zod-for-runtime deps.
 * Pure TypeScript only.
 */

import { ErrorCode } from './error-code.js'
import { AetherError, RuntimeError } from './runtime-error.js'
import type { RuntimeErrorOptions } from './runtime-error.js'

export interface RetryErrorOptions extends Omit<RuntimeErrorOptions, 'code'> {
  /** Current attempt number (1-indexed) */
  attempt: number
  /** Maximum number of attempts allowed */
  maxAttempts: number
  /** Backoff in milliseconds before next retry */
  backoffMs: number
  /** Override the default error code */
  code?: string
  /** Override the error category; defaults to 'execution'（重试编排属于执行层） */
  category?: RuntimeErrorOptions['category']
  /** Override retryable (default: true for RetryError, false for RetryExhaustedError) */
  retryable?: boolean
}

export interface RetryLastErrorJSON {
  name: string
  message: string
  code?: string
  statusCode?: number
}

export type RetryExhaustedErrorOptions = Omit<RetryErrorOptions, 'attempt' | 'retryable' | 'backoffMs'> & {
  /** The final underlying failure that caused retries to stop. */
  lastError?: unknown
  /** Backoff metadata; terminal errors default to zero. */
  backoffMs?: number
}

function serializeLastError(value: unknown): RetryLastErrorJSON | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value !== 'object') {
    return { name: 'Error', message: String(value) }
  }
  const record = value as Record<string, unknown>
  const message = typeof record.message === 'string' ? record.message : String(value)
  const name = typeof record.name === 'string' ? record.name : 'Error'
  const code = typeof record.code === 'string' ? record.code : undefined
  const statusCode = typeof record.statusCode === 'number' ? record.statusCode : undefined
  return { name, message, code, statusCode }
}

/**
 * Error raised when an operation is being retried.
 * This is a signal to the caller that a retry will be attempted.
 *
 * @example
 * ```ts
 * throw new RetryError('Transient network error', {
 *   attempt: 2,
 *   maxAttempts: 3,
 *   backoffMs: 1000,
 * });
 * ```
 */
export class RetryError extends RuntimeError {
  public readonly attempt: number;
  public readonly maxAttempts: number;
  public readonly backoffMs: number;

  constructor(message: string, options: RetryErrorOptions) {
    super(message, {
      ...options,
      code: options.code ?? ErrorCode.RETRY_ERROR,
      category: options.category ?? 'execution',
      retryable: options.retryable ?? true, // RetryError is retryable by default
    });

    this.name = 'RetryError';
    this.attempt = options.attempt;
    this.maxAttempts = options.maxAttempts;
    this.backoffMs = options.backoffMs;

    Object.setPrototypeOf(this, RetryError.prototype);
  }

  /**
   * Returns a plain, JSON-serializable object representation.
   */
  override toJSON() {
    const base = super.toJSON();
    return {
      ...base,
      name: this.name,
      attempt: this.attempt,
      maxAttempts: this.maxAttempts,
      backoffMs: this.backoffMs,
    };
  }

  /**
   * Type guard to check if a value is a RetryError.
   */
  static isRetryError(value: unknown): value is RetryError {
    return value instanceof RetryError;
  }

  /**
   * Checks if the retry is exhausted (attempt === maxAttempts).
   */
  isExhausted(): boolean {
    return this.attempt >= this.maxAttempts;
  }
}

/**
 * Error raised when all retry attempts have been exhausted.
 * This is a terminal error — not retryable.
 *
 * @example
 * ```ts
 * throw new RetryExhaustedError('All 3 attempts failed', {
 *   attempt: 3,
 *   maxAttempts: 3,
 *   backoffMs: 1000,
 * });
 * ```
 */
export class RetryExhaustedError extends RetryError {
  public readonly lastError: unknown

  constructor(message: string, options: RetryExhaustedErrorOptions) {
    super(message, {
      ...options,
      attempt: options.maxAttempts,
      backoffMs: options.backoffMs ?? 0,
      retryable: false,
      cause: options.cause ?? options.lastError,
    })

    this.name = 'RetryExhaustedError'
    this.lastError = options.lastError ?? options.cause
    Object.setPrototypeOf(this, RetryExhaustedError.prototype)
  }

  /**
   * Returns a plain, JSON-serializable object representation.
   */
  override toJSON() {
    const base = super.toJSON()
    return {
      ...base,
      name: this.name,
      exhausted: true,
      lastError: serializeLastError(this.lastError),
    }
  }

  /**
   * Type guard to check if a value is a RetryExhaustedError.
   */
  static isRetryExhaustedError(value: unknown): value is RetryExhaustedError {
    return value instanceof RetryExhaustedError
  }
}

/**
 * Type guard to determine if an error is retryable.
 *
 * 单一事实源：重试与否由 `AetherError.retryable` 决定，而每个子类在构造时
 * 就把自己的默认语义固化进这个字段（ModelTransient=true / ModelPermanent=false
 * / ModelStream=true / ToolTimeout=true / ToolCancelled=false / BudgetExceeded=
 * false / AttemptFailed=true …）。因此这里不需要按类型枚举，新增子类自动生效。
 *
 * Returns true for:
 * - Any AetherError (incl. RuntimeError / ModelError / ToolError subclasses)
 *   whose `retryable === true`
 * - RetryError (always retryable)
 *
 * Returns false for:
 * - RetryExhaustedError (terminal, even if retryable was forced)
 * - ModelError 4xx (non-429) / ToolError / WorkflowError / SyncError by default
 * - Any non-Aether value, including null/undefined and random objects
 *
 * @example
 * ```ts
 * if (isRetryable(err)) {
 *   await retryWithBackoff(fn, err);
 * }
 * ```
 */
export function isRetryable(err: unknown): boolean {
  // RetryExhaustedError is terminal regardless of the flag
  if (RetryExhaustedError.isRetryExhaustedError(err)) return false
  return AetherError.isAetherError(err) ? err.retryable : false
}