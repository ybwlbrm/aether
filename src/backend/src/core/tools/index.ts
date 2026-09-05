/**
 * Core Tools Module — Tool execution infrastructure.
 *
 * Transport-agnostic: no Fastify, no SSE, no React, no zod-for-runtime deps.
 * Pure TypeScript only.
 */

// ToolResult types and helpers
export {
  ToolResult,
  ToolSuccessResult,
  ToolErrorResult,
  ToolPendingApprovalResult,
  ToolTimeoutResult,
  ToolCancelledResult,
  successResult,
  errorResult,
  pendingApprovalResult,
  timeoutResult,
  cancelledResult,
  isSuccessResult,
  isErrorResult,
  isPendingApprovalResult,
  isTimeoutResult,
  isCancelledResult,
} from './tool-result.js';

// ToolPolicy types and class
export {
  ToolPolicyRule,
  PolicyEvaluation,
  ToolPolicy,
} from './tool-policy.js';

// ToolRegistry types and class
export {
  AetherTool,
  ToolRegistry,
} from './tool-registry.js';

// ToolRuntime types, factory, and class
export {
  ToolContext,
  CreateToolContextOptions,
  createToolContext,
  ToolRuntime,
} from './tool-runtime.js';

// ToolTimeoutManager class
export {
  ToolTimeoutManager,
  ExecuteWithTimeoutOptions,
} from './tool-timeout.js';

// ToolExecutor class
export {
  ToolExecutor,
  ToolExecutorOptions,
} from './tool-executor.js';