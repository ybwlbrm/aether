/**
 * ToolError 层次 —— 工具执行层错误（AEX-P1-003）
 *
 * ```
 * ToolError (category: 'tool')
 *  ├─ ToolTransientError  瞬时故障，默认 retryable=true
 *  ├─ ToolPermanentError  永久故障，默认 retryable=false
 *  ├─ ToolTimeoutError    执行超时，默认 retryable=true
 *  └─ ToolCancelledError  被取消，默认 retryable=false
 * ```
 *
 * `ToolError` 基类保留 `retryable ?? false` 的历史默认（既有 tool-executor /
 * tool-registry 抛点行为不变）；需要"可重试"语义时显式用四个子类之一。
 *
 * Transport-agnostic：no Fastify, no SSE, no React, no zod-for-runtime deps.
 */

import { ErrorCode } from './error-code.js';
import { RuntimeError, type RuntimeErrorOptions } from './runtime-error.js';

export interface ToolErrorOptions extends Omit<RuntimeErrorOptions, 'code' | 'category'> {
  /** Name of the tool that failed */
  toolName: string;
  /** Input that was passed to the tool (for debugging) */
  input?: unknown;
  /** Process exit code, if the tool ran as a subprocess */
  exitCode?: number;
  /** Override the default error code */
  code?: string;
}

/**
 * Error raised when a tool execution fails.
 *
 * @example
 * ```ts
 * throw new ToolError('Python script exited with code 1', {
 *   toolName: 'python-runner',
 *   input: { script: 'print(1/0)' },
 *   exitCode: 1,
 * });
 * ```
 */
export class ToolError extends RuntimeError {
  public readonly toolName: string;
  public readonly input?: unknown;
  public readonly exitCode?: number;

  constructor(message: string, options: ToolErrorOptions) {
    super(message, {
      ...options,
      code: options.code ?? ErrorCode.TOOL_ERROR,
      category: 'tool',
      retryable: options.retryable ?? false,
    });

    this.name = 'ToolError';
    this.toolName = options.toolName;
    this.input = options.input;
    this.exitCode = options.exitCode;

    Object.setPrototypeOf(this, ToolError.prototype);
  }

  /**
   * Returns a plain, JSON-serializable object representation.
   */
  override toJSON() {
    const base = super.toJSON();
    return {
      ...base,
      name: this.name,
      toolName: this.toolName,
      input: this.input,
      exitCode: this.exitCode,
    };
  }

  /**
   * Type guard to check if a value is a ToolError.
   */
  static isToolError(value: unknown): value is ToolError {
    return value instanceof ToolError;
  }
}

/** 工具瞬时故障（资源占用、网络）——**默认可重试**。 */
export class ToolTransientError extends ToolError {
  constructor(message: string, options: ToolErrorOptions) {
    super(message, { ...options, code: options.code ?? ErrorCode.TOOL_TRANSIENT, retryable: options.retryable ?? true });
    this.name = 'ToolTransientError';
    Object.setPrototypeOf(this, ToolTransientError.prototype);
  }

  static isToolTransientError(value: unknown): value is ToolTransientError {
    return value instanceof ToolTransientError;
  }
}

/** 工具永久故障（入参非法、权限拒绝、文件不存在）——**默认不可重试**。 */
export class ToolPermanentError extends ToolError {
  constructor(message: string, options: ToolErrorOptions) {
    super(message, { ...options, code: options.code ?? ErrorCode.TOOL_PERMANENT, retryable: options.retryable ?? false });
    this.name = 'ToolPermanentError';
    Object.setPrototypeOf(this, ToolPermanentError.prototype);
  }

  static isToolPermanentError(value: unknown): value is ToolPermanentError {
    return value instanceof ToolPermanentError;
  }
}

/**
 * 工具执行超时——**默认可重试**。
 *
 * 默认 code `ErrorCode.TOOL_TIMEOUT`（= `'TOOL_TIMEOUT'`）正是
 * `core/tools/tool-timeout.ts` 现在抛的码，也正是 `execution-retry.ts` 的
 * `RETRYABLE_TOOL_CODES` 认的码——所以本类可以直接替换该抛点，行为不变。
 */
export class ToolTimeoutError extends ToolError {
  constructor(message: string, options: ToolErrorOptions) {
    super(message, { ...options, code: options.code ?? ErrorCode.TOOL_TIMEOUT, retryable: options.retryable ?? true });
    this.name = 'ToolTimeoutError';
    Object.setPrototypeOf(this, ToolTimeoutError.prototype);
  }

  static isToolTimeoutError(value: unknown): value is ToolTimeoutError {
    return value instanceof ToolTimeoutError;
  }
}

/**
 * 工具执行被取消（Run cancel / 上游 abort）——**默认不可重试**。
 *
 * 取消是用户/上级的明确终止意图，重试等于无视取消。`execution-retry.ts` 的
 * `isToolRetryable` 先读显式 `retryable` 再看 code，因此 false 会被优先采纳。
 */
export class ToolCancelledError extends ToolError {
  constructor(message: string, options: ToolErrorOptions) {
    super(message, { ...options, code: options.code ?? ErrorCode.TOOL_CANCELLED, retryable: options.retryable ?? false });
    this.name = 'ToolCancelledError';
    Object.setPrototypeOf(this, ToolCancelledError.prototype);
  }

  static isToolCancelledError(value: unknown): value is ToolCancelledError {
    return value instanceof ToolCancelledError;
  }
}
