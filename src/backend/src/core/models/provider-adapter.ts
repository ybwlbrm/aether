/**
 * Provider Adapter
 *
 * Interface and OpenAI-compatible implementation for model providers.
 * Pure TypeScript — no Fastify, no SSE, no React, no zod-for-runtime deps.
 */

import type { ModelRequest, ModelResponse } from './model-runtime.js'
import type { StreamChunk, TokenUsage, FinishReason } from '@pacc/shared'
import { ModelError, RetryExhaustedError } from '../errors/index.js'
import { streamToComplete } from './model-runtime.js'
import { createRetryPolicy, extractRetryAfterMs, type RetryPolicy } from './retry-policy.js'
import { createCircuitBreaker, type CircuitBreaker } from './circuit-breaker.js'

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
) => AsyncIterable<Uint8Array>

function providerRetryExhausted(
  request: ModelRequest,
  lastError: unknown,
  maxAttempts: number,
): RetryExhaustedError {
  return new RetryExhaustedError(
    `provider retry exhausted after ${maxAttempts} attempts`,
    {
      maxAttempts,
      backoffMs: 0,
      code: 'RETRY_EXHAUSTED',
      lastError,
      context: {
        provider: request.provider,
        model: request.model,
      },
    },
  )
}

/** Options for createFetchTransport */
export interface FetchTransportOptions {
  /** Base URL (e.g. 'https://api.openai.com/v1') — the /chat/completions path is appended */
  baseUrl: string;
  /** API key (sent as `Authorization: Bearer <key>`) */
  apiKey?: string;
  /** Custom fetch implementation (for testing / non-browser envs) */
  fetchImpl?: typeof fetch;
  /** Retry policy（缺省创建：5 次重试 + jitter） */
  retryPolicy?: RetryPolicy;
  /** Circuit breaker（缺省创建：5 次失败熔断 30s） */
  circuitBreaker?: CircuitBreaker;
}

/**
 * 流是否被"取消"（用户 abort / Run cancel）—— 与"流失败"是两种不同的结果：
 * 取消不是 Provider 故障，既不记熔断成功也不记熔断失败，更不可重试。
 */
