/**
 * LLM 流式输出中间协议 — Provider-neutral StreamChunk（对齐 DeepSeek Harness 的 llm 协议）
 *
 * 设计要点：
 * - UI 与 wire 协议解耦：后端把任意 provider 的 wire chunk 翻译成统一的 StreamChunk 事件流，
 *   前端/消费者只依赖此协议，不感知具体 provider 的字段差异（reasoning_content vs reasoning 等）。
 * - 七种事件：block-start / text-delta / reasoning-delta / tool-call-delta / block-end / usage / finish。
 * - block 有 index（0..n），同一轮回复内 text/reasoning/tool-call 三类块可以交错出现。
 * - usage 与 finish 延迟到流结束（[DONE] 哨兵）才发出，兼容两种 provider 形态。
 * - 本文件必须保持运行时零依赖（types + consts only），供前后端共同 import。
 */

/** SSE 结束哨兵 */
export const SSE_DONE = '[DONE]';

/** 流错误码 */
export type StreamErrorCode =
  | 'STREAM_CLOSED'      // EOF 未收到 [DONE]，流被截断
  | 'MALFORMED_RESPONSE' // payload 非法 JSON
  | 'EMPTY_RESPONSE';    // stop 但无任何内容块

/** 结束原因（finish_reason 映射 + 本地合成原因） */
export type FinishReason =
  | { kind: 'stop' }
  | { kind: 'tool_calls' }
  | { kind: 'max-tokens' }
  | { kind: 'error'; message: string; code?: StreamErrorCode | string };

/** Token 用量（disjoint 计数：input 不含缓存命中） */
export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens?: number;
  /** 推理 token（部分 provider 单独计数） */
  reasoningTokens?: number;
}

/** 内容块（block-end 携带的完成态） */
export type ContentBlock =
  | { kind: 'text'; text: string }
  | { kind: 'reasoning'; text: string }
  | { kind: 'tool-call'; id: string; name: string; arguments: string };

/** StreamChunk 判别联合 — provider-neutral 中间协议 */
export type StreamChunk =
  | { type: 'block-start'; index: number; blockType: 'text' | 'reasoning' | 'tool-call'; id?: string; name?: string }
  | { type: 'text-delta'; index: number; text: string }
  | { type: 'reasoning-delta'; index: number; text: string }
  | { type: 'tool-call-delta'; index: number; id?: string; name?: string; argumentsDelta: string }
  | { type: 'block-end'; index: number; block: ContentBlock }
  | { type: 'usage'; usage: TokenUsage }
  | { type: 'finish'; reason: FinishReason };

/** 流式错误（sse-parser / translate 抛出） */
export class StreamError extends Error {
  readonly code: StreamErrorCode;
  constructor(code: StreamErrorCode, message: string) {
    super(message);
    this.name = 'StreamError';
    this.code = code;
  }
}

/** 请求级能力开关（对话请求体透传字段） */
export interface StreamRequestOptions {
  /** 深度思考（thinking 模式）。undefined = 跟随 provider 默认 */
  deepThinking?: boolean;
  /** 思考努力度（DeepSeek reasoning_effort） */
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** 联网搜索（决定是否给模型提供 search 系工具） */
  webSearch?: boolean;
}

/** 请求构建结果（对齐 harness serialize.ts 的产物） */
export interface ChatRequestBody {
  model: string;
  messages: Array<Record<string, unknown>>;
  tools?: Array<{ type: 'function'; function: { name: string; description?: string; parameters?: unknown } }>;
  tool_choice?: 'auto' | 'none' | { type: 'function'; function: { name: string } };
  stream: true;
  stream_options?: { include_usage: true };
  thinking?: { type: 'enabled' | 'disabled' };
  reasoning_effort?: 'low' | 'medium' | 'high';
  max_tokens?: number;
  temperature?: number;
}