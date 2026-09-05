/**
 * Streaming Client Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelRequest } from './model-runtime.js';
import type { StreamChunk } from '@pacc/shared';
import { createStreamingClient, type StreamingClient } from './streaming-client.js';
import type { ProviderAdapter } from './provider-adapter.js';

describe('streaming-client', () => {
  describe('createStreamingClient', () => {
    it('creates a StreamingClient that delegates to adapter.streamMessages', async () => {
      const expectedChunks: StreamChunk[] = [
        { type: 'block-start', index: 0, blockType: 'text' },
        { type: 'text-delta', index: 0, text: 'Hello' },
        { type: 'block-end', index: 0, block: { kind: 'text', text: 'Hello' } },
        { type: 'finish', reason: { kind: 'stop' } },
      ];

      const mockAdapter: ProviderAdapter = {
        providerId: 'test-provider',
        async *streamMessages(_request: ModelRequest): AsyncIterable<StreamChunk> {
          for (const chunk of expectedChunks) yield chunk;
        },
        async complete(_request: ModelRequest) {
          throw new Error('Not implemented');
        },
      };

      const client = createStreamingClient(mockAdapter);
      const chunks: StreamChunk[] = [];

      for await (const chunk of client.stream({ provider: 'test', model: 'test', messages: [] })) {
        chunks.push(chunk);
      }

      assert.deepStrictEqual(chunks, expectedChunks);
    });

    it('returns a StreamingClient with stream method', () => {
      const mockAdapter: ProviderAdapter = {
        providerId: 'test',
        async *streamMessages() {},
        async complete() { throw new Error('Not implemented'); },
      };

      const client = createStreamingClient(mockAdapter);

      assert.ok(client);
      assert.ok(typeof client.stream === 'function');
    });

    it('passes request through to adapter', async () => {
      let capturedRequest: ModelRequest | null = null;

      const mockAdapter: ProviderAdapter = {
        providerId: 'test',
        async *streamMessages(request: ModelRequest): AsyncIterable<StreamChunk> {
          capturedRequest = request;
          yield { type: 'finish', reason: { kind: 'stop' } };
        },
        async complete() { throw new Error('Not implemented'); },
      };

      const client = createStreamingClient(mockAdapter);
      const request: ModelRequest = {
        provider: 'openai',
        model: 'gpt-4',
        messages: [{ role: 'user', content: 'Hello' }],
        temperature: 0.7,
        maxTokens: 100,
      };

      for await (const _chunk of client.stream(request)) {
        // consume
      }

      assert.deepStrictEqual(capturedRequest, request);
    });
  });
});