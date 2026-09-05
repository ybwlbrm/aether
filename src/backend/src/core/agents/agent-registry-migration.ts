/**
 * Aether 2.0 — Agent Registry Migration (Phase 5)
 *
 * Bridges the LEGACY hardcoded AGENTS[] (modules/agents/agent-definitions.ts,
 * AgentDef shape) into the NEW core AgentDefinition + AgentRegistry layer,
 * without touching the legacy handlers that still consume AGENTS directly.
 *
 * Migration targets (§26-27 of the refactor plan):
 * - registerLegacyAgents() registers every legacy agent into an AgentRegistry
 *   so the runtime can look agents up through the registry.
 * - buildCoreDefinition() maps a legacy AgentDef (id/name/icon/role/
 *   description/systemPrompt/capabilities/model) into the core shape,
 *   deriving modelPolicy from the legacy model field and defaults for
 *   tool/memory policies and limits.
 *
 * Pure TypeScript — no Fastify/SSE/React imports.
 */

import {
  AgentRegistry,
  DEFAULT_AGENT_LIMITS,
  type AgentDefinition,
  type ModelPolicy,
} from './index.js';

/** Legacy agent shape — mirrors modules/agents/agent-definitions.ts AgentDef */
export interface LegacyAgentDef {
  id: string;
  name: string;
  icon?: string;
  role?: string;
  description: string;
  systemPrompt: string;
  capabilities: string[];
  model?: string;
}

/**
 * Map a legacy AgentDef into the core AgentDefinition.
 * The legacy `model` (if present) becomes the modelPolicy; otherwise the
 * policy is left empty so resolution falls back to provider defaults.
 */
export function buildCoreDefinition(def: LegacyAgentDef): AgentDefinition {
  const modelPolicy: ModelPolicy = def.model
    ? { model: def.model }
    : {};
  return {
    id: def.id,
    name: def.name,
    // Legacy has no explicit type field; classify by capability hints
    type: inferType(def),
    description: def.description,
    capabilities: def.capabilities ?? [],
    systemPrompt: def.systemPrompt,
    modelPolicy,
    toolPolicy: {},
    memoryPolicy: { readScopes: ['user'], writeScopes: ['session'] },
    limits: { ...DEFAULT_AGENT_LIMITS },
  };
}

/** Register a list of legacy agents into a core AgentRegistry. Returns count. */
export function registerLegacyAgents(
  registry: AgentRegistry,
  legacyAgents: LegacyAgentDef[],
): number {
  for (const legacy of legacyAgents) {
    registry.register(buildCoreDefinition(legacy));
  }
  return legacyAgents.length;
}

/** Convenience: build a fresh registry pre-populated from legacy agents. */
export function buildRegistryFromLegacy(legacyAgents: LegacyAgentDef[]): AgentRegistry {
  const registry = new AgentRegistry();
  registerLegacyAgents(registry, legacyAgents);
  return registry;
}

/** Heuristic type classification from capabilities/id for agents lacking a type */
function inferType(def: LegacyAgentDef): string {
  const caps = new Set((def.capabilities ?? []).map((c) => c.toLowerCase()));
  const id = def.id.toLowerCase();

  if (id.includes('oracle')) return 'reasoner';
  if (id.includes('librarian')) return 'researcher';
  if (id.includes('explore')) return 'researcher';
  if (id.includes('hephaestus') || id.includes('coder')) return 'coder';
  if (id.includes('metis') || id.includes('prometheus')) return 'planner';
  if (id.includes('momus')) return 'reviewer';
  if (id.includes('atlas')) return 'architect';
  if (id.includes('multimodal')) return 'multimodal';
  if (id.includes('junior')) return 'worker';
  if (caps.has('tool_calling') || caps.has('tool_use')) return 'worker';
  return 'conversation';
}