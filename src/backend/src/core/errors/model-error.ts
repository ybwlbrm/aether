/**
 * ModelError — Error class for model/provider-related failures.
 *
 * Transport-agnostic: no Fastify, no SSE, no React, no zod-for-runtime deps.
 * Pure TypeScript only.
 */

import { RuntimeError, RuntimeErrorOptions } from './runtime-error.js';

export interface ModelErrorOptions extends Omit<RuntimeErrorOptions, 'code' | 'retryable'> {
  /** Provider identifier (e.g., 'openai', 'anthropic', 'ollama') */
  provider: string;
  /** Model identifier (e.g., 'gpt-4', 'claude-3-opus') */
  model?: string;
  /** Unix timestamp (ms) when rate limit resets, if applicable */
  rateLimitReset?: number;
  /** HTTP status code from provider, if available */
  statusCode?: number;
  /** Override the default error code */
  code?: string;
  /** Override retryable behavior (defaults to true for rate limits / 5xx) */
  retryable?: boolean;
}

/**
 * Error raised when a model provider request fails.
 *
 * Retryable by default for:
 * - Rate limit errors (statusCode === 429 or rateLimitReset is set)
 * - Server errors (statusCode >= 500)
 *
 * @example
 * ```ts
 * throw new ModelError('Rate limit exceeded', {
 *   provider: 'openai',
 *   model: 'gpt-4',
 *   statusCode: 429,
 *   rateLimitReset: Date.now() + 60000,
 * });
 * ```
 */
export class ModelError extends RuntimeError {
  public readonly provider: string;
  public readonly model?: string;
  public readonly rateLimitReset?: number;
  public readonly statusCode?: number;

  constructor(message: string, options: ModelErrorOptions) {
    const isRateLimit = options.statusCode === 429 || options.rateLimitReset != null;
    const isServerError = options.statusCode != null && options.statusCode >= 500;
    const defaultRetryable = isRateLimit || isServerError;

    super(message, {
      code: options.code ?? 'MODEL_ERROR',
      cause: options.cause,
      context: options.context,
      retryable: options.retryable ?? defaultRetryable,
    });

    this.name = 'ModelError';
    this.provider = options.provider;
    this.model = options.model;
    this.rateLimitReset = options.rateLimitReset;
    this.statusCode = options.statusCode;

    Object.setPrototypeOf(this, ModelError.prototype);
  }

  /**
   * Returns a plain, JSON-serializable object representation.
   */
  override toJSON() {
    const base = super.toJSON();
    return {
      ...base,
      name: this.name,
      provider: this.provider,
      model: this.model,
      rateLimitReset: this.rateLimitReset,
      statusCode: this.statusCode,
    };
  }

  /**
   * Type guard to check if a value is a ModelError.
   */
  static isModelError(value: unknown): value is ModelError {
    return value instanceof ModelError;
  }
}