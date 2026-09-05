/**
 * Core Permissions Module
 *
 * Capability system (P1-33): string union, sets, and core operations.
 * Policy engine (P1-34): explicit allow/deny rules over capabilities.
 * Approval manager (P1-35): in-memory capability approval workflow.
 * Do not import from outside core/ in this module.
 */

export {
  type Capability,
  type CapabilitySet,
  ALL_CAPABILITIES,
  createCapabilitySet,
  hasCapability,
  combineCapabilities,
  isSuperset,
  difference,
  intersection,
} from './capability.js';

export {
  type PolicyEffect,
  type PolicyRule,
  type PolicyContext,
  type PolicyDecision,
  PolicyEngine,
  defaultPolicyEngine,
} from './policy.js';

export {
  type ApprovalStatus,
  type ApprovalRequest,
  type ApprovalRequestInput,
  type ApprovalDecision,
  ApprovalManager,
} from './approval.js';