/**
 * RuntimeError — Base error class for all core runtime errors.
 *
 * Transport-agnostic: no Fastify, no SSE, no React, no zod-for-runtime deps.
 * Pure TypeScript only.
 */

export interface RuntimeErrorOptions {
  /** Machine-readable error code (e.g., 'MODEL_ERROR', 'TOOL_ERROR', 'RETRY_EXHAUSTED') */
  code: string;
  /** Original cause (Error, string, or any value) */
  cause?: unknown;
  /** Additional structured context for debugging/telemetry */
  context?: Record<string, unknown>;
  /** Whether the operation can be retried */
  retryable?: boolean;
}

/**
 * Serializable representation of a RuntimeError for logging/transport.
 */
export interface RuntimeErrorJSON {
  name: string;
  message: string;
  code: string;
  retryable: boolean;
  context?: Record<string, unknown>;
  cause?: string;
  stack?: string;
}

/**
 * Base runtime error with structured metadata.
 *
 * @example
 * ```ts
 * throw new RuntimeError('Database connection failed', {
 *   code: 'DB_CONNECTION_FAILED',
 *   cause: originalError,
 *   context: { host: 'localhost', port: 5432 },
 *   retryable: true,
 * });
 * ```
 */
export class RuntimeError extends Error {
  public readonly code: string;
  public readonly cause?: unknown;
  public readonly context?: Record<string, unknown>;
  public readonly retryable: boolean;

  constructor(message: string, options: RuntimeErrorOptions) {
    super(message);
    this.name = 'RuntimeError';
    this.code = options.code;
    this.cause = options.cause;
    this.context = options.context;
    this.retryable = options.retryable ?? false;

    // Maintain proper prototype chain for instanceof checks
    Object.setPrototypeOf(this, RuntimeError.prototype);
  }

  /**
   * Returns a plain, JSON-serializable object representation.
   * The cause is stringified to avoid circular references.
   */
  toJSON(): RuntimeErrorJSON {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      retryable: this.retryable,
      context: this.context,
      cause: this.cause instanceof Error ? this.cause.message : this.cause != null ? String(this.cause) : undefined,
      stack: this.stack,
    };
  }

  /**
   * Type guard to check if a value is a RuntimeError.
   */
  static isRuntimeError(value: unknown): value is RuntimeError {
    return value instanceof RuntimeError;
  }
}