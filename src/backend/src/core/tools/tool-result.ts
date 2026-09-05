/**
 * ToolResult — Discriminated union for tool execution outcomes.
 *
 * Transport-agnostic: no Fastify, no SSE, no React, no zod-for-runtime deps.
 * Pure TypeScript only.
 */

/**
 * Successful tool execution result.
 */
export interface ToolSuccessResult {
  kind: 'success';
  /** Name of the tool that executed */
  toolName: string;
  /** Tool output (any JSON-serializable value) */
  output: unknown;
  /** Execution duration in milliseconds */
  durationMs: number;
}

/**
 * Tool execution error result.
 */
export interface ToolErrorResult {
  kind: 'error';
  /** Name of the tool that failed */
  toolName: string;
  /** Error details */
  error: {
    /** Human-readable error message */
    message: string;
    /** Optional error code for programmatic handling */
    code?: string;
  };
  /** Execution duration in milliseconds */
  durationMs: number;
}

/**
 * Tool execution pending user approval.
 */
export interface ToolPendingApprovalResult {
  kind: 'pending-approval';
  /** Name of the tool awaiting approval */
  toolName: string;
  /** Unique approval request identifier */
  approvalId: string;
  /** Execution duration in milliseconds (time until approval requested) */
  durationMs: number;
}

/**
 * Tool execution timed out.
 */
export interface ToolTimeoutResult {
  kind: 'timeout';
  /** Name of the tool that timed out */
  toolName: string;
  /** Execution duration in milliseconds (up to timeout) */
  durationMs: number;
}

/**
 * Tool execution cancelled.
 */
export interface ToolCancelledResult {
  kind: 'cancelled';
  /** Name of the tool that was cancelled */
  toolName: string;
  /** Execution duration in milliseconds (up to cancellation) */
  durationMs: number;
}

/**
 * Discriminated union of all possible tool execution results.
 * Use the `kind` field to narrow the type.
 */
export type ToolResult =
  | ToolSuccessResult
  | ToolErrorResult
  | ToolPendingApprovalResult
  | ToolTimeoutResult
  | ToolCancelledResult;

/**
 * Creates a success result.
 */
export function successResult(
  toolName: string,
  output: unknown,
  durationMs: number
): ToolSuccessResult {
  return {
    kind: 'success',
    toolName,
    output,
    durationMs,
  };
}

/**
 * Creates an error result.
 */
export function errorResult(
  toolName: string,
  error: { message: string; code?: string },
  durationMs: number
): ToolErrorResult {
  return {
    kind: 'error',
    toolName,
    error,
    durationMs,
  };
}

/**
 * Creates a pending approval result.
 */
export function pendingApprovalResult(
  toolName: string,
  approvalId: string,
  durationMs: number
): ToolPendingApprovalResult {
  return {
    kind: 'pending-approval',
    toolName,
    approvalId,
    durationMs,
  };
}

/**
 * Creates a timeout result.
 */
export function timeoutResult(
  toolName: string,
  durationMs: number
): ToolTimeoutResult {
  return {
    kind: 'timeout',
    toolName,
    durationMs,
  };
}

/**
 * Creates a cancelled result.
 */
export function cancelledResult(
  toolName: string,
  durationMs: number
): ToolCancelledResult {
  return {
    kind: 'cancelled',
    toolName,
    durationMs,
  };
}

/**
 * Type guard to check if a ToolResult is a success.
 */
export function isSuccessResult(result: ToolResult): result is ToolSuccessResult {
  return result.kind === 'success';
}

/**
 * Type guard to check if a ToolResult is an error.
 */
export function isErrorResult(result: ToolResult): result is ToolErrorResult {
  return result.kind === 'error';
}

/**
 * Type guard to check if a ToolResult is pending approval.
 */
export function isPendingApprovalResult(result: ToolResult): result is ToolPendingApprovalResult {
  return result.kind === 'pending-approval';
}

/**
 * Type guard to check if a ToolResult is a timeout.
 */
export function isTimeoutResult(result: ToolResult): result is ToolTimeoutResult {
  return result.kind === 'timeout';
}

/**
 * Type guard to check if a ToolResult is cancelled.
 */
export function isCancelledResult(result: ToolResult): result is ToolCancelledResult {
  return result.kind === 'cancelled';
}