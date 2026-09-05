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
  currentToolCallId: string | null;
  currentToolCallName: string | null;
  currentToolCallArguments: string;
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
 * @param stream - Async iterable of StreamChunk events
 * @returns Promise resolving to assembled ModelResponse
 */
export async function streamToComplete(
  stream: AsyncIterable<StreamChunk>
): Promise<ModelResponse> {
  const acc: StreamAccumulator = {
    id: '',
    provider: '',
    model: '',
    content: '',
    reasoningContent: '',
    toolCalls: new Map(),
    finishReason: null,
    usage: null,
    currentBlockIndex: null,
    currentBlockType: null,
    currentToolCallId: null,
    currentToolCallName: null,
    currentToolCallArguments: '',
  };

  for await (const chunk of stream) {
    switch (chunk.type) {
      case 'block-start': {
        acc.currentBlockIndex = chunk.index;
        acc.currentBlockType = chunk.blockType;
        if (chunk.blockType === 'tool-call') {
          acc.currentToolCallId = chunk.id ?? '';
          acc.currentToolCallName = chunk.name ?? '';
          acc.currentToolCallArguments = '';
        }
        break;
      }

      case 'text-delta': {
        if (acc.currentBlockType === 'text') {
          acc.content += chunk.text;
        }
        break;
      }

      case 'reasoning-delta': {
        if (acc.currentBlockType === 'reasoning') {
          acc.reasoningContent += chunk.text;
        }
        break;
      }

      case 'tool-call-delta': {
        if (acc.currentBlockType === 'tool-call' && chunk.index === acc.currentBlockIndex) {
          acc.currentToolCallArguments += chunk.argumentsDelta;
          // Update the map with accumulated arguments so far
          if (acc.currentToolCallId) {
            acc.toolCalls.set(acc.currentToolCallId, {
              id: acc.currentToolCallId,
              name: acc.currentToolCallName ?? '',
              arguments: acc.currentToolCallArguments,
            });
          }
        }
        break;
      }

      case 'block-end': {
        // Block-end carries the final consolidated block — we already accumulated deltas,
        // but for tool-calls we ensure the final arguments are captured.
        if (chunk.block.kind === 'tool-call' && chunk.index === acc.currentBlockIndex) {
          acc.toolCalls.set(chunk.block.id, {
            id: chunk.block.id,
            name: chunk.block.name,
            arguments: chunk.block.arguments,
          });
        }
        acc.currentBlockIndex = null;
        acc.currentBlockType = null;
        acc.currentToolCallId = null;
        acc.currentToolCallName = null;
        acc.currentToolCallArguments = '';
        break;
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

  return {
    id: responseId,
    provider: acc.provider,
    model: acc.model,
    content: acc.content,
    reasoningContent: acc.reasoningContent || undefined,
    toolCalls: acc.toolCalls.size > 0 ? Array.from(acc.toolCalls.values()) : undefined,
    finishReason: acc.finishReason ?? 'stop',
    usage: acc.usage ?? undefined,
  };
}