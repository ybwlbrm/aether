/**
 * Core Errors Module — Transport-agnostic error hierarchy.
 *
 * This module provides a structured error hierarchy for the core runtime:
 * - RuntimeError: Base class with code, cause, context, retryable flag
 * - ModelError: Provider/model failures (rate limits, 5xx = retryable)
 * - ToolError: Tool execution failures (exit codes, input capture)
 * - RetryError: Transient failures with attempt/backoff metadata
 * - RetryExhaustedError: Terminal error after max retries
 * - isRetryable(): Pure helper for retry policy decisions
 *
 * Zero external runtime dependencies. Pure TypeScript only.
 */

export {
  RuntimeError,
  type RuntimeErrorOptions,
  type RuntimeErrorJSON,
} from './runtime-error.js';

export {
  ModelError,
  type ModelErrorOptions,
} from './model-error.js';

export {
  ToolError,
  type ToolErrorOptions,
} from './tool-error.js';

export {
  RetryError,
  RetryExhaustedError,
  type RetryErrorOptions,
  isRetryable,
} from './retry-error.js';