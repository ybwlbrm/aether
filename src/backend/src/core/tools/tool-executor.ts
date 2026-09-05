/**
 * ToolExecutor — Executes tools with policy, validation, and timeout.
 *
 * Transport-agnostic: no Fastify, no SSE, no React, no zod-for-runtime deps.
 * Pure TypeScript only.
 */

import type { z } from 'zod';
import { ToolError } from '../errors/index.js';
import { CancellationError, isCancellationError } from '../runtime/index.js';
import type { ToolRegistry, AetherTool } from './tool-registry.js';
import type { ToolPolicy } from './tool-policy.js';
import type { ToolContext } from './tool-runtime.js';
import type { ToolResult } from './tool-result.js';
import {
  successResult,
  errorResult,
  pendingApprovalResult,
  timeoutResult,
  cancelledResult,
} from './tool-result.js';
import { ToolTimeoutManager } from './tool-timeout.js';
import { ToolPolicy as ToolPolicyImpl } from './tool-policy.js';

/**
 * Options for ToolExecutor constructor.
 */
export interface ToolExecutorOptions {
  /** Policy for tool execution control */
  policy?: ToolPolicy;
  /** Default timeout in milliseconds */
  defaultTimeoutMs?: number;
}

/**
 * ToolExecutor — Orchestrates tool execution with policy, validation, timeout, and error handling.
 */
export class ToolExecutor {
  #registry: ToolRegistry;
  #policy: ToolPolicy;
  #timeoutManager: ToolTimeoutManager;

  /**
   * Creates a new ToolExecutor.
   *
   * @param registry - Tool registry
   * @param options - Executor options
   */
  constructor(registry: ToolRegistry, options: ToolExecutorOptions = {}) {
    this.#registry = registry;
    this.#policy = options.policy ?? new ToolPolicyImpl();
    this.#timeoutManager = new ToolTimeoutManager(options.defaultTimeoutMs);
  }

  /**
   * Executes a tool by name with the given input and context.
   *
   * @param toolName - Name of the tool to execute
   * @param input - Input to pass to the tool
   * @param context - Execution context
   * @returns Tool execution result
   */
  async execute(toolName: string, input: unknown, context: ToolContext): Promise<ToolResult> {
    const startTime = Date.now();

    // Lookup tool
    const tool = this.#registry.get(toolName);
    if (!tool) {
      const durationMs = Date.now() - startTime;
      return errorResult(toolName, {
        message: `Tool '${toolName}' not found`,
        code: 'TOOL_NOT_FOUND',
      }, durationMs);
    }

    // Evaluate policy
    const policyResult = this.#policy.evaluate(toolName);
    if (policyResult.action === 'deny') {
      const durationMs = Date.now() - startTime;
      return errorResult(toolName, {
        message: `Tool '${toolName}' is denied by policy`,
        code: 'TOOL_DENIED',
      }, durationMs);
    }

    if (policyResult.action === 'require-approval') {
      const durationMs = Date.now() - startTime;
      const approvalId = `${toolName}:${Date.now()}`;
      return pendingApprovalResult(toolName, approvalId, durationMs);
    }

    // Validate input against schema
    const parseResult = tool.inputSchema.safeParse(input);
    if (!parseResult.success) {
      const durationMs = Date.now() - startTime;
      const zodError = parseResult.error;
      const errorMessage = zodError.errors
        .map((e) => `${e.path.join('.')}: ${e.message}`)
        .join('; ');
      return errorResult(toolName, {
        message: `Invalid input: ${errorMessage}`,
        code: 'INVALID_INPUT',
      }, durationMs);
    }

    // Execute tool with timeout
    try {
      const result = await this.#timeoutManager.executeWithTimeout({
        fn: async () => {
          // Check for cancellation before execution
          if (context.abortSignal?.aborted) {
            throw new CancellationError('Operation cancelled', context.abortSignal.reason);
          }
          return tool.execute(input, context);
        },
        timeoutMs: undefined, // Use default
        signal: context.abortSignal,
        toolName,
      });

      const durationMs = Date.now() - startTime;

      // If tool returns a ToolResult directly, use it but ensure duration is correct
      if (this.#isToolResult(result)) {
        return {
          ...result,
          durationMs,
          toolName,
        };
      }

      // Otherwise wrap in success result
      return successResult(toolName, result, durationMs);
    } catch (error) {
      const durationMs = Date.now() - startTime;

      // Handle CancellationError
      if (isCancellationError(error)) {
        return cancelledResult(toolName, durationMs);
      }

      // Handle timeout error from ToolTimeoutManager (must check BEFORE generic ToolError)
      if (error instanceof ToolError && error.code === 'TOOL_TIMEOUT') {
        return timeoutResult(toolName, durationMs);
      }

      // Handle ToolError (preserve message and code)
      if (error instanceof ToolError) {
        return errorResult(toolName, {
          message: error.message,
          code: error.code,
        }, durationMs);
      }

      // Handle other errors
      const message = error instanceof Error ? error.message : String(error);
      return errorResult(toolName, {
        message,
        code: 'TOOL_ERROR',
      }, durationMs);
    }
  }

  /**
   * Type guard to check if a value is a ToolResult.
   */
  #isToolResult(value: unknown): value is ToolResult {
    if (!value || typeof value !== 'object') return false;
    const obj = value as Record<string, unknown>;
    return typeof obj.kind === 'string' &&
      ['success', 'error', 'pending-approval', 'timeout', 'cancelled'].includes(obj.kind);
  }

  /**
   * Gets the underlying tool registry.
   */
  get registry(): ToolRegistry {
    return this.#registry;
  }

  /**
   * Gets the tool policy.
   */
  get policy(): ToolPolicy {
    return this.#policy;
  }

  /**
   * Gets the timeout manager.
   */
  get timeoutManager(): ToolTimeoutManager {
    return this.#timeoutManager;
  }
}