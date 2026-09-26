/**
 * Model Runtime Core Types
 *
 * Transport-agnostic interfaces for model completion and streaming.
 * Pure TypeScript — no Fastify, no SSE, no React, no zod-for-runtime deps.
 */

import type {
  StreamChunk,
  FinishReason,
  TokenUsage,
} from '@pacc/shared';

/**
 * Model capability flags — bitset-style for efficient composition.
 * Each flag indicates whether the model supports a specific modality.
 */
export interface ModelCapabilities {
  /** Plain text generation */
  text?: boolean;
  /** Vision / image understanding */
  vision?: boolean;
  /** Reasoning / chain-of-thought output */
  reasoning?: boolean;
  /** Tool / function calling */
  toolCalling?: boolean;
  /** Image generation */
  imageGeneration?: boolean;
  /** Audio input/output */
  audio?: boolean;
  /** Video input/output */
  video?: boolean;
  /** Structured output (JSON schema constrained) */
  structuredOutput?: boolean;
}

/**
 * Request payload for model completion/streaming.
 * Provider-agnostic — mapped to provider-specific wire format by adapters.
 */
export interface ModelRequest {
  /** Provider identifier (e.g., 'openai', 'anthropic', 'ollama') */
  provider: string;
  /** Model identifier (e.g., 'gpt-4', 'claude-3-opus') */
  model: string;
  /** Conversation messages in provider-neutral format */
  messages: Array<Record<string, unknown>>;
  /** Optional system prompt */
  systemPrompt?: string;
  /** Sampling temperature (0.0 - 2.0) */
  temperature?: number;
  /** Maximum output tokens */
  maxTokens?: number;
  /** Enable thinking/reasoning mode */
  thinking?: boolean;
  /** Reasoning effort level (P0-11: 透传到 Provider 的 reasoning_effort 参数) */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** Tool definitions for function calling */
  tools?: Array<{
    type: 'function';
    function: {
      name: string;
      description?: string;
      parameters?: unknown;
    };
  }>;
  /** Abort signal for cancellation */
  signal?: AbortSignal;
}

/**
 * Complete (non-streaming) model response.
 * Assembled from stream chunks by `streamToComplete`.
 */
export interface ModelResponse {
  /** Unique response ID */
  id: string;
  /** Provider identifier */
  provider: string;
  /** Model identifier */
  model: string;
  /** Final text content */
  content: string;
  /** Reasoning content (if model supports reasoning) */
  reasoningContent?: string;
  /** Tool calls made during generation */
  toolCalls?: Array<{
    id: string;
    name: string;
    arguments: string;
  }>;
  /** Finish reason from the model */
  finishReason: FinishReason['kind'];
  /** §17: 流被截断（EOF 无 finish chunk）标记 —— true 表示中断而非正常 stop */
  interrupted?: boolean;
  /** Token usage (if provided by provider) */
  usage?: TokenUsage;
}

/**
 * Model runtime interface — implemented by provider adapters.
 * Supports both complete (non-streaming) and streaming modes.
 */
export interface ModelRuntime {
  /**
   * Non-streaming completion.
   * Default implementation delegates to `stream` + `streamToComplete`.
   */
  complete(request: ModelRequest): Promise<ModelResponse>;

  /**
   * Streaming completion — yields provider-neutral StreamChunk events.
   */
  stream(request: ModelRequest): AsyncIterable<StreamChunk>;
}

/**
 * Accumulator state for assembling a complete response from stream chunks.
 */
interface StreamAccumulator {
  id: string;
  provider: string;
  model: string;
  content: string;
  reasoningContent: string;
  toolCalls: Map<string, { id: string; name: string; arguments: string }>;
  finishReason: FinishReason['kind'] | null;
  usage: TokenUsage | null;
  currentBlockIndex: number | null;
  currentBlockType: 'text' | 'reasoning' | 'tool-call' | null;
}

