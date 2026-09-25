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
   * PERM-001 (P0-19/20)：capability 化 PolicyEngine（新权限体系，P0-06 唯一裁决者）。
   * 注入后，deny 规则对 `tool:<name>` capability 生效（默认放行，零行为变化）。
   * P0-06 收口：approval 效果 → 触发审批；deny → 拒绝；allow/default → 放行。
   */
  policyEngine?: PolicyEngine;
  /**
   * P0-06/P1-38: 强制 PolicyEngine 裁决模式。
   * - true: decision 为唯一裁决；无显式 allow/deny 规则时按 defaultDeny 语义拒绝（默认拒绝）。
   * - false (默认): 兼容模式，仅显式 deny 拦截，无规则时放行（避免"空 engine 拒绝一切"）。
   * 系统收敛入口应调用 enableMandatoryPolicyEngine() 开启。
   */
  enforcePolicyEngine?: boolean;
  /** Default timeout in milliseconds */
  defaultTimeoutMs?: number;
  /**
   * P0-11: 可选的审批请求回调，注入后使用 approvals-center 真实 ID (apr-xxxx)。
   * 回调接收工具名、参数摘要、上下文，返回 { id, promise }。
   * 未注入时保持旧行为（生成 `${toolName}:${Date.now()}`，兼容现有测试）。
   */
  requestApproval?: (params: {
    toolName: string;
    argsSummary: string;
    context: ToolContext;
  }) => { id: string; promise: Promise<{ approved: boolean; decision: 'approved' | 'rejected' | 'timeout' }> };
}

/**
 * ToolExecutor — Orchestrates tool execution with policy, validation, timeout, and error handling.
 * 权限链路（P0-06 收口）：Capability → PolicyEngine（唯一裁决）→ Approval → ToolRuntime → Executor
 * 权限优先级：Explicit Deny > Approval > Explicit Allow > Default Deny
 */
