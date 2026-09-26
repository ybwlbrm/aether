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
import type { RetryPolicy } from './retry-policy.js';
import type { CircuitBreaker } from './circuit-breaker.js';

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
 * P0-007：provider 级运行时依赖（透传给 OpenAICompatibleAdapter → Transport）。
 *
 * 熔断器/重试策略的生命周期必须是 **provider 级**，不是请求级：请求级实例的
 * consecutiveFailures 永远到不了阈值 5，state 恒为 closed，CIRCUIT_OPEN 不可达。
 * 调用方（lib/model-runtime-bridge.ts 的 ProviderRuntimeRegistry）负责持有并复用。
 */
export interface ModelRuntimeDeps {
  /** provider 级熔断器（缺省由 Adapter/Transport 新建 —— 仅适合单请求/测试场景） */
  circuitBreaker?: CircuitBreaker;
  /** provider 级重试策略 */
  retryPolicy?: RetryPolicy;
}

/**
 * Build an OpenAICompatibleAdapter (a ModelRuntime) from a legacy provider
 * config. Uses a real HTTP transport pointed at the provider's baseUrl, so
 * complete()/stream() hit `/chat/completions` exactly like the legacy path.
 *
 * P0-007：传入 `deps` 时把 provider 级 circuitBreaker / retryPolicy 透传给
 * Adapter（进而透传到 createFetchTransport），使熔断状态能在同一 provider 的
 * 多次请求之间累积。
 */
export function buildModelRuntime(
  provider: LegacyProviderConfig,
  deps: ModelRuntimeDeps = {},
): ModelRuntime {
  return new OpenAICompatibleAdapter({
    providerId: provider.id,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    allowHttpTransport: true,
    circuitBreaker: deps.circuitBreaker,
    retryPolicy: deps.retryPolicy,
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
  deps: ModelRuntimeDeps = {},
): ModelRuntime {
  registerProviderModels(registry, provider);
  return buildModelRuntime(provider, deps);
}