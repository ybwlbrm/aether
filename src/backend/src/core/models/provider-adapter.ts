/**
 * Provider Adapter
 *
 * Interface and OpenAI-compatible implementation for model providers.
 * Pure TypeScript — no Fastify, no SSE, no React, no zod-for-runtime deps.
 */

import type { ModelRequest, ModelResponse } from './model-runtime.js';
import type { StreamChunk, TokenUsage, FinishReason } from '@pacc/shared';
import { ModelError } from '../errors/index.js';
import { streamToComplete } from './model-runtime.js';

/**
 * Provider adapter interface — implemented by each provider integration.
 */
export interface ProviderAdapter {
  /** Unique provider identifier (e.g., 'openai', 'anthropic', 'ollama') */
  readonly providerId: string;

  /**
   * Non-streaming completion.
   * Default implementation in OpenAICompatibleAdapter delegates to streamMessages + streamToComplete.
   */
  complete(request: ModelRequest): Promise<ModelResponse>;

  /**
   * Streaming completion — yields provider-neutral StreamChunk events.
   */
  streamMessages(request: ModelRequest): AsyncIterable<StreamChunk>;
}

/**
 * Wire-format chunk from OpenAI-compatible SSE stream.
 * Minimal subset for parsing — not exhaustive.
 */
interface WireChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: {
      role?: string;
      content?: string | null;
      reasoning_content?: string | null;
      reasoning?: string | null;
      tool_calls?: Array<{
        index: number;
        id?: string;
        type?: string;
        function?: {
          name?: string;
          arguments?: string;
        };
      }>;
    };
    finish_reason?: 'stop' | 'tool_calls' | 'length' | 'content_filter' | null;
  }>;
  usage?: {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    reasoning_tokens?: number;
  };
}

/**
 * Transport function type — returns async iterable of raw SSE bytes (Uint8Array).
 * Injected for testability and to avoid network deps in core.
 */
export type Transport = (
  request: ModelRequest,
  signal: AbortSignal | undefined
) => AsyncIterable<Uint8Array>;

/** Options for createFetchTransport */
export interface FetchTransportOptions {
  /** Base URL (e.g. 'https://api.openai.com/v1') — the /chat/completions path is appended */
  baseUrl: string;
  /** API key (sent as `Authorization: Bearer <key>`) */
  apiKey?: string;
  /** Custom fetch implementation (for testing / non-browser envs) */
  fetchImpl?: typeof fetch;
}

/**
 * Build an OpenAI-compatible /chat/completions request body from a ModelRequest.
 * stream=true + stream_options.include_usage are always set so the wire
 * protocol matches what the SSE parser expects.
 */
