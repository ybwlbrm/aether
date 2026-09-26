/**
 * Core Models Module — Aether 2.0
 *
 * Transport-agnostic model runtime interfaces and implementations.
 * Pure TypeScript — no Fastify, no SSE, no React, no zod-for-runtime deps.
 */

// Model Runtime Types
export {
  ModelCapabilities,
  ModelRequest,
  ModelResponse,
  ModelRuntime,
  streamToComplete,
} from './model-runtime.js';

// Streaming Client
export {
  StreamingClient,
  createStreamingClient,
} from './streaming-client.js';

// Model Registry
export {
  ModelRegistry,
  type ModelSpec,
} from './model-registry.js';

// Provider Adapter
export {
  ProviderAdapter,
  OpenAICompatibleAdapter,
  type OpenAICompatibleAdapterOptions,
  type Transport,
  type FetchTransportOptions,
  createFetchTransport,
} from './provider-adapter.js';

// Model Runtime Factory (Phase 4 — legacy provider config → core ModelRuntime)
export {
  type LegacyProviderConfig,
  type ModelRuntimeDeps,
  buildModelRuntime,
  registerProviderModels,
  buildAndRegister,
} from './model-runtime-factory.js';

// Model Error Factories
export {
  rateLimitError,
  authError,
  contextWindowError,
  providerUnavailableError,
} from './model-error.js';

// Usage Tracking
export {
  UsageTracker,
  aggregateUsage,
  type UsageRecord,
  type UsageTotals,
} from './usage.js';

// Retry Policy (P0-10: ModelRuntime 组成部分)
export {
  type RetryPolicy,
  type RetryPolicyOptions,
  type RetryDecision,
  type RetryablePredicate,
  createRetryPolicy,
  defaultRetryable,
  extractRetryAfterMs,
} from './retry-policy.js';

// Circuit Breaker (P0-10: ModelRuntime 组成部分)
export {
  type CircuitBreaker,
  type CircuitBreakerOptions,
  type CircuitState,
  createCircuitBreaker,
} from './circuit-breaker.js';