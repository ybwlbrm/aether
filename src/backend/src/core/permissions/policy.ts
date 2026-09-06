/**
 * Policy Engine — Capability-based Authorization Rules
 *
 * Defines explicit allow/deny rules over capabilities, evaluated against a
 * PolicyContext (which carries the granted CapabilitySet).
 *
 * Semantics (P1-34):
 * - An explicit `deny` rule wins over everything, regardless of granted capabilities.
 * - If no rule matches and the context carries the capability → allowed.
 * - If an explicit `allow` rule matches (and no deny matched) → allowed.
 * - Otherwise → denied (default deny for ungranted capabilities).
 * 
 * 权限优先级（P0-06/P1-38，与 ToolPolicy/PolicyEngine 注释对齐）：
 * Explicit Deny > Capability Deny > Approval > Explicit Allow > Default Deny
 */

import type { Capability, CapabilitySet } from './capability.js';
import { hasCapability } from './capability.js';
import { RuntimeError } from '../errors/index.js';

/** Policy rule effect */
export type PolicyEffect = 'allow' | 'deny';

/**
 * A single authorization rule.
 * `capability` may contain a `*` wildcard suffix (e.g. `filesystem.*`).
 */
export interface PolicyRule {
  id: string;
  capability: Capability | `${string}.*`;
  effect: PolicyEffect;
  /** Reserved for future conditions (e.g. resource scoping) */
  condition?: Record<string, unknown>;
}

/** Evaluation context for a capability request */
export interface PolicyContext {
  /** Capabilities granted to the caller */
  capabilities: CapabilitySet;
  agentId?: string;
  runId?: string;
  /** Resource identifier being accessed (e.g. file path, URL) */
  resource?: string;
  /** Additional structured context */
  extra?: Record<string, unknown>;
}

/** Evaluation result */
export interface PolicyDecision {
  allowed: boolean;
  effect: 'allow' | 'deny' | 'default';
  matchedRule?: PolicyRule;
}

/** Match a capability against a rule pattern (supports `filesystem.*` wildcard) */
function matchesRuleCapability(ruleCap: string, requested: Capability): boolean {
  if (ruleCap === requested) return true;
  if (ruleCap.endsWith('.*')) {
    const prefix = ruleCap.slice(0, -1); // e.g. 'filesystem.'
    return requested.startsWith(prefix);
  }
  return false;
}

/**
 * In-memory policy engine.
 *
 * Rules are ordered; the FIRST matching rule wins (deny has priority only if it
 * comes first — rules are evaluated in registration order, and a matching deny
 * always overrides a matching allow regardless of order via `denyWins`).
 */
export class PolicyEngine {
  private readonly rules: PolicyRule[] = [];
  private readonly seenIds = new Set<string>();

  constructor(rules?: PolicyRule[]) {
    for (const rule of rules ?? []) {
      this.addRule(rule);
    }
  }

  addRule(rule: PolicyRule): void {
    if (this.seenIds.has(rule.id)) {
      throw new RuntimeError(`policy rule id already registered: ${rule.id}`, {
        code: 'RULE_EXISTS',
        retryable: false,
      });
    }
    this.seenIds.add(rule.id);
    this.rules.push(rule);
  }

  evaluate(capability: Capability, context: PolicyContext): PolicyDecision {
    // 1. First matching DENY rule → denied (highest priority)
    for (const rule of this.rules) {
      if (rule.effect === 'deny' && matchesRuleCapability(rule.capability, capability)) {
        return { allowed: false, effect: 'deny', matchedRule: rule };
      }
    }

    // 2. Grant from context capabilities → allowed (default allow path)
    if (hasCapability(context.capabilities, capability)) {
      return { allowed: true, effect: 'default' };
    }

    // 3. Explicit ALLOW rule → allowed even if not granted in context
    for (const rule of this.rules) {
      if (rule.effect === 'allow' && matchesRuleCapability(rule.capability, capability)) {
        return { allowed: true, effect: 'allow', matchedRule: rule };
      }
    }

    // 4. Default deny
    return { allowed: false, effect: 'default' };
  }

  /** Convenience: true if evaluate().allowed */
  permits(capability: Capability, context: PolicyContext): boolean {
    return this.evaluate(capability, context).allowed;
  }

  /** List registered rules (copy, for introspection). */
  listRules(): PolicyRule[] {
    return [...this.rules];
  }
}

/** Factory returning an empty engine. */
export function defaultPolicyEngine(): PolicyEngine {
  return new PolicyEngine();
}