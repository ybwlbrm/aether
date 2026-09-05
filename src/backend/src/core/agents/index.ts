/**
 * Core Agents Module
 *
 * Agent runtime, registry, context, and definition types for Aether 2.0.
 * Transport-agnostic: no Fastify, no SSE, no React, no zod-for-runtime deps.
 * Pure TypeScript only.
 */

// Agent Definition
export {
  type AgentLimits,
  type ModelPolicy,
  type ToolPolicy,
  type MemoryPolicy,
  type AgentDefinition,
  DEFAULT_AGENT_LIMITS,
} from './agent-definition.js';

// Agent Registry
export { AgentRegistry } from './agent-registry.js';

// Agent Context
export {
  type AgentContext,
  type InboxMessage,
  type HandoffRecord,
  type CreateAgentContextConfig,
  createAgentContext,
} from './agent-context.js';

// Agent Runtime
export { AgentRuntime } from './agent-runtime.js';

// Agent Messaging (P1-24)
export {
  type AgentMessageType,
  type AgentMessage,
  type CreateAgentMessageInput,
  createAgentMessage,
  isAgentMessage,
} from './agent-message.js';

// Agent Handoff (P1-25)
export {
  type HandoffPayload,
  type HandoffStatus,
  type HandoffRecord as HandoffRequestRecord,
  HandoffProtocol,
} from './agent-handoff.js';

// Agent Supervisor (P1-26)
export {
  type SupervisorConfig,
  type TaskStatus,
  SupervisorAgent,
} from './agent-supervisor.js';

// Legacy migration (Phase 5 — old AGENTS[] → core AgentRegistry)
export {
  type LegacyAgentDef,
  buildCoreDefinition,
  registerLegacyAgents,
  buildRegistryFromLegacy,
} from './agent-registry-migration.js';