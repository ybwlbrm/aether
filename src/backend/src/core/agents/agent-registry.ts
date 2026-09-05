/**
 * Agent Registry
 *
 * Registry for managing agent definitions.
 * Transport-agnostic: no Fastify, no SSE, no React, no zod-for-runtime deps.
 * Pure TypeScript only.
 */

import { RuntimeError } from '../errors/index.js';
import type { AgentDefinition } from './agent-definition.js';

/**
 * Registry for agent definitions.
 * Provides CRUD operations with duplicate detection and validation.
 */
export class AgentRegistry {
  #agents: Map<string, AgentDefinition> = new Map();

  /**
   * Registers a new agent definition.
   *
   * @param def - The agent definition to register
   * @throws {RuntimeError} If an agent with the same ID already exists (code: 'AGENT_EXISTS')
   */
  register(def: AgentDefinition): void {
    if (this.#agents.has(def.id)) {
      throw new RuntimeError(`Agent with id '${def.id}' already exists`, {
        code: 'AGENT_EXISTS',
        context: { agentId: def.id },
        retryable: false,
      });
    }
    this.#agents.set(def.id, def);
  }

  /**
   * Unregisters an agent definition by ID.
   *
   * @param id - The agent ID to unregister
   * @returns true if the agent was found and removed, false otherwise
   */
  unregister(id: string): boolean {
    return this.#agents.delete(id);
  }

  /**
   * Retrieves an agent definition by ID.
   *
   * @param id - The agent ID to retrieve
   * @returns The agent definition if found, undefined otherwise
   */
  get(id: string): AgentDefinition | undefined {
    return this.#agents.get(id);
  }

  /**
   * Lists all registered agent definitions.
   *
   * @returns Array of all registered agent definitions
   */
  list(): AgentDefinition[] {
    return Array.from(this.#agents.values());
  }

  /**
   * Updates an existing agent definition with a partial patch.
   *
   * @param id - The agent ID to update
   * @param patch - Partial agent definition to merge
   * @returns The updated agent definition
   * @throws {RuntimeError} If no agent with the given ID exists (code: 'AGENT_NOT_FOUND')
   */
  update(id: string, patch: Partial<AgentDefinition>): AgentDefinition {
    const existing = this.#agents.get(id);
    if (!existing) {
      throw new RuntimeError(`Agent with id '${id}' not found`, {
        code: 'AGENT_NOT_FOUND',
        context: { agentId: id },
        retryable: false,
      });
    }
    const updated: AgentDefinition = { ...existing, ...patch, id: existing.id };
    this.#agents.set(id, updated);
    return updated;
  }
}