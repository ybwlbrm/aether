/**
 * AetherError — 全局唯一错误基类（AEX-P1-003）
 *
 * 规范：单一错误层次
 * ```
 * AetherError
 *  └─ RuntimeError            (legacy 基类，category 默认 'runtime')
 *      ├─ ModelError          (category: 'model')
 *      ├─ ToolError           (category: 'tool')
 *      ├─ ExecutionError      (category: 'execution')
 *      ├─ WorkflowError       (category: 'workflow')
 *      ├─ SyncError           (category: 'sync')
 *      ├─ RetryError          (category: 'execution')
 *      └─ ProviderCredentialError (category: 'model')
 * ```
 *
 * 每个错误统一暴露 6 个契约字段：`code`（程序用）/ `message`（人用）/
 * `category`（错误分类）/ `retryable`（是否可重试）/ `cause`（原始异常）/
 * `metadata`（结构化上下文）。
 *
 * **`metadata` 与 legacy `context` 是同一份存储**：老代码用 `context`，规范用
 * `metadata`，两者都读同一个 record（`err.metadata === err.context`），不制造
 * 第二份事实。两个都传时合并，`metadata` 覆盖同名键。
 *
 * Transport-agnostic：no Fastify, no SSE, no React, no zod-for-runtime deps.
 */

import type { ErrorCategory } from './error-code.js';

export interface AetherErrorOptions {
  /** 机器可读错误码（供控制流判断，见 error-code.ts） */
  code: string;
  /** 错误分类（见 ERROR_CATEGORIES） */
  category: ErrorCategory;
  /** 原始异常（Error、字符串或任意值） */
  cause?: unknown;
  /** legacy 别名：结构化上下文。与 metadata 同一份存储。 */
  context?: Record<string, unknown>;
  /** 结构化上下文（规范字段） */
  metadata?: Record<string, unknown>;
  /** 是否可重试（默认 false） */
  retryable?: boolean;
}

/** AetherError 的可序列化投影。`context` / `metadata` 值相同，均为可选。 */
export interface AetherErrorJSON {
  name: string;
  message: string;
  code: string;
  category: ErrorCategory;
  retryable: boolean;
  context?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  cause?: string;
  stack?: string;
}

/** 合并 legacy `context` 与规范 `metadata`；两者皆无时返回 undefined（不留空对象噪声）。 */
function mergeMetadata(
  context: Record<string, unknown> | undefined,
  metadata: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (context === undefined && metadata === undefined) return undefined;
  return { ...(context ?? {}), ...(metadata ?? {}) };
}

/**
 * 全局唯一错误基类。
 *
 * @example
 * ```ts
 * throw new AetherError('供应商连接失败', {
 *   code: ErrorCode.PROVIDER_UNAVAILABLE,
 *   category: 'model',
 *   cause: originalError,
 *   metadata: { provider: 'openai', host: 'api.openai.com' },
 *   retryable: true,
 * });
 * ```
 */
export class AetherError extends Error {
  public readonly code: string;
  public readonly category: ErrorCategory;
  public readonly retryable: boolean;
  public readonly cause?: unknown;
  public readonly metadata?: Record<string, unknown>;
  /** legacy 别名，与 {@link metadata} 指向同一对象 */
  public readonly context?: Record<string, unknown>;

  constructor(message: string, options: AetherErrorOptions) {
    super(message);
    this.name = 'AetherError';
    this.code = options.code;
    this.category = options.category;
    this.retryable = options.retryable ?? false;
    this.cause = options.cause;
    this.metadata = mergeMetadata(options.context, options.metadata);
    this.context = this.metadata;

    // 维持 instanceof 链
    Object.setPrototypeOf(this, AetherError.prototype);
  }

  /**
   * 返回纯 JSON 可序列化投影。cause 被字符串化以避免循环引用。
   */
  toJSON(): AetherErrorJSON {
    return {
      name: this.name,
      message: this.message,
      code: this.code,
      category: this.category,
      retryable: this.retryable,
      context: this.context,
      metadata: this.metadata,
      cause: this.cause instanceof Error ? this.cause.message : this.cause != null ? String(this.cause) : undefined,
      stack: this.stack,
    };
  }

  /** 类型守卫：判断某个值是否属于 Aether 错误体系。 */
  static isAetherError(value: unknown): value is AetherError {
    return value instanceof AetherError;
  }
}

export interface RuntimeErrorOptions extends Omit<AetherErrorOptions, 'category'> {
  /** 错误分类；缺省为 legacy 的 `'runtime'` 桶 */
  category?: ErrorCategory;
}

/**
 * legacy 基类 —— 保持向后兼容的唯一入口。
 *
 * 全仓库约 25 处 `new RuntimeError(msg, { code, context, retryable })` 走这里。
 * 它现在继承 AetherError，因此 `RuntimeError.isRuntimeError(x)` 对 ModelError /
 * ToolError 等派生类同样返回 true（既有 instanceof 格完全不变），同时新增了
 * `category` / `metadata` 两个规范字段。
 */
export class RuntimeError extends AetherError {
  constructor(message: string, options: RuntimeErrorOptions) {
    super(message, { ...options, category: options.category ?? 'runtime' });
    this.name = 'RuntimeError';

    // 维持 instanceof 链
    Object.setPrototypeOf(this, RuntimeError.prototype);
  }

  /** 类型守卫：判断某个值是否属于 RuntimeError 层次（含 ModelError / ToolError …）。 */
  static isRuntimeError(value: unknown): value is RuntimeError {
    return value instanceof RuntimeError;
  }
}

/**
 * legacy 名字保留：`RuntimeErrorJSON` 现为 `AetherErrorJSON` 的别名，
 * 两者结构同一份定义，不存在两份 JSON 契约。
 */
export type RuntimeErrorJSON = AetherErrorJSON;
