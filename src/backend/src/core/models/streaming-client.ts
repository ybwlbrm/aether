/**
 * Streaming Client
 *
 * Thin factory over ProviderAdapter for streaming-only consumers.
 * Pure TypeScript — no Fastify, no SSE, no React, no zod-for-runtime deps.
 */

import type { ModelRequest } from './model-runtime.js';
import type { StreamChunk } from '@pacc/shared';
import type { ProviderAdapter } from './provider-adapter.js';

/**
 * Streaming-only client interface.
 * Consumers that only need streaming (not complete) can depend on this.
 */
export interface StreamingClient {
  /**
   * Stream model response as provider-neutral StreamChunk events.
   */
  stream(request: ModelRequest): AsyncIterable<StreamChunk>;
}

/**
 * Creates a StreamingClient from a ProviderAdapter.
 * Delegates directly to the adapter's streamMessages method.
 *
 * @param adapter - Provider adapter implementing streamMessages
 * @returns StreamingClient instance
 */
export function createStreamingClient(adapter: ProviderAdapter): StreamingClient {
  return {
    stream(request: ModelRequest): AsyncIterable<StreamChunk> {
      return adapter.streamMessages(request);
    },
  };
}