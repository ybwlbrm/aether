/**
 * Model Registry
 *
 * Central registry for model specifications and capabilities.
 * Pure TypeScript — no Fastify, no SSE, no React, no zod-for-runtime deps.
 */

import type { ModelCapabilities } from './model-runtime.js';

/**
 * Model specification — metadata about a specific model.
 */
export interface ModelSpec {
  /** Unique model identifier (e.g., 'gpt-4', 'claude-3-opus') */
  id: string;
  /** Human-readable model name */
  name: string;
  /** Capability flags for this model */
  capabilities: ModelCapabilities;
  /** Context window size in tokens (if known) */
  contextWindow?: number;
  /** Maximum output tokens (if known) */
  maxOutputTokens?: number;
}

/**
 * Registry entry with provider context.
 */
interface RegistryEntry {
  providerId: string;
  spec: ModelSpec;
}

/**
 * Model registry — manages model specifications per provider.
 * Silent on missing entries (returns undefined), throws only on programmer errors.
 */
export class ModelRegistry {
  private readonly entries: Map<string, RegistryEntry> = new Map();

  /**
   * Register a model specification for a provider.
   * Overwrites existing entry for the same provider+model combination.
   *
   * @param providerId - Provider identifier (e.g., 'openai', 'anthropic')
   * @param model - Model specification
   */
  register(providerId: string, model: ModelSpec): void {
    const key = this.makeKey(providerId, model.id);
    this.entries.set(key, { providerId, spec: model });
  }

  /**
   * Unregister a model for a provider.
   * No-op if the model is not registered.
   *
   * @param providerId - Provider identifier
   * @param modelId - Model identifier
   */
  unregister(providerId: string, modelId: string): void {
    const key = this.makeKey(providerId, modelId);
    this.entries.delete(key);
  }

  /**
   * Get a model specification by provider and model ID.
   * Returns undefined if not found (does not throw).
   *
   * @param providerId - Provider identifier
   * @param modelId - Model identifier
   * @returns ModelSpec or undefined
   */
  get(providerId: string, modelId: string): ModelSpec | undefined {
    const key = this.makeKey(providerId, modelId);
    return this.entries.get(key)?.spec;
  }

  /**
   * List all registered models with their provider IDs.
   *
   * @returns Array of { providerId, model: ModelSpec }
   */
  list(): Array<{ providerId: string; model: ModelSpec }> {
    return Array.from(this.entries.values()).map((entry) => ({
      providerId: entry.providerId,
      model: entry.spec,
    }));
  }

  /**
   * Find all models that have a specific capability enabled.
   *
   * @param capability - Capability key (e.g., 'toolCalling', 'vision', 'reasoning')
   * @returns Array of { providerId, model: ModelSpec } with the capability
   */
  resolveByCapability(
    capability: keyof ModelCapabilities
  ): Array<{ providerId: string; model: ModelSpec }> {
    return this.list().filter(({ model }) => model.capabilities[capability] === true);
  }

  /**
   * Create a composite key for the registry map.
   */
  private makeKey(providerId: string, modelId: string): string {
    return `${providerId}:${modelId}`;
  }
}