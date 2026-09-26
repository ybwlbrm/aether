/**
 * ModelError 层次 —— Provider / Model 层错误（AEX-P1-003）
 *
 * ```
 * ModelError (category: 'model')
 *  ├─ ModelTransientError  瞬时故障，默认 retryable=true
 *  ├─ ModelPermanentError  永久故障，默认 retryable=false
 *  ├─ ModelTimeoutError    请求超时，默认 retryable=true
 *  └─ ModelStreamError     流截断/连接重置，默认 retryable=true
 * ```
 *
 * 四个子类存在的唯一理由是让"可重试与否"由**类型**决定，而不是由每个调用点
 * 传 `retryable: true/false` 传错（P1-085：错误分类要能被程序读，不能靠人记）。
 * 显式传 `retryable` 仍然覆盖默认值（provider-adapter 需要按 statusCode 覆盖）。
 *
 * Transport-agnostic：no Fastify, no SSE, no React, no zod-for-runtime deps.
 */

import { ErrorCode } from './error-code.js';
import { RuntimeError, type RuntimeErrorOptions } from './runtime-error.js';

export interface ModelErrorOptions extends Omit<RuntimeErrorOptions, 'code' | 'retryable' | 'category'> {
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
      ...options,
      code: options.code ?? ErrorCode.MODEL_ERROR,
      category: 'model',
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

/**
 * 瞬时模型故障（网络抖动、Provider 5xx、熔断冷却后恢复）——**默认可重试**。
 *
 * 重试有意义：同样的请求下一次很可能成功。
 */
export class ModelTransientError extends ModelError {
  constructor(message: string, options: ModelErrorOptions) {
    super(message, {
      ...options,
      code: options.code ?? ErrorCode.MODEL_TRANSIENT,
      retryable: options.retryable ?? true,
    });
    this.name = 'ModelTransientError';
    Object.setPrototypeOf(this, ModelTransientError.prototype);
  }

  static isModelTransientError(value: unknown): value is ModelTransientError {
    return value instanceof ModelTransientError;
  }
}

/**
 * 永久模型故障（鉴权失败、上下文超限、请求非法）——**默认不可重试**。
 *
 * 重试无意义且危险：同样的请求会再次失败，只会把凭据/配额问题藏起来。
 * `provider-adapter` 的 4xx（非 429）路径应改抛本类。
 */
export class ModelPermanentError extends ModelError {
  constructor(message: string, options: ModelErrorOptions) {
    super(message, {
      ...options,
      code: options.code ?? ErrorCode.MODEL_PERMANENT,
      retryable: options.retryable ?? false,
    });
    this.name = 'ModelPermanentError';
    Object.setPrototypeOf(this, ModelPermanentError.prototype);
  }

  static isModelPermanentError(value: unknown): value is ModelPermanentError {
    return value instanceof ModelPermanentError;
  }
}

/**
 * 模型请求超时——**默认可重试**。
 *
 * 超时的根因通常在对端排队或本地网络，而非请求本身；重试有意义。
 */
export class ModelTimeoutError extends ModelError {
  constructor(message: string, options: ModelErrorOptions) {
    super(message, {
      ...options,
      code: options.code ?? ErrorCode.MODEL_TIMEOUT,
      retryable: options.retryable ?? true,
    });
    this.name = 'ModelTimeoutError';
    Object.setPrototypeOf(this, ModelTimeoutError.prototype);
  }

  static isModelTimeoutError(value: unknown): value is ModelTimeoutError {
    return value instanceof ModelTimeoutError;
  }
}

/**
 * 流被截断 / 连接重置（EOF 未见 `[DONE]` 或 `finish_reason`）——**默认可重试**。
 *
 * 默认 code 为 `ErrorCode.MODEL_STREAM_CLOSED`，其 wire 值仍是仓库既有的
 * `'STREAM_CLOSED'`：`retry-policy.ts` 的 `defaultRetryable` 与
 * `execution-retry.ts` 的 `RETRYABLE_TOOL_CODES` 都按该字面量把它判为可重试，
 * 改字面量会静默改变重试行为，因此这里只对齐规范名、不动 wire 值。
 *
 * provider-adapter 的 `streamClosedError()` 是本类的目标产地（当前仍在并行
 * 修改中，故此处不改动该文件）。
 */
export class ModelStreamError extends ModelError {
  constructor(message: string, options: ModelErrorOptions) {
    super(message, {
      ...options,
      code: options.code ?? ErrorCode.MODEL_STREAM_CLOSED,
      retryable: options.retryable ?? true,
    });
    this.name = 'ModelStreamError';
    Object.setPrototypeOf(this, ModelStreamError.prototype);
  }

  static isModelStreamError(value: unknown): value is ModelStreamError {
    return value instanceof ModelStreamError;
  }
}