/**
 * Consumes a StreamChunk async iterable and assembles a complete ModelResponse.
 *
 * Handles:
 * - Text delta concatenation
 * - Reasoning delta concatenation
 * - Tool call delta accumulation (arguments are streamed incrementally)
 * - Finish reason extraction
 * - Usage extraction
 *
 * P1-03 修复：id/provider/model 元数据从 ModelRequest 注入（StreamChunk 协议
 * 不携带 provider/model，通用 accumulator 必须由调用方提供这些元数据，
 * 否则生成的 Response 无法独立使用）。
 *
 * @param stream - Async iterable of StreamChunk events
 * @param metadata - 可选元数据（P1-03：provider/model/id 注入）
 * @returns Promise resolving to assembled ModelResponse
 */
export async function streamToComplete(
  stream: AsyncIterable<StreamChunk>,
  metadata?: { provider?: string; model?: string; id?: string },
): Promise<ModelResponse> {
  const acc: StreamAccumulator = {
    id: metadata?.id ?? '',
    provider: metadata?.provider ?? '',
    model: metadata?.model ?? '',
    content: '',
    reasoningContent: '',
    toolCalls: new Map(),
    finishReason: null,
    usage: null,
    currentBlockIndex: null,
    currentBlockType: null,
  };

  for await (const chunk of stream) {
    switch (chunk.type) {
      case 'block-start': {
        acc.currentBlockIndex = chunk.index
        acc.currentBlockType = chunk.blockType
        if (chunk.blockType === 'tool-call') {
          const toolCallId = chunk.id ?? `call_idx_${chunk.index}`
          // block-start 即初始化条目；有 id 用协议 id，无 id 用 block index 稳定占位。
          acc.toolCalls.set(toolCallId, {
            id: toolCallId,
            name: chunk.name ?? '',
            arguments: '',
          })
        }
        break
      }

      case 'text-delta': {
        if (acc.currentBlockType === 'text') {
          acc.content += chunk.text
        }
        break
      }

      case 'reasoning-delta': {
        if (acc.currentBlockType === 'reasoning') {
          acc.reasoningContent += chunk.text
        }
        break
      }

      case 'tool-call-delta': {
        // 有 id 按协议 id 关联；无 id 旧协议按 block index 关联同一个占位 key。
        const toolCallId = chunk.id ?? `call_idx_${chunk.index}`
        const prev = acc.toolCalls.get(toolCallId)
        if (prev) {
          acc.toolCalls.set(toolCallId, {
            id: toolCallId,
            name: chunk.name ?? prev.name,
            arguments: prev.arguments + chunk.argumentsDelta,
          })
        }
        break
      }

      case 'block-end': {
        // Block-end 自带完整 block；tool-call 的 arguments 以 delta 累积为准
        // （并行交错时 block-end 不得覆盖累积结果）。仅对缺少
        // block-start/delta 的孤立 block-end 用 block 数据兜底。
        if (chunk.block.kind === 'tool-call' && chunk.block.id && !acc.toolCalls.has(chunk.block.id)) {
          acc.toolCalls.set(chunk.block.id, {
            id: chunk.block.id,
            name: chunk.block.name,
            arguments: chunk.block.arguments,
          })
        }
        acc.currentBlockIndex = null
        acc.currentBlockType = null
        break
      }

      case 'usage': {
        acc.usage = chunk.usage;
        break;
      }

      case 'finish': {
        acc.finishReason = chunk.reason.kind;
        break;
      }
    }
  }

  // Generate a response ID if not provided by the stream
  const responseId = acc.id || `resp_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;

  // §17 修复：EOF 无 finish chunk = 流被截断（STREAM_INTERRUPTED），
  // 禁止伪装成正常 stop。只有收到明确 finish 才成立 finishReason；
  // 否则标记 'error'（由调用方结合 interrupted 标志识别中断），由上层决定恢复策略。
  const interrupted = acc.finishReason === null;
  const finishReason: ModelResponse['finishReason'] = acc.finishReason ?? 'error';

  return {
    id: responseId,
    provider: acc.provider,
    model: acc.model,
    content: acc.content,
    reasoningContent: acc.reasoningContent || undefined,
    toolCalls: acc.toolCalls.size > 0 ? Array.from(acc.toolCalls.values()) : undefined,
    finishReason,
    usage: acc.usage ?? undefined,
    ...(interrupted ? { interrupted: true as const } : {}),
  };
}