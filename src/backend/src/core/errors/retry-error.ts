/**
 * RetryError & RetryExhaustedError — Errors for retry logic.
 *
 * Transport-agnostic: no Fastify, no SSE, no React, no zod-for-runtime deps.
 * Pure TypeScript only.
 */

import { RuntimeError, RuntimeErrorOptions } from './runtime-error.js';
import { ModelError } from './model-error.js';

export interface RetryErrorOptions extends Omit<RuntimeErrorOptions, 'code'> {
  /** Current attempt number (1-indexed) */
  attempt: number;
  /** Maximum number of attempts allowed */
  maxAttempts: number;
  /** Backoff in milliseconds before next retry */
  backoffMs: number;
  /** Override the default error code */
  code?: string;
  /** Override retryable (default: true for RetryError, false for RetryExhaustedError) */
  retryable?: boolean;
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
      code: options.code ?? 'RETRY_ERROR',
      cause: options.cause,
      context: options.context,
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
  constructor(message: string, options: Omit<RetryErrorOptions, 'attempt'>) {
    super(message, {
      ...options,
      attempt: options.maxAttempts,
      retryable: false, // RetryExhaustedError is NOT retryable
    });

    this.name = 'RetryExhaustedError';

    Object.setPrototypeOf(this, RetryExhaustedError.prototype);
  }

  /**
   * Returns a plain, JSON-serializable object representation.
   */
  override toJSON() {
    const base = super.toJSON();
    return {
      ...base,
      name: this.name,
      exhausted: true,
    };
  }

  /**
   * Type guard to check if a value is a RetryExhaustedError.
   */
  static isRetryExhaustedError(value: unknown): value is RetryExhaustedError {
    return value instanceof RetryExhaustedError;
  }
}

/**
 * Type guard to determine if an error is retryable.
 *
 * Returns true for:
 * - RuntimeError with retryable === true
 * - ModelError with rate-limit (statusCode 429) or 5xx status
 * - RetryError (always retryable)
 * - RetryExhaustedError (NOT retryable — returns false)
 *
 * Returns false for:
 * - ToolError (never retryable by default)
 * - Any other error type
 * - null/undefined
 *
 * @example
 * ```ts
 * if (isRetryable(err)) {
 *   await retryWithBackoff(fn, err);
 * }
 * ```
 */
export function isRetryable(err: unknown): boolean {
  if (err instanceof RetryError) {
    // RetryError is retryable, but RetryExhaustedError is not
    return !RetryExhaustedError.isRetryExhaustedError(err);
  }
  if (err instanceof ModelError) {
    // ModelError handles its own retryable logic in constructor
    return err.retryable;
  }
  if (err instanceof RuntimeError) {
    return err.retryable;
  }
  return false;
}