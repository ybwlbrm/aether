/**
 * Agent Runtime Bridge — Aether 2.0 Phase 5 migration seam
 *
 * Registers the LEGACY hardcoded AGENTS[] (modules/agents/agent-definitions.ts)
 * into the NEW core AgentRegistry so the runtime can look agents up through
 * the registry — while the legacy handlers keep consuming AGENTS directly
 * (Adapter pattern, §2.1 不推倒重来).
 *
 * This is the wiring point modules/agents (orchestration.ts) can adopt when
 * they switch to the core AgentRuntime; the registry stays in sync with the
 * legacy definitions by construction.
 *
 * Pure TypeScript — no Fastify/SSE/React imports.
 */

import { AGENTS } from '../modules/agents/agent-definitions.js';
import {
  AgentRegistry,
  buildRegistryFromLegacy,
  type LegacyAgentDef,
} from '../core/agents/index.js';

/** The 11 legacy agents exposed as LegacyAgentDef (icon/role preserved for UI) */
export function legacyAgentsAsDefs(): LegacyAgentDef[] {
  return AGENTS.map((a) => ({
    id: a.id,
    name: a.name,
    icon: a.icon,
    role: a.role,
    description: a.description,
    systemPrompt: a.systemPrompt,
    capabilities: a.capabilities ?? [],
    model: a.model,
  }));
}

/**
 * Build a core AgentRegistry pre-populated with all legacy agents.
 * The registry is rebuilt from the source-of-truth AGENTS[] every call,
 * so it never drifts from the definitions.
 */
export function buildCoreAgentRegistry(): AgentRegistry {
  return buildRegistryFromLegacy(legacyAgentsAsDefs());
}

/**
 * Resolve a core AgentDefinition by id from a registry populated from the
 * legacy agents. Returns undefined for unknown ids.
 */
export function resolveAgent(
  registry: AgentRegistry,
  agentId: string,
): ReturnType<AgentRegistry['get']> {
  return registry.get(agentId);
}

/** All legacy agent ids — convenience for validation/lookup loops */
export function legacyAgentIds(): string[] {
  return AGENTS.map((a) => a.id);
}