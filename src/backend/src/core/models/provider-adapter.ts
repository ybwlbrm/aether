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
import { createRetryPolicy, extractRetryAfterMs } from './retry-policy.js';
import { createCircuitBreaker } from './circuit-breaker.js';

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
 *
 * P0-11 修复：thinking/reasoningEffort 必须真实透传到 Provider 请求参数
 * （此前仅上层知道，Adapter 未转发 —— UI 开了深度思考但 Provider 收不到）。
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
  // P0-11: thinking / reasoningEffort 透传
  if (request.thinking !== undefined || request.reasoningEffort !== undefined) {
    body.thinking = { type: request.thinking === false ? 'disabled' : 'enabled' };
    if (request.thinking !== false && request.reasoningEffort) {
      body.reasoning_effort = request.reasoningEffort;
    }
  }
  return body;
}

/** FetchTransportOptions — 增加 Retry/CircuitBreaker 集成（P0-10） */
export interface FetchTransportOptions {
  /** Base URL (e.g. 'https://api.openai.com/v1') — the /chat/completions path is appended */
  baseUrl: string;
  /** API key (sent as `Authorization: Bearer <key>`) */
  apiKey?: string;
  /** Custom fetch implementation (for testing / non-browser envs) */
  fetchImpl?: typeof fetch;
  /** Retry policy（缺省创建：3 次重试 + jitter） */
  retryPolicy?: import('./retry-policy.js').RetryPolicy;
  /** Circuit breaker（缺省创建：5 次失败熔断 30s） */
  circuitBreaker?: import('./circuit-breaker.js').CircuitBreaker;
}

/**
 * Real HTTP transport: POSTs to `{baseUrl}/chat/completions` with the SSE
 * stream enabled and yields the raw response body bytes. This is the wire
 * path the legacy `fetch(.../chat/completions)` calls migrate onto.
 *
 * P0-10 收口：429/5xx 自动重试（指数退避 + jitter + Retry-After 尊重 +
 * abortable sleep），连续失败触发熔断（快速失败，避免拖垮 Provider 查询）。
 * 非 2xx 响应抛出 retryable-flagged ModelError。
 */