function buildChatBody(request: ModelRequest): Record<string, unknown> {
  const messages = request.systemPrompt
    ? [{ role: 'system', content: request.systemPrompt }, ...request.messages]
    : request.messages;
  const body: Record<string, unknown> = {
    model: request.model,
    messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (request.tools && request.tools.length > 0) body.tools = request.tools;
  if (request.temperature !== undefined) body.temperature = request.temperature;
  if (request.maxTokens !== undefined) body.max_tokens = request.maxTokens;
  return body;
}

/**
 * Real HTTP transport: POSTs to `{baseUrl}/chat/completions` with the SSE
 * stream enabled and yields the raw response body bytes. This is the wire
 * path the legacy `fetch(.../chat/completions)` calls migrate onto.
 *
 * Non-2xx responses throw a retryable-flagged ModelError carrying the
 * provider status so callers can distinguish rate-limits from hard errors.
 */
export function createFetchTransport(opts: FetchTransportOptions): Transport {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  return async function* (request, signal): AsyncIterable<Uint8Array> {
    const body = buildChatBody(request);
    const response = await fetchImpl(`${opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new ModelError(`provider request failed (${response.status}): ${text.slice(0, 200)}`, {
        provider: request.provider,
        model: request.model,
        code: response.status === 429 ? 'RATE_LIMIT' : 'PROVIDER_UNAVAILABLE',
        statusCode: response.status,
        retryable: response.status === 429 || response.status >= 500,
      });
    }

    if (!response.body) {
      throw new ModelError('provider returned an empty body', {
        provider: request.provider,
        model: request.model,
        code: 'PROVIDER_UNAVAILABLE',
        retryable: true,
      });
    }

    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) return;
        yield value;
      }
    } finally {
      reader.releaseLock();
    }
  };
}

/**
 * OpenAI-compatible adapter options.
 */
export interface OpenAICompatibleAdapterOptions {
  /** Provider identifier */
  providerId: string;
  /** Base URL for API (e.g., 'https://api.openai.com/v1') */
  baseUrl?: string;
  /** API key for authentication */
  apiKey?: string;
  /** Custom fetch implementation (for testing or non-browser envs) */
  fetchImpl?: typeof fetch;
  /** Transport function for SSE streaming — REQUIRED for streaming to work.
   *  If not provided, streamMessages will throw PROVIDER_UNAVAILABLE.
   *  The transport should yield Uint8Array chunks from the SSE connection.
   */
  transport?: Transport;
  /** Optional mock for testing — if provided, streamMessages yields from mock instead of transport */
  mock?: (request: ModelRequest) => AsyncIterable<StreamChunk>;
  /**
   * When true AND no transport/mock is supplied, streamMessages falls back to
   * a real HTTP transport built from baseUrl/apiKey/fetchImpl. Explicit opt-in
   * keeps the adapter side-effect-free by default (no accidental network I/O).
   */
  allowHttpTransport?: boolean;
}

/**
 * OpenAI-compatible provider adapter.
 *
 * Thin shell — real SSE transport is injected via `transport` option.
 * For Wave 3, the transport is expected to be provided by the caller (e.g., from a dedicated SSE client).
 * If no transport is provided, streamMessages throws PROVIDER_UNAVAILABLE (retryable).
 */
export class OpenAICompatibleAdapter implements ProviderAdapter {
  public readonly providerId: string;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly transport?: Transport;
  private readonly mock?: (request: ModelRequest) => AsyncIterable<StreamChunk>;
  private readonly allowHttpTransport: boolean;

  constructor(options: OpenAICompatibleAdapterOptions) {
    this.providerId = options.providerId;
    this.baseUrl = options.baseUrl ?? 'https://api.openai.com/v1';
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.transport = options.transport;
    this.mock = options.mock;
    this.allowHttpTransport = options.allowHttpTransport ?? false;
  }

  /**
   * Non-streaming completion — delegates to streamMessages + streamToComplete.
   * Injects the request provider/model into the assembled response.
   */
  async complete(request: ModelRequest): Promise<ModelResponse> {
    const stream = this.streamMessages(request);
    const response = await streamToComplete(stream);
    return {
      ...response,
      provider: request.provider || this.providerId,
      model: request.model,
    };
  }

  /**
   * ModelRuntime-compatible streaming entry point — aliases streamMessages so
   * this adapter satisfies both ProviderAdapter and ModelRuntime interfaces.
   */
  stream(request: ModelRequest): AsyncIterable<StreamChunk> {
    return this.streamMessages(request);
  }

  /**
   * Streaming completion.
   *
   * Priority:
   * 1. If `mock` is provided, yield from mock (for testing)
   * 2. If `transport` is provided, parse SSE frames and map to StreamChunk
   * 3. If `allowHttpTransport` is set, use a real HTTP transport built from
   *    baseUrl/apiKey/fetchImpl (the migration target for legacy fetch calls)
   * 4. Otherwise, throw PROVIDER_UNAVAILABLE (retryable)
   */
  async *streamMessages(request: ModelRequest): AsyncIterable<StreamChunk> {
    // 1. Mock mode for testing
    if (this.mock) {
      yield* this.mock(request);
      return;
    }

    // 2. Transport mode — parse SSE
    if (this.transport) {
      yield* this.parseSSEStream(request);
      return;
    }

    // 3. Real HTTP transport (opt-in)
    if (this.allowHttpTransport) {
      const httpTransport = createFetchTransport({
        baseUrl: this.baseUrl,
        apiKey: this.apiKey,
        fetchImpl: this.fetchImpl,
      });
      yield* this.parseSSEStream(request, httpTransport);
      return;
    }

    // 4. No transport available
    throw new ModelError('No transport configured for streaming', {
      provider: this.providerId,
      model: request.model,
      code: 'PROVIDER_UNAVAILABLE',
      retryable: true,
    });
  }

  /**
   * Parse SSE stream from a transport and yield StreamChunk events.
   * Falls back to the injected `transport` option when none is passed.
   */
  private async *parseSSEStream(
    request: ModelRequest,
    overrideTransport?: Transport,
  ): AsyncIterable<StreamChunk> {
    const transportStream = (overrideTransport ?? this.transport)!(request, request.signal);
    const decoder = new TextDecoder();
    let buffer = '';
    let blockIndex = 0;
    const toolCallBuffers: Map<number, { id: string; name: string; arguments: string }> = new Map();
    const openedBlocks: Map<number, 'text' | 'reasoning' | 'tool-call'> = new Map();
    let finished = false;

    // Emit a single finish event (only once per stream).
    const finishOnce = function* (reason: FinishReason = { kind: 'stop' }): Generator<StreamChunk> {
      if (!finished) {
        finished = true;
        yield { type: 'finish', reason };
      }
    };

    const mappedWireChunk = (wireChunk: WireChunk): Generator<StreamChunk, FinishReason | undefined> =>
      this.mapWireChunk(wireChunk, request, blockIndex, toolCallBuffers, openedBlocks);

    const handleData = function* (data: string): Generator<StreamChunk> {
      if (data === '[DONE]') {
        yield* finishOnce();
        return;
      }
      try {
        const wireChunk: WireChunk = JSON.parse(data);
        const finishReason = yield* mappedWireChunk(wireChunk);
        if (finishReason) {
          yield* finishOnce(finishReason);
        }
      } catch {
        // Ignore malformed JSON lines
      }
    };

    for await (const chunk of transportStream) {
      buffer += decoder.decode(chunk, { stream: true });

      // Split on double newline (SSE frame delimiter)
      const frames = buffer.split('\n\n');
      buffer = frames.pop() ?? ''; // Keep incomplete frame in buffer

      for (const frame of frames) {
        const lines = frame.split('\n');
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          yield* handleData(data);
          if (finished) return;
        }
      }
    }

    // Flush any remaining buffer
    if (buffer.trim()) {
      const lines = buffer.split('\n');
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        yield* handleData(data);
        if (finished) return;
      }
    }

    // If stream ended without [DONE]/finish_reason, emit finish once
    yield* finishOnce();
  }

  /**
   * Map a wire chunk to zero or more StreamChunk events.
   * Returns a FinishReason when the chunk carries a finish_reason
   * (the caller emits the finish event exactly once).
   *
   * For text/reasoning deltas a block-start is emitted once per (blockIndex,
   * kind) so downstream consumers (streamToComplete) can accumulate content.
   */
  private *mapWireChunk(
    wire: WireChunk,
    request: ModelRequest,
    blockIndex: number,
    toolCallBuffers: Map<number, { id: string; name: string; arguments: string }>,
    openedBlocks: Map<number, 'text' | 'reasoning' | 'tool-call'>,
  ): Generator<StreamChunk, FinishReason | undefined> {
    const choice = wire.choices[0];
    if (!choice) return undefined;

    const delta = choice.delta;

    // Handle content delta (text) — emit block-start once for this block index
    if (delta.content != null && delta.content !== '') {
      if (openedBlocks.get(blockIndex) !== 'text') {
        openedBlocks.set(blockIndex, 'text');
        yield { type: 'block-start', index: blockIndex, blockType: 'text' };
      }
      yield { type: 'text-delta', index: blockIndex, text: delta.content };
    }

    // Handle reasoning delta (reasoning_content or reasoning)
    const reasoningText = delta.reasoning_content ?? delta.reasoning;
    if (reasoningText != null && reasoningText !== '') {
      if (openedBlocks.get(blockIndex) !== 'reasoning') {
        openedBlocks.set(blockIndex, 'reasoning');
        yield { type: 'block-start', index: blockIndex, blockType: 'reasoning' };
      }
      yield { type: 'reasoning-delta', index: blockIndex, text: reasoningText };
    }

    // Handle tool calls
    if (delta.tool_calls && delta.tool_calls.length > 0) {
      for (const tc of delta.tool_calls) {
        const tcIndex = tc.index ?? 0;

        // Initialize buffer for this tool call index if needed
        if (!toolCallBuffers.has(tcIndex)) {
          const id = tc.id ?? `call_${Date.now()}_${tcIndex}`;
          toolCallBuffers.set(tcIndex, {
            id,
            name: tc.function?.name ?? '',
            arguments: '',
          });
          // Yield block-start for new tool call
          yield {
            type: 'block-start',
            index: blockIndex,
            blockType: 'tool-call',
            id,
            name: tc.function?.name ?? '',
          };
        }

        const buffer = toolCallBuffers.get(tcIndex)!;

        // Update name if provided
        if (tc.function?.name) {
          buffer.name = tc.function.name;
        }

        // Accumulate arguments delta
        if (tc.function?.arguments) {
          buffer.arguments += tc.function.arguments;
          yield {
            type: 'tool-call-delta',
            index: blockIndex,
            id: buffer.id,
            name: buffer.name,
            argumentsDelta: tc.function.arguments,
          };
        }
      }
    }

    // Handle finish reason — emit block-ends for pending tool calls and return the reason
    if (choice.finish_reason) {
      // Yield block-end for any pending tool calls
      for (const [, buffer] of toolCallBuffers) {
        yield {
          type: 'block-end',
          index: blockIndex,
          block: {
            kind: 'tool-call',
            id: buffer.id,
            name: buffer.name,
            arguments: buffer.arguments,
          },
        };
      }
      toolCallBuffers.clear();

      // Map finish reason
      let finishKind: FinishReason['kind'] = 'stop';
      switch (choice.finish_reason) {
        case 'tool_calls':
          finishKind = 'tool_calls';
          break;
        case 'length':
          finishKind = 'max-tokens';
          break;
        case 'content_filter':
        default:
          finishKind = 'stop';
          break;
      }

      // Yield usage if present
      if (wire.usage) {
        const usage: TokenUsage = {
          inputTokens: wire.usage.prompt_tokens,
          outputTokens: wire.usage.completion_tokens,
          totalTokens: wire.usage.total_tokens,
        };
        if (wire.usage.reasoning_tokens != null) {
          usage.reasoningTokens = wire.usage.reasoning_tokens;
        }
        yield { type: 'usage', usage };
      }

      return { kind: finishKind };
    }

    return undefined;
  }
}