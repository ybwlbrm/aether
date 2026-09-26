/**
 * SyncError —— 云同步 / 远端命令下发层错误（AEX-P1-003）
 *
 * 同步是**独立故障域**：本机执行成功但推送到 Supabase 失败（离线、RLS 拒绝、
 * 远端命令下发超时），不应被当成 Model / Tool 失败上报，也不该让本机 Run
 * 回滚。单独一个 category 让 UI 能区分"做完了但没同步上"和"没做完"。
 *
 * Transport-agnostic：no Fastify, no SSE, no React, no zod-for-runtime deps.
 */

import { ErrorCode } from './error-code.js';
import { RuntimeError, type RuntimeErrorOptions } from './runtime-error.js';

export interface SyncErrorOptions extends Omit<RuntimeErrorOptions, 'code' | 'category'> {
  /** Override the default error code */
  code?: string;
}

/** 云同步层错误（category: `'sync'`）。 */
export class SyncError extends RuntimeError {
  constructor(message: string, options: SyncErrorOptions) {
    super(message, { ...options, code: options.code ?? ErrorCode.SYNC_ERROR, category: 'sync' });
    this.name = 'SyncError';
    Object.setPrototypeOf(this, SyncError.prototype);
  }

  static isSyncError(value: unknown): value is SyncError {
    return value instanceof SyncError;
  }
}