export function createFetchTransport(opts: FetchTransportOptions): Transport {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const retryPolicy = opts.retryPolicy ?? createRetryPolicy();
  const circuitBreaker = opts.circuitBreaker ?? createCircuitBreaker();

  return async function* (request, signal): AsyncIterable<Uint8Array> {
    const body = buildChatBody(request);
    let attempt = 0;
    for (;;) {
      // 熔断检查（P0-10）
      if (!circuitBreaker.allowRequest()) {
        throw new ModelError('provider circuit breaker open — 快速失败（连续失败过多）', {
          provider: request.provider,
          model: request.model,
          code: 'CIRCUIT_OPEN',
          retryable: false,
        });
      }
      let response: Response;
      try {
        response = await fetchImpl(`${opts.baseUrl.replace(/\/$/, '')}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            ...(opts.apiKey ? { Authorization: `Bearer ${opts.apiKey}` } : {}),
          },
          body: JSON.stringify(body),
          signal,
        });
      } catch (e: unknown) {
        // 网络错误（Abort 除外）→ 可重试
        if (signal?.aborted) throw e;
        circuitBreaker.recordFailure();
        const netErr = e instanceof Error ? e : new Error(String(e));
        if (retryPolicy.shouldRetry(attempt, { code: 'NETWORK_ERROR', retryable: true })) {
          // §14 修复：attempt 语义 = 当前失败次数（0 起）。先算 delay（attempt=0 → 2^0=base），
          // 再 attempt += 1 进入下一次循环 —— 禁止先 +1 再算 delay（会跳过 2^0 档）。
          const delay = retryPolicy.delayMs(attempt);
          attempt += 1;
          await retryPolicy.sleep(delay, signal);
          continue;
        }
        throw new ModelError(`provider network error: ${netErr.message}`, {
          provider: request.provider,
          model: request.model,
          code: 'NETWORK_ERROR',
          retryable: true,
        });
      }

      if (!response.ok) {
        circuitBreaker.recordFailure();
        const text = await response.text().catch(() => '');
        // Retry-After 头（秒）→ 毫秒
        const retryAfterHeader = response.headers.get('retry-after');
        const retryAfterMs = retryAfterHeader !== null && Number(retryAfterHeader) > 0
          ? Number(retryAfterHeader) * 1000
          : undefined;
        const err = new ModelError(`provider request failed (${response.status}): ${text.slice(0, 200)}`, {
          provider: request.provider,
          model: request.model,
          code: response.status === 429 ? 'RATE_LIMIT' : 'PROVIDER_UNAVAILABLE',
          statusCode: response.status,
          retryable: response.status === 429 || response.status >= 500,
        });
        // 附加 retryAfterMs（供 RetryPolicy 尊重 Retry-After）
        const withRetryAfter = Object.assign(err, { retryAfterMs });
        if (retryPolicy.shouldRetry(attempt, withRetryAfter)) {
          // §14 修复：先按当前 attempt 计算 delay，再递增 —— 首次重试用 2^0 档
          const delay = retryPolicy.delayMs(attempt, extractRetryAfterMs(withRetryAfter));
          attempt += 1;
          await retryPolicy.sleep(delay, signal);
          continue;
        }
        throw err;
      }

      // 成功：重置熔断计数
      circuitBreaker.recordSuccess();

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
    }
  };
}

/**
 * Find the next SSE frame boundary in a buffer.
 * Returns the index of the boundary start, or -1 when no complete frame yet.
 * Supports \r\n\r\n (CRLF) and \n\n (LF) — standard SSE frame delimiters (P1-02).
 */
function findFrameBoundary(buffer: string): number {
  const crlf = buffer.indexOf('\r\n\r\n');
  const lf = buffer.indexOf('\n\n');
  if (crlf === -1) return lf;
  if (lf === -1) return crlf;
  return Math.min(crlf, lf);
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
  /** P0-10: 自定义 RetryPolicy（缺省 3 次重试 + jitter） */
  retryPolicy?: ReturnType<typeof createRetryPolicy>;
  /** P0-10: 自定义 CircuitBreaker（缺省 5 次失败熔断 30s） */
  circuitBreaker?: ReturnType<typeof createCircuitBreaker>;
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
  private readonly retryPolicy?: ReturnType<typeof createRetryPolicy>;
  private readonly circuitBreaker?: ReturnType<typeof createCircuitBreaker>;

  constructor(options: OpenAICompatibleAdapterOptions) {
    this.providerId = options.providerId;
    this.baseUrl = options.baseUrl ?? 'https://api.openai.com/v1';
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.transport = options.transport;
    this.mock = options.mock;
    this.allowHttpTransport = options.allowHttpTransport ?? false;
    this.retryPolicy = options.retryPolicy;
    this.circuitBreaker = options.circuitBreaker;
  }

  /**
   * Non-streaming completion — delegates to streamMessages + streamToComplete.
   * P1-03 修复：元数据（provider/model）显式注入 accumulator，
   * 使 streamToComplete 生成的 Response 独立完整（不再依赖外部二次注入）。
   */
  async complete(request: ModelRequest): Promise<ModelResponse> {
    const stream = this.streamMessages(request);
    const response = await streamToComplete(stream, {
      provider: request.provider || this.providerId,
      model: request.model,
    });
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
        // P0-10：自定义 RetryPolicy / CircuitBreaker 透传（缺省由 transport 内部创建）
        retryPolicy: this.retryPolicy,
        circuitBreaker: this.circuitBreaker,
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
   *
   * P1-02 修复：使用标准 SSE 帧边界（\r\n\r\n 或 \n\n）逐帧解析，而不是
   * 仅按 \n\n 切分 —— 部分 Provider 使用 CRLF 会导致内容积压到 buffer 最后
   * 才大段处理（"看起来流式，实际最后一起出来"）。同时支持多行 data 拼接、
   * event:/id:/retry: 字段、混合 CRLF/LF。
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

    /** 解析一帧（不含结尾空行）：逐行提取 data: 字段，支持多行 data 拼接 */
    const parseFrame = function* (frame: string): Generator<StreamChunk> {
      const dataLines: string[] = [];
      for (const rawLine of frame.split(/\r?\n/)) {
        const line = rawLine.replace(/\r$/, '');
        if (line.startsWith('data:')) {
          // data: 后单个前导空格剥离；多行 data 以 \n 拼接
          dataLines.push(line.slice(5).replace(/^ /, ''));
        }
        // event:/id:/retry: 行在本协议中忽略（OpenAI 兼容流只关心 data:）
      }
      if (dataLines.length === 0) return;
      const data = dataLines.join('\n');
      yield* handleData(data);
    };

    for await (const chunk of transportStream) {
      buffer += decoder.decode(chunk, { stream: true });

      // 标准 SSE 帧边界：\r\n\r\n 或 \n\n（含混合）
      let boundaryIndex: number;
      while ((boundaryIndex = findFrameBoundary(buffer)) !== -1) {
        const frame = buffer.slice(0, boundaryIndex);
        buffer = buffer.slice(boundaryIndex + (buffer.startsWith('\r\n\r\n', boundaryIndex) ? 4 : 2));
        if (frame.length > 0) {
          yield* parseFrame(frame);
          if (finished) return;
        }
      }
    }

    // Flush any remaining buffer（EOF 尾部，无空行终止）
    if (buffer.trim()) {
      yield* parseFrame(buffer);
      if (finished) return;
    }

    // §17 修复：EOF 未收到 [DONE] 且无 finish_reason → 流被截断（STREAM_CLOSED 语义）。
    // 不得补发 stop（否则断流会被伪装成正常完成）；streamToComplete 据此判定
    // finishReason='error' + interrupted=true，上层（execution-loop / orchestration）
    // 将断流标记为 failed/interrupted 而非 completed。
    // 正常流已在 handleData / mapWireChunk 中通过 [DONE] 或 finish_reason 触发 finishOnce。
    return;
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