function isStreamCancelled(error: unknown, signal: AbortSignal | undefined): boolean {
  if (signal?.aborted) return true;
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

/**
 * STREAM_CLOSED —— 流被截断/中断的**唯一**错误形态（P0-009）。
 * 此前截断只写注释不抛错、连接重置裸穿出，导致 retry-policy.ts / execution-retry.ts
 * 里既有的 STREAM_CLOSED 可重试判定没有任何生产者（死分支）。现在由 provider 层
 * 显式抛出可重试错误，重试决策交给上层（重放整轮执行，而非在半截内容上重试）。
 */
function streamClosedError(request: ModelRequest, message: string, cause?: unknown): ModelError {
  return new ModelError(message, {
    provider: request.provider,
    model: request.model,
    code: 'STREAM_CLOSED',
    retryable: true,
    cause,
  });
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

/**
 * Real HTTP transport: POSTs to `{baseUrl}/chat/completions` with the SSE
 * stream enabled and yields the raw response body bytes. This is the wire
 * path the legacy `fetch(.../chat/completions)` calls migrate onto.
 *
 * P0-10 收口：429/5xx 自动重试（指数退避 + jitter + Retry-After 尊重 +
 * abortable sleep），连续失败触发熔断（快速失败，避免拖垮 Provider 查询）。
 * 非 2xx 响应抛出 retryable-flagged ModelError。
 *
 * P0-007/008/009 熔断记账边界：
 * - 本层（响应头之前）：网络错误 / 429 / 5xx / 空 body 重试耗尽 → recordFailure。
 *   这类失败发生在"还没拿到任何模型输出"时，判定权完全在本层。
 * - 本层（响应头之后 / 流阶段）：**不记成功**。HTTP 200 只代表 headers accepted，
 *   EOF 也可能只是断流；只有上层 parseSSEStream 看到 [DONE] / finish_reason 才允许
 *   recordSuccess。此处若在拿到 200 时就记成功，截断流会把连续失败计数清零，
 *   熔断阈值永远到不了（CIRCUIT_OPEN 成为死代码）。
 * - 读流错误（连接重置/流中断）在本层归一为 STREAM_CLOSED 并 recordFailure；
 *   "流是否真的跑完"由上层判定，两者不重复记账。
 */
export function createFetchTransport(opts: FetchTransportOptions): Transport {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
  const retryPolicy = opts.retryPolicy ?? createRetryPolicy();
  const circuitBreaker = opts.circuitBreaker ?? createCircuitBreaker();

  return async function* (request, signal): AsyncIterable<Uint8Array> {
    const body = buildChatBody(request)
    let attempt = 0
    for (;;) {
      if (attempt === 0 && !circuitBreaker.allowRequest()) {
        throw new ModelError('provider circuit breaker open — 快速失败（连续失败过多）', {
          provider: request.provider,
          model: request.model,
          code: 'CIRCUIT_OPEN',
          retryable: false,
        })
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
        const netErr = new ModelError(`provider network error: ${e instanceof Error ? e.message : String(e)}`, {
          provider: request.provider,
          model: request.model,
          code: 'NETWORK_ERROR',
          retryable: true,
        })
        const netDecision = retryPolicy.decide(attempt, netErr)
        if (netDecision.retry) {
          attempt += 1
          await retryPolicy.sleep(netDecision.delayMs, signal)
          continue
        }
        circuitBreaker.recordFailure()
        throw providerRetryExhausted(request, netErr, retryPolicy.maxAttempts)
      }

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        // Retry-After 头（支持秒数/HTTP-date/0；由 extractRetryAfterMs 统一解析）→ 毫秒
        const retryAfterHeader = response.headers.get('retry-after');
        const retryAfterMs = retryAfterHeader !== null ? extractRetryAfterMs(retryAfterHeader) : undefined;
        const retryable = response.status === 429 || response.status >= 500;
        const err = new ModelError(`provider request failed (${response.status}): ${text.slice(0, 200)}`, {
          provider: request.provider,
          model: request.model,
          code: response.status === 429 ? 'RATE_LIMIT' : 'PROVIDER_UNAVAILABLE',
          statusCode: response.status,
          retryable,
        });
        // 熔断只记录可重试的传输级失败（429/5xx）；4xx 属业务错误，不应累积熔断失败。
        const withRetryAfter = Object.assign(err, { retryAfterMs })
        const httpDecision = retryPolicy.decide(attempt, withRetryAfter, retryAfterMs)
        if (httpDecision.retry) {
          attempt += 1
          await retryPolicy.sleep(httpDecision.delayMs, signal)
          continue
        }
        if (retryable) {
          circuitBreaker.recordFailure()
          throw providerRetryExhausted(request, err, retryPolicy.maxAttempts)
        }
        throw err
      }

      if (!response.body) {
        const emptyBodyError = new ModelError('provider returned an empty body', {
          provider: request.provider,
          model: request.model,
          code: 'PROVIDER_UNAVAILABLE',
          retryable: true,
        })
        const emptyDecision = retryPolicy.decide(attempt, emptyBodyError)
        if (emptyDecision.retry) {
          attempt += 1
          await retryPolicy.sleep(emptyDecision.delayMs, signal)
          continue
        }
        circuitBreaker.recordFailure()
        throw providerRetryExhausted(request, emptyBodyError, retryPolicy.maxAttempts)
      }

      // §17 / P0-008：headers accepted ≠ 执行成功 —— 刻意不在此处 recordSuccess。
      // 记账由上层 parseSSEStream 在看到 terminator（[DONE] / finish_reason）后完成。
      const reader = response.body.getReader()
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          yield value;
        }
      } catch (e: unknown) {
        // 取消（用户 abort）不是 Provider 故障：原样抛出，不污染熔断计数。
        if (isStreamCancelled(e, signal)) throw e;
        // 连接重置 / 流中断 → 计入熔断失败，并抛可重试的 STREAM_CLOSED，
        // 让 retry-policy / execution-retry 既有的 STREAM_CLOSED 判定有生产者。
        // 刻意不在本层重试：已经 yield 出部分内容，重放会重复输出（重试决策上移一层）。
        circuitBreaker.recordFailure();
        throw streamClosedError(
          request,
          `provider stream interrupted: ${e instanceof Error ? e.message : String(e)}`,
          e,
        );
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
  /** P0-10: 自定义 RetryPolicy（缺省 5 次重试 + jitter） */
  retryPolicy?: RetryPolicy;
  /** P0-10: 自定义 CircuitBreaker（缺省 5 次失败熔断 30s）
   *  P0-007：必须是 **provider 级** 实例（由 lib/model-runtime-bridge.ts 的
   *  ProviderRuntimeRegistry 持有并在同一 providerId 的所有请求间复用），
   *  否则每请求新建熔断器 → consecutiveFailures 永远到不了阈值。 */
  circuitBreaker?: CircuitBreaker;
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
  private readonly retryPolicy?: RetryPolicy
  private readonly circuitBreaker?: CircuitBreaker
  private readonly httpTransport?: Transport

  constructor(options: OpenAICompatibleAdapterOptions) {
    this.providerId = options.providerId;
    this.baseUrl = options.baseUrl ?? 'https://api.openai.com/v1';
    this.apiKey = options.apiKey;
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.transport = options.transport;
    this.mock = options.mock;
    this.allowHttpTransport = options.allowHttpTransport ?? false;
    this.retryPolicy = options.retryPolicy
    this.circuitBreaker = options.circuitBreaker
    this.httpTransport = this.allowHttpTransport
      ? createFetchTransport({
        baseUrl: this.baseUrl,
        apiKey: this.apiKey,
        fetchImpl: this.fetchImpl,
        retryPolicy: this.retryPolicy,
        circuitBreaker: this.circuitBreaker,
      })
      : undefined
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
    if (this.allowHttpTransport && this.httpTransport) {
      yield* this.parseSSEStream(request, this.httpTransport)
      return
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
   *
   * P0-008/P0-009：流阶段熔断记账与终态判定的**唯一**收口点。五种流结果：
   * | 结果              | 判定                              | 熔断   | 对外表现                       |
   * |-------------------|-----------------------------------|--------|------------------------------|
   * | headers accepted  | HTTP 2xx + 拿到 body              | 不记账 | 继续解析                      |
   * | stream completed  | 收到 [DONE] 或 finish_reason      | 成功   | finish(normal)                |
   * | stream truncated  | EOF 无 [DONE] 且无 finish_reason  | 失败   | 抛 STREAM_CLOSED(retryable)   |
   * | stream parse error| 帧 JSON 非法（终态 error）        | 失败   | finish(MALFORMED_RESPONSE)    |
   * | stream cancelled  | abort / Run cancel                 | 不记账 | 原样抛出 AbortError           |
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
    // 解析出错（malformed JSON）→ 终态按失败记账，不被后续 terminator 覆盖
    let parseFailed = false;

    // Emit a single finish event (only once per stream).
    const finishOnce = function* (reason: FinishReason = { kind: 'stop' }): Generator<StreamChunk> {
      if (!finished) {
        finished = true;
        yield { type: 'finish', reason };
      }
    };

    /**
     * 熔断记账（流阶段唯一写入点，每个出口恰好调用一次）：
     * 只有 stream completed 才记成功；truncated / parse error 记失败。
     */
    const recordOutcome = (completed: boolean): void => {
      if (completed) this.circuitBreaker?.recordSuccess();
      else this.circuitBreaker?.recordFailure();
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
      } catch (error: unknown) {
        const detail = error instanceof Error ? error.message : String(error)
        parseFailed = true
        yield* finishOnce({
          kind: 'error',
          message: `malformed provider JSON: ${detail}`,
          code: 'MALFORMED_RESPONSE',
        })
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

    try {
      for await (const chunk of transportStream) {
        buffer += decoder.decode(chunk, { stream: true });

        // 标准 SSE 帧边界：\r\n\r\n 或 \n\n（含混合）
        let boundaryIndex: number;
        while ((boundaryIndex = findFrameBoundary(buffer)) !== -1) {
          const frame = buffer.slice(0, boundaryIndex);
          buffer = buffer.slice(boundaryIndex + (buffer.startsWith('\r\n\r\n', boundaryIndex) ? 4 : 2));
          if (frame.length > 0) {
            yield* parseFrame(frame);
            if (finished) {
              // stream completed（或以 parse error 终态）—— 此刻才允许记成功
              recordOutcome(!parseFailed);
              return;
            }
          }
        }
      }
    } catch (error: unknown) {
      // 流被取消 → 原样抛出，既不记成功也不记失败（不是 Provider 故障）
      if (isStreamCancelled(error, request.signal)) throw error;
      // transport 已归类并记账的错误（STREAM_CLOSED / RATE_LIMIT / PROVIDER_UNAVAILABLE /
      // NETWORK_ERROR / CIRCUIT_OPEN / RetryExhausted）既不重复记账也不重新包装；
      // 裸错误只可能来自自定义注入的 transport（无 HTTP 层记账），由本层收口。
      const classified =
        ModelError.isModelError(error) || error instanceof RetryExhaustedError;
      if (!classified) this.circuitBreaker?.recordFailure();
      throw classified
        ? error
        : streamClosedError(
            request,
            `provider stream failed: ${error instanceof Error ? error.message : String(error)}`,
            error,
          );
    }

    // Flush any remaining buffer（EOF 尾部，无空行终止）
    if (buffer.trim()) {
      yield* parseFrame(buffer);
      if (finished) {
        recordOutcome(!parseFailed);
        return;
      }
    }

    // P0-009：EOF 未收到 [DONE] 且无 finish_reason → 流被截断（STREAM_CLOSED 语义）。
    // 旧实现只写注释静默 return：断流被伪装成正常结束，且 retry-policy.ts /
    // execution-retry.ts 里既有的 STREAM_CLOSED 可重试判定没有任何生产者（死分支）。
    // 现在显式抛可重试错误 —— 上层据此重试整轮或把 Run 标记 failed/interrupted；
    // 补发 stop 仍然禁止（否则断流会被伪装成正常完成）。
    recordOutcome(false);
    throw streamClosedError(request, 'provider stream truncated: EOF without [DONE] or finish_reason');
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
      let finishReason: FinishReason = { kind: 'stop' };
       switch (choice.finish_reason) {
         case 'stop':
           finishReason = { kind: 'stop' };
           break;
         case 'tool_calls':

          finishReason = { kind: 'tool_calls' };
          break;
        case 'length':
          finishReason = { kind: 'max-tokens' };
          break;
        case 'content_filter':
          finishReason = { kind: 'content_filter' };
          break;
        default:
          finishReason = { kind: 'error', message: `finish_reason: ${choice.finish_reason ?? 'unknown'}`, code: 'PROVIDER_FINISH_REASON' };
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

      return finishReason;
    }

    return undefined;
  }
}