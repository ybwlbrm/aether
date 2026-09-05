/**
 * Agent Definition Types
 *
 * Core type definitions for agent configuration, limits, and policies.
 * Transport-agnostic: no Fastify, no SSE, no React, no zod-for-runtime deps.
 * Pure TypeScript only.
 */

/**
 * Resource limits for agent execution.
 */
export interface AgentLimits {
  /** Maximum number of conversation turns */
  maxTurns: number;
  /** Maximum number of tool calls per execution */
  maxToolCalls: number;
  /** Maximum execution time in milliseconds */
  maxTimeMs: number;
  /** Maximum tokens per execution */
  maxTokens: number;
  /** Maximum parallel tasks */
  maxParallelTasks: number;
}

/**
 * Model configuration policy.
 */
export interface ModelPolicy {
  /** Model provider identifier (e.g., 'openai', 'anthropic') */
  provider?: string;
  /** Model identifier (e.g., 'gpt-4', 'claude-3-opus') */
  model?: string;
  /** Required model capabilities */
  capabilities?: string[];
  /** Sampling temperature (0.0 - 2.0) */
  temperature?: number;
  /** Maximum tokens for model response */
  maxTokens?: number;
}

/**
 * Tool access policy.
 */
export interface ToolPolicy {
  /** Explicitly allowed tool names (empty = all allowed unless denied) */
  allowedTools?: string[];
  /** Explicitly denied tool names */
  deniedTools?: string[];
  /** Tools requiring explicit approval before execution */
  requiresApprovalTools?: string[];
}

/**
 * Memory access policy.
 */
export interface MemoryPolicy {
  /** Readable memory scopes */
  readScopes: Array<'user' | 'session' | 'project'>;
  /** Writable memory scopes */
  writeScopes: Array<'session' | 'project'>;
}

/**
 * Complete agent definition.
 */
export interface AgentDefinition {
  /** Unique agent identifier */
  id: string;
  /** Human-readable agent name */
  name: string;
  /** Agent type classification (e.g., 'conversation', 'planner', 'coder', 'researcher') */
  type: string;
  /** Human-readable description */
  description: string;
  /** List of capability identifiers */
  capabilities: string[];
  /** System prompt for the agent */
  systemPrompt: string;
  /** Model configuration policy */
  modelPolicy: ModelPolicy;
  /** Tool access policy */
  toolPolicy: ToolPolicy;
  /** Memory access policy */
  memoryPolicy: MemoryPolicy;
  /** Resource limits */
  limits: AgentLimits;
}

/**
 * Default agent limits used when not explicitly specified.
 */
export const DEFAULT_AGENT_LIMITS: AgentLimits = {
  maxTurns: 50,
  maxToolCalls: 200,
  maxTimeMs: 30 * 60 * 1000, // 30 minutes
  maxTokens: 128000,
  maxParallelTasks: 8,
};