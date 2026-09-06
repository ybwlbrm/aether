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
import type { PolicyEngine } from '../permissions/policy.js';

/**
 * Options for ToolExecutor constructor.
 */
export interface ToolExecutorOptions {
  /** Policy for tool execution control */
  policy?: ToolPolicy;
  /**
   * PERM-001 (P0-19/20)：可选的 capability 化 PolicyEngine（新权限体系）。
   * 注入后，deny 规则对 `tool:<name>` capability 生效（默认放行，零行为变化）。
   * 提供 migration layer：旧 ToolPolicy（compatibility）与新 PolicyEngine 可并存；
   * 新部署只注入 policyEngine，不注入 policy。
   */
  policyEngine?: PolicyEngine;
  /** Default timeout in milliseconds */
  defaultTimeoutMs?: number;
}

/**
 * ToolExecutor — Orchestrates tool execution with policy, validation, timeout, and error handling.
 * 权限链路（PERM-001）：Capability → PolicyEngine → Approval → ToolRuntime → Executor
 */
export class ToolExecutor {
  #registry: ToolRegistry;
  #policy: ToolPolicy;
  #policyEngine?: PolicyEngine;
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
    this.#policyEngine = options.policyEngine;
    this.#timeoutManager = new ToolTimeoutManager(options.defaultTimeoutMs);
  }

  /**
   * PERM-001: capability 化 PolicyEngine 裁决（capability 名为 `tool.<name>`，
   * 与 PolicyEngine 点分段通配约定一致 —— `tool.*` 可通配所有工具）。
   * 迁移语义（default-safe）：仅当**显式 deny 规则**命中时拒绝；
   * 未命中规则（default effect，无论 capabilities 是否授予）一律放行，
   * 由 legacy ToolPolicy 继续接管 —— 避免"注入空 engine 即拒绝全部工具"的部署陷阱。
   * 未注入 policyEngine 时完全跳过（旧行为零变化）。
   */
  #evaluatePolicyEngine(toolName: string, context: ToolContext): boolean {
    if (!this.#policyEngine) return true;
    const decision = this.#policyEngine.evaluate(`tool.${toolName}`, {
      capabilities: context.permissions ?? [],
      agentId: context.agentId,
      runId: context.runId,
      extra: { tool: toolName },
    });
    return decision.effect !== 'deny';
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

    // Evaluate policy (PERM-001: 先过 capability 化 PolicyEngine，再走 legacy ToolPolicy)
    if (!this.#evaluatePolicyEngine(toolName, context)) {
      const durationMs = Date.now() - startTime;
      return errorResult(toolName, {
        message: `Tool '${toolName}' is denied by policy`,
        code: 'TOOL_DENIED',
      }, durationMs);
    }
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