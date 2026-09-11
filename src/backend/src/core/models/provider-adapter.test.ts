/**
 * Provider Adapter Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ModelRequest } from './model-runtime.js';
import type { StreamChunk, TokenUsage, FinishReason } from '@pacc/shared';
import { OpenAICompatibleAdapter, type Transport } from './provider-adapter.js';
import { ModelError } from '../errors/index.js';
import { createRetryPolicy } from './retry-policy.js';
import { createCircuitBreaker } from './circuit-breaker.js';

describe('provider-adapter', () => {
  describe('OpenAICompatibleAdapter', () => {
    const createRequest = (overrides: Partial<ModelRequest> = {}): ModelRequest => ({
      provider: 'openai',
      model: 'gpt-4',
      messages: [{ role: 'user', content: 'Hello' }],
      ...overrides,
    });

    describe('streamMessages with mock', () => {
      it('yields chunks from mock function', async () => {
        const mockChunks: StreamChunk[] = [
          { type: 'block-start', index: 0, blockType: 'text' },
          { type: 'text-delta', index: 0, text: 'Mock response' },
          { type: 'block-end', index: 0, block: { kind: 'text', text: 'Mock response' } },
          { type: 'finish', reason: { kind: 'stop' } },
        ];

        const adapter = new OpenAICompatibleAdapter({
          providerId: 'openai',
          mock: async function* () {
            for (const chunk of mockChunks) yield chunk;
          },
        });

        const chunks: StreamChunk[] = [];
        for await (const chunk of adapter.streamMessages(createRequest())) {
          chunks.push(chunk);
        }

        assert.deepStrictEqual(chunks, mockChunks);
      });
    });

    describe('streamMessages with transport', () => {
      const createTransport = (frames: string[]): Transport => {
        return async function* (_request: ModelRequest, _signal: AbortSignal | undefined) {
          for (const frame of frames) {
            yield new TextEncoder().encode(frame + '\n\n');
          }
        };
      };

      it('parses SSE frames and yields StreamChunk events', async () => {
        const frames = [
          'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}',
          'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}',
          'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}',
          'data: [DONE]',
        ];

        const adapter = new OpenAICompatibleAdapter({
          providerId: 'openai',
          transport: createTransport(frames),
        });

        const chunks: StreamChunk[] = [];
        for await (const chunk of adapter.streamMessages(createRequest())) {
          chunks.push(chunk);
        }

        // Verify text deltas
        const textDeltas = chunks.filter((c) => c.type === 'text-delta');
        assert.strictEqual(textDeltas.length, 2);
        assert.strictEqual(textDeltas[0].text, 'Hello');
        assert.strictEqual(textDeltas[1].text, ' world');

        // Verify finish
        const finishChunks = chunks.filter((c) => c.type === 'finish');
        assert.strictEqual(finishChunks.length, 1);
        assert.strictEqual(finishChunks[0].reason.kind, 'stop');

        // Verify usage
        const usageChunks = chunks.filter((c) => c.type === 'usage');
        assert.strictEqual(usageChunks.length, 1);
        assert.deepStrictEqual(usageChunks[0].usage, {
          inputTokens: 10,
          outputTokens: 5,
          totalTokens: 15,
        });
      });

      it('maps reasoning_content to reasoning-delta', async () => {
        const frames = [
          'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4","choices":[{"index":0,"delta":{"reasoning_content":"Let me think"},"finish_reason":null}]}',
          'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4","choices":[{"index":0,"delta":{"reasoning_content":" about this"},"finish_reason":null}]}',
          'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
          'data: [DONE]',
        ];

        const adapter = new OpenAICompatibleAdapter({
          providerId: 'openai',
          transport: createTransport(frames),
        });

        const chunks: StreamChunk[] = [];
        for await (const chunk of adapter.streamMessages(createRequest())) {
          chunks.push(chunk);
        }

        const reasoningDeltas = chunks.filter((c) => c.type === 'reasoning-delta');
        assert.strictEqual(reasoningDeltas.length, 2);
        assert.strictEqual(reasoningDeltas[0].text, 'Let me think');
        assert.strictEqual(reasoningDeltas[1].text, ' about this');
      });

      it('maps reasoning field to reasoning-delta (alternative field name)', async () => {
        const frames = [
          'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4","choices":[{"index":0,"delta":{"reasoning":"Alternative reasoning field"},"finish_reason":null}]}',
          'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
          'data: [DONE]',
        ];

        const adapter = new OpenAICompatibleAdapter({
          providerId: 'openai',
          transport: createTransport(frames),
        });

        const chunks: StreamChunk[] = [];
        for await (const chunk of adapter.streamMessages(createRequest())) {
          chunks.push(chunk);
        }

        const reasoningDeltas = chunks.filter((c) => c.type === 'reasoning-delta');
        assert.strictEqual(reasoningDeltas.length, 1);
        assert.strictEqual(reasoningDeltas[0].text, 'Alternative reasoning field');
      });

      it('accumulates tool call arguments from tool-call-delta', async () => {
        const frames = [
          'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"id":"call_123","type":"function","function":{"name":"get_weather","arguments":"{\\"location\\":"}}]},"finish_reason":null}]}',
          'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4","choices":[{"index":0,"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\\"San Francisco\\"}"}}]},"finish_reason":null}]}',
          'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
          'data: [DONE]',
        ];

        const adapter = new OpenAICompatibleAdapter({
          providerId: 'openai',
          transport: createTransport(frames),
        });

        const chunks: StreamChunk[] = [];
        for await (const chunk of adapter.streamMessages(createRequest())) {
          chunks.push(chunk);
        }

        const toolCallDeltas = chunks.filter((c): c is Extract<StreamChunk, { type: 'tool-call-delta' }> => c.type === 'tool-call-delta');
        assert.strictEqual(toolCallDeltas.length, 2);
        assert.strictEqual(toolCallDeltas[0].argumentsDelta, '{"location":');
        assert.strictEqual(toolCallDeltas[1].argumentsDelta, '"San Francisco"}');

        const blockEnds = chunks.filter((c): c is Extract<StreamChunk, { type: 'block-end' }> => c.type === 'block-end' && c.block.kind === 'tool-call');
        assert.strictEqual(blockEnds.length, 1);
        const toolCallBlock = blockEnds[0].block;
        assert.equal(toolCallBlock.kind, 'tool-call');
        if (toolCallBlock.kind === 'tool-call') {
          assert.strictEqual(toolCallBlock.arguments, '{"location":"San Francisco"}');
        }
      });

      it('maps finish_reason stop to stop', async () => {
        const frames = [
          'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
          'data: [DONE]',
        ];

        const adapter = new OpenAICompatibleAdapter({
          providerId: 'openai',
          transport: createTransport(frames),
        });

        const chunks: StreamChunk[] = [];
        for await (const chunk of adapter.streamMessages(createRequest())) {
          chunks.push(chunk);
        }

        const finishChunks = chunks.filter((c) => c.type === 'finish');
        assert.strictEqual(finishChunks[0].reason.kind, 'stop');
      });

      it('maps finish_reason tool_calls to tool_calls', async () => {
        const frames = [
          'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4","choices":[{"index":0,"delta":{},"finish_reason":"tool_calls"}]}',
          'data: [DONE]',
        ];

        const adapter = new OpenAICompatibleAdapter({
          providerId: 'openai',
          transport: createTransport(frames),
        });

        const chunks: StreamChunk[] = [];
        for await (const chunk of adapter.streamMessages(createRequest())) {
          chunks.push(chunk);
        }

        const finishChunks = chunks.filter((c) => c.type === 'finish');
        assert.strictEqual(finishChunks[0].reason.kind, 'tool_calls');
      });

      it('maps finish_reason length to max-tokens', async () => {
        const frames = [
          'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4","choices":[{"index":0,"delta":{},"finish_reason":"length"}]}',
          'data: [DONE]',
        ];

        const adapter = new OpenAICompatibleAdapter({
          providerId: 'openai',
          transport: createTransport(frames),
        });

        const chunks: StreamChunk[] = [];
        for await (const chunk of adapter.streamMessages(createRequest())) {
          chunks.push(chunk);
        }

        const finishChunks = chunks.filter((c) => c.type === 'finish');
        assert.strictEqual(finishChunks[0].reason.kind, 'max-tokens');
      });

      it('includes reasoningTokens in usage when present', async () => {
        const frames = [
          'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":50,"total_tokens":150,"reasoning_tokens":20}}',
          'data: [DONE]',
        ];

        const adapter = new OpenAICompatibleAdapter({
          providerId: 'openai',
          transport: createTransport(frames),
        });

        const chunks: StreamChunk[] = [];
        for await (const chunk of adapter.streamMessages(createRequest())) {
          chunks.push(chunk);
        }

        const usageChunks = chunks.filter((c) => c.type === 'usage');
        assert.strictEqual(usageChunks.length, 1);
        assert.strictEqual(usageChunks[0].usage.reasoningTokens, 20);
      });

      it('handles stream ending without [DONE] sentinel', async () => {
        const frames = [
          'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4","choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":null}]}',
          'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
          // No [DONE] frame
        ];

        const adapter = new OpenAICompatibleAdapter({
          providerId: 'openai',
          transport: createTransport(frames),
        });

        const chunks: StreamChunk[] = [];
        for await (const chunk of adapter.streamMessages(createRequest())) {
          chunks.push(chunk);
        }

        const finishChunks = chunks.filter((c) => c.type === 'finish');
        assert.strictEqual(finishChunks.length, 1);
        assert.strictEqual(finishChunks[0].reason.kind, 'stop');
      });

      it('ignores malformed JSON lines', async () => {
        const frames = [
          'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4","choices":[{"index":0,"delta":{"content":"Valid"},"finish_reason":null}]}',
          'data: not valid json',
          'data: {"id":"chatcmpl-123","object":"chat.completion.chunk","created":1234567890,"model":"gpt-4","choices":[{"index":0,"delta":{"content":"Also valid"},"finish_reason":null}]}',
          'data: [DONE]',
        ];

        const adapter = new OpenAICompatibleAdapter({
          providerId: 'openai',
          transport: createTransport(frames),
        });

        const chunks: StreamChunk[] = [];
        for await (const chunk of adapter.streamMessages(createRequest())) {
          chunks.push(chunk);
        }

        const textDeltas = chunks.filter((c) => c.type === 'text-delta');
        assert.strictEqual(textDeltas.length, 2);
        assert.strictEqual(textDeltas[0].text, 'Valid');
        assert.strictEqual(textDeltas[1].text, 'Also valid');
      });
    });

    describe('streamMessages without transport or mock', () => {
      it('throws PROVIDER_UNAVAILABLE ModelError (retryable)', async () => {
        const adapter = new OpenAICompatibleAdapter({
          providerId: 'openai',
          // No transport, no mock
        });

        let error: ModelError | null = null;
        try {
          for await (const _chunk of adapter.streamMessages(createRequest())) {
            // Should not reach here
          }
        } catch (e) {
          error = e as ModelError;
        }

        assert.ok(error);
        assert.ok(error instanceof ModelError);
        assert.strictEqual(error.code, 'PROVIDER_UNAVAILABLE');
        assert.strictEqual(error.retryable, true);
        assert.strictEqual(error.provider, 'openai');
      });
    });

    describe('complete', () => {
      it('delegates to streamMessages + streamToComplete', async () => {
        const mockChunks: StreamChunk[] = [
          { type: 'block-start', index: 0, blockType: 'text' },
          { type: 'text-delta', index: 0, text: 'Complete response' },
          { type: 'block-end', index: 0, block: { kind: 'text', text: 'Complete response' } },
          { type: 'finish', reason: { kind: 'stop' } },
          { type: 'usage', usage: { inputTokens: 10, outputTokens: 5, totalTokens: 15 } },
        ];

        const adapter = new OpenAICompatibleAdapter({
          providerId: 'openai',
          mock: async function* () {
            for (const chunk of mockChunks) yield chunk;
          },
        });

        const response = await adapter.complete(createRequest());

        assert.strictEqual(response.content, 'Complete response');
        assert.strictEqual(response.finishReason, 'stop');
        assert.deepStrictEqual(response.usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
        assert.strictEqual(response.provider, 'openai');
        assert.strictEqual(response.model, 'gpt-4');
      });
    });

    describe('real HTTP transport (allowHttpTransport)', () => {
      /** Build a Response whose body yields the given SSE text in chunks */
      function sseResponse(text: string): Response {
        const encoder = new TextEncoder();
        const bytes = encoder.encode(text);
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            // Split into 2 chunks to exercise the buffering path
            const half = Math.ceil(bytes.length / 2);
            controller.enqueue(bytes.slice(0, half));
            controller.enqueue(bytes.slice(half));
            controller.close();
          },
        });
        return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }

      const ssePayload = [
        'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"gpt-4","choices":[{"index":0,"delta":{"role":"assistant","content":"Hello"},"finish_reason":null}]}',
        'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"gpt-4","choices":[{"index":0,"delta":{"content":" world"},"finish_reason":null}]}',
        'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"gpt-4","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}',
        'data: [DONE]',
      ].join('\n\n') + '\n\n';

      it('streamMessages performs a POST and parses SSE frames via fetch', async () => {
        let calledUrl = '';
        const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
          calledUrl = String(url);
          // Capture the request body for assertion
          const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
          assert.equal(body.model, 'gpt-4');
          assert.equal(body.stream, true);
          assert.deepEqual((body.stream_options as { include_usage: boolean }).include_usage, true);
          return sseResponse(ssePayload);
        }) as typeof fetch;

        const adapter = new OpenAICompatibleAdapter({
          providerId: 'openai',
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'sk-test',
          fetchImpl,
          allowHttpTransport: true,
        });

        const chunks: StreamChunk[] = [];
        for await (const chunk of adapter.streamMessages(createRequest())) {
          chunks.push(chunk);
        }

        assert.ok(calledUrl.endsWith('/chat/completions'), `url should hit /chat/completions, got ${calledUrl}`);
        const textDeltas = chunks.filter((c): c is Extract<StreamChunk, { type: 'text-delta' }> => c.type === 'text-delta');
        assert.deepEqual(textDeltas.map((d) => d.text), ['Hello', ' world']);
        const finishes = chunks.filter((c) => c.type === 'finish');
        assert.equal(finishes.length, 1);
        assert.equal((finishes[0] as Extract<StreamChunk, { type: 'finish' }>).reason.kind, 'stop');
      });

      it('complete() assembles a ModelResponse through the HTTP path', async () => {
        const fetchImpl = async () => sseResponse(ssePayload) as unknown as Response;
        const adapter = new OpenAICompatibleAdapter({
          providerId: 'openai',
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'sk-test',
          fetchImpl: fetchImpl as typeof fetch,
          allowHttpTransport: true,
        });

        const response = await adapter.complete(createRequest());
        assert.equal(response.content, 'Hello world');
        assert.equal(response.finishReason, 'stop');
        assert.deepEqual(response.usage, { inputTokens: 10, outputTokens: 5, totalTokens: 15 });
        assert.equal(response.provider, 'openai');
      });

      it('non-2xx responses throw a retryable ModelError with status', async () => {
        const fetchImpl = async () =>
          new Response('rate limited', { status: 429, headers: { 'Content-Type': 'text/plain' } });
        const adapter = new OpenAICompatibleAdapter({
          providerId: 'openai',
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'sk-test',
          fetchImpl: fetchImpl as typeof fetch,
          allowHttpTransport: true,
        });

        await assert.rejects(
          (async () => {
            for await (const _ of adapter.streamMessages(createRequest())) {
              void _;
            }
          })(),
          (err: unknown) => {
            assert.ok(err instanceof ModelError, `expected ModelError, got ${String(err)}`);
            assert.equal((err as ModelError).statusCode, 429);
            assert.equal((err as ModelError).retryable, true);
            return true;
          },
        );
      });

      it('without allowHttpTransport, streamMessages still throws PROVIDER_UNAVAILABLE', async () => {
        const adapter = new OpenAICompatibleAdapter({ providerId: 'openai' });
        await assert.rejects(
          (async () => {
            for await (const _ of adapter.streamMessages(createRequest())) {
              void _;
            }
          })(),
          (err: unknown) =>
            err instanceof ModelError && err.code === 'PROVIDER_UNAVAILABLE' && err.retryable === true,
        );
      });

      // ── P0-11：thinking/reasoningEffort 真实透传到 Provider 请求 ──

      it('P0-11: thinking/reasoningEffort 被写入请求体（不再只上层知道）', async () => {
        let capturedBody: Record<string, unknown> = {};
        const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
          capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return sseResponse(ssePayload);
        }) as typeof fetch;

        const adapter = new OpenAICompatibleAdapter({
          providerId: 'openai',
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'sk-test',
          fetchImpl,
          allowHttpTransport: true,
        });

        for await (const _ of adapter.streamMessages(createRequest({ thinking: true, reasoningEffort: 'high' }))) {
          void _;
        }
        assert.ok(Object.keys(capturedBody).length > 0, '请求体应被捕获');
        assert.deepEqual(capturedBody.thinking, { type: 'enabled' });
        assert.equal(capturedBody.reasoning_effort, 'high');
      });

      it('P0-11: thinking=false → thinking.type=disabled 且不带 reasoning_effort', async () => {
        let capturedBody: Record<string, unknown> = {};
        const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
          capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
          return sseResponse(ssePayload);
        }) as typeof fetch;

        const adapter = new OpenAICompatibleAdapter({
          providerId: 'openai',
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'sk-test',
          fetchImpl,
          allowHttpTransport: true,
        });

        for await (const _ of adapter.streamMessages(createRequest({ thinking: false, reasoningEffort: 'high' }))) {
          void _;
        }
        assert.deepEqual(capturedBody.thinking, { type: 'disabled' });
        assert.equal(capturedBody.reasoning_effort, undefined, 'thinking=false 时不应发送 reasoning_effort');
      });

      // ── P1-02：CRLF 帧边界（标准 SSE \r\n\r\n）──

      it('P1-02: CRLF frame boundary (CRLF CRLF) parsed correctly', async () => {
        const crlfPayload = [
          'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"gpt-4","choices":[{"index":0,"delta":{"role":"assistant","content":"CRLF"},"finish_reason":null}]}',
          'data: {"id":"c1","object":"chat.completion.chunk","created":1,"model":"gpt-4","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}',
          'data: [DONE]',
        ].join('\r\n\r\n') + '\r\n\r\n';

        const fetchImpl: typeof fetch = async () => {
          const encoder = new TextEncoder();
          const bytes = encoder.encode(crlfPayload);
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              // 故意单字节尾部拆分，验证逐帧重组（非一次性大段）
              for (const b of bytes) controller.enqueue(Uint8Array.of(b));
              controller.close();
            },
          });
          return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
        };

        const adapter = new OpenAICompatibleAdapter({
          providerId: 'openai',
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'sk-test',
          fetchImpl,
          allowHttpTransport: true,
        });

        const chunks: StreamChunk[] = [];
        for await (const chunk of adapter.streamMessages(createRequest())) {
          chunks.push(chunk);
        }
        const textDeltas = chunks.filter((c): c is Extract<StreamChunk, { type: 'text-delta' }> => c.type === 'text-delta');
        assert.deepEqual(textDeltas.map((d) => d.text), ['CRLF']);
      });

      // ── P0-10：RetryPolicy 集成（429 重试后成功）──

      it('P0-10: 429 一次失败后自动重试成功（RetryPolicy 集成）', async () => {
        let calls = 0;
        const fetchImpl = (async () => {
          calls += 1;
          if (calls === 1) {
            return new Response('rate limited', { status: 429, headers: { 'Content-Type': 'text/plain' } });
          }
          return sseResponse(ssePayload);
        }) as typeof fetch;

        const adapter = new OpenAICompatibleAdapter({
          providerId: 'openai',
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'sk-test',
          fetchImpl,
          allowHttpTransport: true,
          // 注入低延迟重试策略（快测）
          retryPolicy: createRetryPolicy({ baseDelayMs: 10, maxRetries: 2 }),
          circuitBreaker: createCircuitBreaker({ failureThreshold: 100 }),
        } as never);

        const chunks: StreamChunk[] = [];
        for await (const chunk of adapter.streamMessages(createRequest())) {
          chunks.push(chunk);
        }
        assert.ok(calls >= 2, `应重试至少 2 次，实际 ${calls}`);
        const textDeltas = chunks.filter((c): c is Extract<StreamChunk, { type: 'text-delta' }> => c.type === 'text-delta');
        assert.deepEqual(textDeltas.map((d) => d.text), ['Hello', ' world']);
      });

      // ── P1-03：streamToComplete 元数据注入 ──

      it('P1-03: complete() 返回的 Response 带完整 provider/model 元数据', async () => {
        const fetchImpl = async () => sseResponse(ssePayload) as unknown as Response;
        const adapter = new OpenAICompatibleAdapter({
          providerId: 'my-provider',
          baseUrl: 'https://api.example.com/v1',
          apiKey: 'sk-test',
          fetchImpl: fetchImpl as typeof fetch,
          allowHttpTransport: true,
        });

        const response = await adapter.complete(createRequest({ provider: 'request-provider', model: 'request-model' }));
        assert.equal(response.provider, 'request-provider');
        assert.equal(response.model, 'request-model');
        assert.ok(response.id, 'Response 应携带 id');
      });
    });
  });
});