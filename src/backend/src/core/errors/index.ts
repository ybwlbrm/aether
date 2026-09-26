/**
 * Core Errors Module — Transport-agnostic error hierarchy.
 *
 * 单一错误层次（AEX-P1-003）：
 * ```
 * AetherError                       code / category / retryable / cause / message / metadata
 *  └─ RuntimeError                  legacy 基类（category 缺省 'runtime'）
 *      ├─ ModelError                'model'
 *      │   ├─ ModelTransientError   MODEL_TRANSIENT   retryable=true
 *      │   ├─ ModelPermanentError   MODEL_PERMANENT   retryable=false
 *      │   ├─ ModelTimeoutError     MODEL_TIMEOUT     retryable=true
 *      │   └─ ModelStreamError      STREAM_CLOSED     retryable=true
 *      ├─ ToolError                 'tool'
 *      │   ├─ ToolTransientError    TOOL_TRANSIENT    retryable=true
 *      │   ├─ ToolPermanentError    TOOL_PERMANENT    retryable=false
 *      │   ├─ ToolTimeoutError      TOOL_TIMEOUT      retryable=true
 *      │   └─ ToolCancelledError    TOOL_CANCELLED    retryable=false
 *      ├─ ExecutionError            'execution'
 *      │   ├─ VerificationError     VERIFICATION_FAILED  retryable 随 verdict 变
 *      │   ├─ BudgetExceededError   BUDGET_EXCEEDED     retryable=false
 *      │   └─ AttemptFailedError    ATTEMPT_FAILED      retryable=true
 *      ├─ WorkflowError             'workflow'
 *      ├─ SyncError                 'sync'
 *      ├─ RetryError                'execution'  ├─ RetryExhaustedError
 *      └─ ProviderCredentialError   'model'
 * ```
 *
 * P1-085：错误控制流一律用 `err.code === ErrorCode.X`，禁止 `message.includes`。
 * `ErrorCode` 常量表见 `./error-code.js`（backend 错误码唯一事实源）。
 *
 * Zero external runtime dependencies. Pure TypeScript only.
 */

export { ErrorCode, ERROR_CATEGORIES, type ErrorCategory } from './error-code.js';

export {
  AetherError,
  RuntimeError,
  type AetherErrorOptions,
  type AetherErrorJSON,
  type RuntimeErrorOptions,
  type RuntimeErrorJSON,
} from './runtime-error.js';

export {
  ModelError,
  ModelTransientError,
  ModelPermanentError,
  ModelTimeoutError,
  ModelStreamError,
  type ModelErrorOptions,
} from './model-error.js';

export {
  ToolError,
  ToolTransientError,
  ToolPermanentError,
  ToolTimeoutError,
  ToolCancelledError,
  type ToolErrorOptions,
} from './tool-error.js';

export {
  ExecutionError,
  VerificationError,
  BudgetExceededError,
  AttemptFailedError,
  type ExecutionErrorOptions,
  type VerificationVerdict,
  type VerificationErrorOptions,
} from './execution-error.js';

export { WorkflowError, type WorkflowErrorOptions } from './workflow-error.js';

export { SyncError, type SyncErrorOptions } from './sync-error.js';

export {
  RetryError,
  RetryExhaustedError,
  type RetryErrorOptions,
  type RetryExhaustedErrorOptions,
  type RetryLastErrorJSON,
  isRetryable,
} from './retry-error.js';

export {
  ProviderCredentialError,
} from './provider-credential-error.js';
