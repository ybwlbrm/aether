/**
 * ToolPolicy — Policy engine for tool execution control.
 *
 * TRANSPORT-AGNOSTIC: no Fastify, no SSE, no React, no zod-for-runtime deps.
 * Pure TypeScript only.
 *
 * @deprecated PERM-001 (P0-19/20)：本类为兼容层（legacy tool-pattern 规则）。
 * 新权限体系为 capability 化的 `PolicyEngine`（src/core/permissions/policy.ts），
 * 语义：Capability → PolicyEngine → Approval → ToolRuntime → Executor。
 * - 新代码应使用 PolicyEngine（工具名以 `tool:<name>` capability 表达）
 * - 本类仅在 ToolExecutor 内保留为**可选**兼容检查（toolExecutorOptions.policyEngine 注入时启用）
 * - 计划在下一个大版本移除
 * 
 * 权限优先级（P0-06/P1-38）：Explicit Deny > Capability Deny > Approval > Explicit Allow > Default Deny
 * 注意：本类的 "First match wins" 仅在 legacy 模式下生效；PolicyEngine 优先级以 decision.allowed 为准。
 */

import type { Capability, CapabilitySet } from '../permissions/index.js';

/**
 * Policy rule for a tool or tool pattern.
 */
export interface ToolPolicyRule {
  /** Tool name pattern (exact match or glob with * wildcard) */
  pattern: string;
  /** Action to take when pattern matches */
  action: 'allow' | 'deny' | 'require-approval';
  /** Optional capabilities required for this rule to apply */
  capabilities?: Capability[];
}

/**
 * ToolPolicy constructor options.
 */
export interface ToolPolicyOptions {
  /** Policy rules (evaluated in order, first match wins) */
  rules?: ToolPolicyRule[];
  /** Capabilities granted to the current context */
  grantedCapabilities?: CapabilitySet;
  /** P1-37: Default action when no rule matches. Default: 'allow' (legacy behavior). */
  defaultAction?: 'allow' | 'deny';
}

/**
 * Evaluation result from the policy engine.
 */
export interface PolicyEvaluation {
  /** Action to take */
  action: 'allow' | 'deny' | 'require-approval';
  /** The rule that matched, if any */
  matchedRule?: ToolPolicyRule;
}

/**
 * ToolPolicy — Evaluates tool execution against a set of rules.
 *
 * Rules are evaluated in order. First match wins.
 * Default behavior: configurable via defaultAction (legacy default: 'allow').
 */
export class ToolPolicy {
  #rules: ToolPolicyRule[];
  #grantedCapabilities: CapabilitySet;
  #defaultAction: 'allow' | 'deny';

  /**
   * Creates a new ToolPolicy.
   *
   * @param options - Policy options including rules, grantedCapabilities, and defaultAction
   */
  constructor(options: ToolPolicyOptions = {}) {
    this.#rules = [...(options.rules ?? [])];
    this.#grantedCapabilities = options.grantedCapabilities ?? new Set() as CapabilitySet;
    this.#defaultAction = options.defaultAction ?? 'allow';
  }

  /**
   * Evaluates a tool name against the policy rules.
   *
   * @param toolName - Name of the tool to evaluate
   * @returns Policy evaluation result
   */
  evaluate(toolName: string): PolicyEvaluation {
    for (const rule of this.#rules) {
      if (this.#matchesPattern(toolName, rule.pattern)) {
        // Check capabilities if specified
        if (rule.capabilities && rule.capabilities.length > 0) {
          const hasAllCapabilities = rule.capabilities.every((cap) =>
            this.#grantedCapabilities.has(cap)
          );
          if (!hasAllCapabilities) {
            continue; // Rule doesn't apply, check next rule
          }
        }
        return {
          action: rule.action,
          matchedRule: rule,
        };
      }
    }
    // Default: use configured defaultAction
    return { action: this.#defaultAction };
  }

  /**
   * Checks if a tool is explicitly allowed.
   */
  allow(toolName: string): boolean {
    return this.evaluate(toolName).action === 'allow';
  }

  /**
   * Checks if a tool is explicitly denied.
   */
  denied(toolName: string): boolean {
    return this.evaluate(toolName).action === 'deny';
  }

  /**
   * Checks if a tool requires approval.
   */
  requiresApproval(toolName: string): boolean {
    return this.evaluate(toolName).action === 'require-approval';
  }

  /**
   * Adds a rule to the policy (appended to end).
   */
  addRule(rule: ToolPolicyRule): void {
    this.#rules.push(rule);
  }

  /**
   * Removes a rule by pattern.
   */
  removeRule(pattern: string): boolean {
    const index = this.#rules.findIndex((r) => r.pattern === pattern);
    if (index >= 0) {
      this.#rules.splice(index, 1);
      return true;
    }
    return false;
  }

  /**
   * Returns a copy of all rules.
   * Mutating the returned array does not affect the policy.
   */
  getRules(): ToolPolicyRule[] {
    return [...this.#rules];
  }

  /**
   * Returns the granted capabilities.
   */
  getGrantedCapabilities(): CapabilitySet {
    return this.#grantedCapabilities;
  }

  /**
   * Checks if a tool name matches a pattern.
   * Supports exact match and glob-style * wildcard.
   */
  #matchesPattern(toolName: string, pattern: string): boolean {
    if (pattern === toolName) {
      return true;
    }
    if (pattern.includes('*')) {
      // Convert glob pattern to regex
      const regexPattern = pattern
        .replace(/[.+?^${}()|[\]\\]/g, '\\$&') // Escape special regex chars
        .replace(/\*/g, '.*'); // * matches any characters
      return new RegExp(`^${regexPattern}$`).test(toolName);
    }
    return false;
  }
}