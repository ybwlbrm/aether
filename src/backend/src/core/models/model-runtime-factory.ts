/**
 * Aether 2.0 — Model Runtime Factory (Phase 4)
 *
 * Bridges the LEGACY provider configuration (lib/provider.ts ResolvedProvider,
 * sourced from the `providers` table) into the NEW core ModelRuntime layer.
 *
 * buildModelRuntime() constructs an OpenAICompatibleAdapter configured with a
 * real HTTP transport from the provider's baseUrl/apiKey — the migration target
 * for legacy `fetch(.../chat/completions)` call sites.
 *
 * Pure TypeScript; no Fastify/SSE/React imports.
 */

import { OpenAICompatibleAdapter } from './provider-adapter.js';
import { ModelRegistry, type ModelSpec } from './model-registry.js';
import type { ModelRuntime } from './model-runtime.js';

/** Shape of a legacy provider config — compatible with lib/provider.ts ResolvedProvider */
export interface LegacyProviderConfig {
  id: string;
  name: string;
  type: string;
  apiKey: string;
  baseUrl: string;
  defaultModel: string;
  models: string[];
  capabilities?: string[];
}

/**
 * Build an OpenAICompatibleAdapter (a ModelRuntime) from a legacy provider
 * config. Uses a real HTTP transport pointed at the provider's baseUrl, so
 * complete()/stream() hit `/chat/completions` exactly like the legacy path.
 */
export function buildModelRuntime(provider: LegacyProviderConfig): ModelRuntime {
  return new OpenAICompatibleAdapter({
    providerId: provider.id,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    allowHttpTransport: true,
  });
}

/** Map legacy provider capabilities into the new ModelCapabilities flags */
function mapCapabilities(caps: string[] = []): ModelSpec['capabilities'] {
  const out: ModelSpec['capabilities'] = {};
  const map: Record<string, keyof ModelSpec['capabilities']> = {
    text: 'text',
    vision: 'vision',
    reasoning: 'reasoning',
    tool_calling: 'toolCalling',
    image_generation: 'imageGeneration',
    audio: 'audio',
    video: 'video',
    structured_output: 'structuredOutput',
  };
  for (const cap of caps) {
    const key = map[cap];
    if (key) out[key] = true;
  }
  return out;
}

/**
 * Register every model a provider exposes into a ModelRegistry.
 * Returns the number of models registered.
 */
export function registerProviderModels(
  registry: ModelRegistry,
  provider: LegacyProviderConfig,
): number {
  const capabilities = mapCapabilities(provider.capabilities);
  for (const modelId of provider.models) {
    const spec: ModelSpec = {
      id: modelId,
      name: modelId,
      capabilities,
    };
    registry.register(provider.id, spec);
  }
  return provider.models.length;
}

/**
 * Convenience: build a ModelRuntime AND register its models in one call.
 */
export function buildAndRegister(
  registry: ModelRegistry,
  provider: LegacyProviderConfig,
): ModelRuntime {
  registerProviderModels(registry, provider);
  return buildModelRuntime(provider);
}