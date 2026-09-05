/**
 * ToolPolicy — Policy engine for tool execution control.
 *
 * Transport-agnostic: no Fastify, no SSE, no React, no zod-for-runtime deps.
 * Pure TypeScript only.
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
 * Default behavior: allow unless a deny/require-approval rule matches.
 */
export class ToolPolicy {
  #rules: ToolPolicyRule[];
  #grantedCapabilities: CapabilitySet;

  /**
   * Creates a new ToolPolicy.
   *
   * @param rules - Policy rules (evaluated in order, first match wins)
   * @param grantedCapabilities - Capabilities granted to the current context
   */
  constructor(rules: ToolPolicyRule[] = [], grantedCapabilities?: CapabilitySet) {
    this.#rules = [...rules];
    this.#grantedCapabilities = grantedCapabilities ?? new Set() as CapabilitySet;
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
    // Default: allow
    return { action: 'allow' };
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