export class ToolExecutor {
  #registry: ToolRegistry;
  #policy: ToolPolicy;
  #policyEngine?: PolicyEngine;
  #enforcePolicyEngine: boolean;
  #timeoutManager: ToolTimeoutManager;
  #requestApproval?: ToolExecutorOptions['requestApproval'];

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
    this.#enforcePolicyEngine = options.enforcePolicyEngine ?? false;
    this.#timeoutManager = new ToolTimeoutManager(options.defaultTimeoutMs);
    this.#requestApproval = options.requestApproval;
  }

  /**
   * P0-06 收口：PolicyEngine 唯一裁决（capability 名为 `tool.<name>`，
   * 与 PolicyEngine 点分段通配约定一致 —— `tool.*` 可通配所有工具）。
   *
   * 返回三态：
   * - 'deny'：显式拒绝（最高优先级）
   * - 'approval'：需要用户审批（approval 规则命中，P0-06 新增）
   * - 'allow'：放行（granted/显式 allow/兼容模式无规则）
   *
   * 两种模式：
   * - 兼容模式 (enforcePolicyEngine=false, 默认)：仅显式 deny/approval 规则拦截；
   *   无规则或仅有 allow 时放行。避免"注入空 engine 即拒绝全部工具"的部署陷阱。
   * - 强制模式 (enforcePolicyEngine=true)：decision.allowed 为唯一裁决。
   *   无显式规则命中时按 default 效果（默认拒绝，即 defaultDeny 语义）。
   * 未注入 policyEngine 时完全跳过（旧行为零变化）。
   */
  #evaluatePolicyEngine(toolName: string, context: ToolContext): 'allow' | 'deny' | 'approval' {
    if (!this.#policyEngine) return 'allow';
    const decision = this.#policyEngine.evaluate(`tool.${toolName}`, {
      capabilities: context.permissions ?? [],
      agentId: context.agentId,
      runId: context.runId,
      extra: { tool: toolName },
    });
    // 强制模式：decision.allowed 为唯一裁决（approval 效果下 allowed=false 但需走审批而非拒绝）
    if (this.#enforcePolicyEngine) {
      if (decision.effect === 'approval') return 'approval';
      return decision.allowed ? 'allow' : 'deny';
    }
    // 兼容模式：仅显式 deny/approval 规则拦截
    if (decision.effect === 'deny') return 'deny';
    if (decision.effect === 'approval') return 'approval';
    return 'allow';
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

    // P1-8 修复（审计）：审批通过后的二次执行（internalApproved=true）不再重复走
    // PolicyEngine / legacy ToolPolicy 审批 —— 否则"批准 → 二次执行 → 再次要求审批"死循环。
    // 只信任受控字段 internalApproved；metadata 注入 approvedByUser 一律忽略（防任意赋权）。
    const approvedByUser = context.internalApproved === true;
    if (!approvedByUser) {
      // P0-06 收口：PolicyEngine 唯一裁决（deny → 拒绝；approval → 审批；allow → 执行）
      const policyDecision = this.#evaluatePolicyEngine(toolName, context);
      if (policyDecision === 'deny') {
        const durationMs = Date.now() - startTime;
        return errorResult(toolName, {
          message: `Tool '${toolName}' is denied by policy`,
          code: 'TOOL_DENIED',
        }, durationMs);
      }
      if (policyDecision === 'approval') {
        const durationMs = Date.now() - startTime;
        // P0-11: 优先使用注入的 requestApproval 回调（返回真实 apr-xxxx ID）
        if (this.#requestApproval) {
          const argsSummary = JSON.stringify(input).slice(0, 120);
          const { id, promise } = this.#requestApproval({
            toolName,
            argsSummary,
            context,
          });
          void promise;
          return pendingApprovalResult(toolName, id, durationMs);
        }
        // 兼容模式：未注入回调时使用旧行为
        const approvalId = `${toolName}:${Date.now()}`;
        return pendingApprovalResult(toolName, approvalId, durationMs);
      }

      // legacy ToolPolicy（仅未批准时评估；已批准直接放行）
      if (this.#policy) {
        const legacyPolicyResult = this.#policy.evaluate(toolName);
        if (legacyPolicyResult.action === 'deny') {
          const durationMs = Date.now() - startTime;
          return errorResult(toolName, {
            message: `Tool '${toolName}' is denied by policy`,
            code: 'TOOL_DENIED',
          }, durationMs);
        }
        if (legacyPolicyResult.action === 'require-approval') {
          const durationMs = Date.now() - startTime;
          // P0-11: 优先使用注入的 requestApproval 回调（返回真实 apr-xxxx ID）
          if (this.#requestApproval) {
            const argsSummary = JSON.stringify(input).slice(0, 120);
            const { id, promise } = this.#requestApproval({
              toolName,
              argsSummary,
              context,
            });
            void promise;
            return pendingApprovalResult(toolName, id, durationMs);
          }
          const approvalId = `${toolName}:${Date.now()}`;
          return pendingApprovalResult(toolName, approvalId, durationMs);
        }
      }
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
   * Pattern matching helper for approval args summary (reuses ToolPolicy logic).
   */
  #matchesPatternForApproval(toolName: string, pattern: string): boolean {
    if (pattern === toolName) return true;
    if (pattern.includes('*')) {
      const regexPattern = pattern
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&')
        .replace(/\*/g, '.*');
      return new RegExp(`^${regexPattern}$`).test(toolName);
    }
    return false;
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

  /**
   * P0-06/P1-38: 是否启用强制 PolicyEngine 裁决模式。
   * true 时 decision.allowed 为唯一裁决（默认拒绝语义）。
   */
  get enforcePolicyEngine(): boolean {
    return this.#enforcePolicyEngine;
  }

  /**
   * P0-06/P1-38: 启用强制 PolicyEngine 裁决模式的静态辅助。
   * 供系统收敛入口调用，返回新的 ToolExecutor 实例（不可变模式）。
   * 也可直接在构造时传入 enforcePolicyEngine: true。
   */
  static enableMandatoryPolicyEngine(
    registry: ToolRegistry,
    options: Omit<ToolExecutorOptions, 'enforcePolicyEngine'>
  ): ToolExecutor {
    return new ToolExecutor(registry, { ...options, enforcePolicyEngine: true });
  }
}