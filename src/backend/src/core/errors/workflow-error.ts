/**
 * WorkflowError —— 工作流编排层错误（AEX-P1-003）
 *
 * 节点图非法、节点执行失败、并行分支汇合失败等**编排层**问题，与 Model / Tool
 * 执行失败区分开：同一个失败发生在工作流节点里和在单次对话里，归属方不同
 * （编排器 vs 执行器），排查路径也不同。
 *
 * Transport-agnostic：no Fastify, no SSE, no React, no zod-for-runtime deps.
 */

import { ErrorCode } from './error-code.js';
import { RuntimeError, type RuntimeErrorOptions } from './runtime-error.js';

export interface WorkflowErrorOptions extends Omit<RuntimeErrorOptions, 'code' | 'category'> {
  /** Override the default error code */
  code?: string;
}

/** 工作流编排层错误（category: `'workflow'`）。 */
export class WorkflowError extends RuntimeError {
  constructor(message: string, options: WorkflowErrorOptions) {
    super(message, { ...options, code: options.code ?? ErrorCode.WORKFLOW_ERROR, category: 'workflow' });
    this.name = 'WorkflowError';
    Object.setPrototypeOf(this, WorkflowError.prototype);
  }

  static isWorkflowError(value: unknown): value is WorkflowError {
    return value instanceof WorkflowError;
  }
}
