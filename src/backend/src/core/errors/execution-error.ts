/**
 * ExecutionError 层次 —— 执行循环层错误（AEX-P1-003）
 *
 * ```
 * ExecutionError (category: 'execution')
 *  ├─ VerificationError     验证未通过 / 未能完成
 *  ├─ BudgetExceededError   预算耗尽（终态）
 *  └─ AttemptFailedError    单次尝试失败（多尝试循环中的一次）
 * ```
 *
 * Transport-agnostic：no Fastify, no SSE, no React, no zod-for-runtime deps.
 */

import { ErrorCode } from './error-code.js';
import { RuntimeError, type RuntimeErrorOptions } from './runtime-error.js';

export interface ExecutionErrorOptions extends Omit<RuntimeErrorOptions, 'code' | 'category'> {
  /** Override the default error code */
  code?: string;
}

/** 执行层错误基类：验证、预算、尝试编排层面的失败。 */
export class ExecutionError extends RuntimeError {
  constructor(message: string, options: ExecutionErrorOptions) {
    super(message, {
      ...options,
      code: options.code ?? ErrorCode.EXECUTION_ERROR,
      category: 'execution',
    });
    this.name = 'ExecutionError';
    Object.setPrototypeOf(this, ExecutionError.prototype);
  }

  static isExecutionError(value: unknown): value is ExecutionError {
    return value instanceof ExecutionError;
  }
}

/**
 * 验证判定结果。
 *
 * - `failed` —— 验证**跑完了**，结论是不通过。
 * - `indeterminate` —— 验证**没跑完**（外部依赖抖动、探针超时、结果不可读）。
 */
export type VerificationVerdict = 'failed' | 'indeterminate';

export interface VerificationErrorOptions extends ExecutionErrorOptions {
  /** 判定结果；缺省 `'failed'` */
  verdict?: VerificationVerdict;
}

/**
 * 验证未通过。
 *
 * **retryable 由 verdict 决定，而不是拍一个固定值**——理由：
 * 两者重试的收益完全相反，混成一个默认值必然有一半是错的。
 *
 * - `verdict: 'failed'`（默认）→ `retryable = false`。验证已经给出确定结论
 *   "这次产物不达标"，同一次尝试重跑得到的是同一批输入 + 同一个模型，大概率
 *   同样不达标；重试只是空转消耗预算。此时应该换策略（拆解任务 / 改提示 /
 *   人工介入），不是重试。
 * - `verdict: 'indeterminate'` → `retryable = true`。根因是验证器自身的外部
 *   依赖抖动（网络探针超时、文件尚未落盘），产物本身没问题；重跑验证成本低、
 *   成功率高等于重跑产物。
 *
 * 换句话说：**验证器失败可重试，验证结论不可重试。**
 */
export class VerificationError extends ExecutionError {
  public readonly verdict: VerificationVerdict;

  constructor(message: string, options: VerificationErrorOptions) {
    const verdict = options.verdict ?? 'failed';
    super(message, {
      ...options,
      code: options.code ?? ErrorCode.VERIFICATION_FAILED,
      // 验证器失败可重试，验证结论不可重试（理由见上方注释）
      retryable: options.retryable ?? verdict === 'indeterminate',
    });
    this.name = 'VerificationError';
    this.verdict = verdict;
    Object.setPrototypeOf(this, VerificationError.prototype);
  }

  override toJSON() {
    return { ...super.toJSON(), name: this.name, verdict: this.verdict };
  }

  static isVerificationError(value: unknown): value is VerificationError {
    return value instanceof VerificationError;
  }
}

/**
 * 预算耗尽（token / 金额 / 时长）——**终态，默认不可重试**。
 *
 * 预算的上限由用户或策略设定，不是故障；在没有用户介入提高上限的情况下重试
 * 必然再次触顶。花费/上限等信息放 `metadata`。
 */
export class BudgetExceededError extends ExecutionError {
  constructor(message: string, options: ExecutionErrorOptions) {
    super(message, { ...options, code: options.code ?? ErrorCode.BUDGET_EXCEEDED, retryable: options.retryable ?? false });
    this.name = 'BudgetExceededError';
    Object.setPrototypeOf(this, BudgetExceededError.prototype);
  }

  static isBudgetExceededError(value: unknown): value is BudgetExceededError {
    return value instanceof BudgetExceededError;
  }
}

/**
 * 单次尝试失败——**默认可重试**。
 *
 * 语义是"多尝试循环里的这一次没成"，交给 `ExecutionRetryController` 决定是否
 * 还有下一次尝试（上限由 maxAttempts 管），因此它本身必须标为可重试，否则
 * 第一次抖动就会把整个 Run 判死。
 */
export class AttemptFailedError extends ExecutionError {
  constructor(message: string, options: ExecutionErrorOptions) {
    super(message, { ...options, code: options.code ?? ErrorCode.ATTEMPT_FAILED, retryable: options.retryable ?? true });
    this.name = 'AttemptFailedError';
    Object.setPrototypeOf(this, AttemptFailedError.prototype);
  }

  static isAttemptFailedError(value: unknown): value is AttemptFailedError {
    return value instanceof AttemptFailedError;
  }
}
