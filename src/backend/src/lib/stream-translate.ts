/**
 * wire chunk → StreamChunk 翻译器 — 对齐 DeepSeek Harness `packages/llm/llm-deepseek/src/translate.ts` 的语义。
 *
 * 语义要点：
 * - 打开块的时机：首个非空 delta 才创建块（block-start）；空字符串不创建。
 * - text / reasoning 交错时各自维护独立块，增量追加到最近同 kind 块。
 * - tool_calls 按 wire index 组装 arguments；index 缺失时追加到最近 tool 块。
 * - block-end / usage / finish 全部延迟到 [DONE] 才发射（符合 emit-late 语义）。
 * - finish_reason 严格映射：stop→stop、tool_calls→tool_calls、length→max-tokens、未知→error{code 大写}。
 * - 源结束未收到 [DONE] → STREAM_CLOSED。payload 非法 JSON → MALFORMED_RESPONSE。
 * - stop 且零内容块 → EMPTY_RESPONSE。
 */
import { type StreamChunk, type TokenUsage, type FinishReason, StreamError, SSE_DONE } from '@pacc/shared';
import type { ChatRequestBody } from '@pacc/shared';

/** OpenAI-compatible SSE wire chunk */
export interface WireChunk {
  id: string;
  object: string;
  created: number;
  model: string;
  choices: Array<{
    index: number;
    delta: Record<string, unknown>;
    finish_reason: string | null;
  }>;
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

/** 内部打开的块 */
interface OpenBlock {
  index: number;
  kind: 'text' | 'reasoning' | 'tool-call';
  id?: string;
  name?: string;
  text?: string;     // text / reasoning 累积
  args?: string;     // tool-call arguments 累积
  lastWireIndex?: number; // tool-call 的 wire index
}

/** finish_reason 映射（未知 → error，code 大写） */
export function mapFinishReason(fr: string): FinishReason {
  switch (fr) {
    case 'stop': return { kind: 'stop' };
    case 'tool_calls':
    case 'function_call':
      return { kind: 'tool_calls' };
    case 'length': return { kind: 'max-tokens' };
    default:
      return { kind: 'error', message: `finish_reason: ${fr}`, code: fr.toUpperCase() };
  }
}

/** usage 翻译（DeepSeek 的 prompt_tokens 含缓存命中，disjoint 计数取实际 input） */
export function mapUsage(u: { prompt_tokens: number; completion_tokens: number; total_tokens?: number }): TokenUsage {
  return {
    inputTokens: u.prompt_tokens ?? 0,
    outputTokens: u.completion_tokens ?? 0,
    totalTokens: u.total_tokens ?? (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0),
  };
}

/**
 * 把 wire payload 流翻译为 StreamChunk 流。
 * 输入为已由 parseSse 拆帧的 data payload 字符串；[DONE] 触发延迟发射后正常结束。
 */
export async function* translate(payloads: AsyncIterable<string>): AsyncGenerator<StreamChunk> {
  const blocks: OpenBlock[] = [];      // 打开顺序
  const byWireIndex = new Map<number, OpenBlock>();
  let nextIndex = 0;
  let finishReasonRaw: string | null | undefined;
  let usage: TokenUsage | undefined;
  let sawDone = false;

  const openBlock = (kind: OpenBlock['kind'], extra: Partial<OpenBlock> = {}): { block: OpenBlock; events: StreamChunk[] } => {
    const block: OpenBlock = { index: nextIndex++, kind, ...extra };
    blocks.push(block);
    const ev: StreamChunk = {
      type: 'block-start', index: block.index, blockType: kind,
      ...(kind === 'tool-call' ? { id: block.id, name: block.name } : {}),
    };
    return { block, events: [ev] };
  };

  const latestOfKind = (kind: OpenBlock['kind']): OpenBlock | undefined => {
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i].kind === kind) return blocks[i];
    }
    return undefined;
  };

  const pushText = (block: OpenBlock, kind: 'text' | 'reasoning', text: string): StreamChunk[] => {
    block.text = (block.text ?? '') + text;
    return kind === 'text'
      ? [{ type: 'text-delta', index: block.index, text }]
      : [{ type: 'reasoning-delta', index: block.index, text }];
  };

  const pushArgs = (block: OpenBlock, delta: string): StreamChunk[] => {
    block.args = (block.args ?? '') + delta;
    return [{ type: 'tool-call-delta', index: block.index, argumentsDelta: delta }];
  };

  for await (const raw of payloads) {
    if (raw === SSE_DONE) { sawDone = true; break; }

    let chunk: WireChunk;
    try {
      chunk = JSON.parse(raw) as WireChunk;
    } catch {
      throw new StreamError('MALFORMED_RESPONSE', `invalid JSON payload: ${raw.slice(0, 200)}`);
    }

    const choice = chunk.choices?.[0];
    if (choice?.finish_reason != null) finishReasonRaw = choice.finish_reason;
    if (chunk.usage) usage = mapUsage(chunk.usage);
    const delta = choice?.delta;
    if (!delta) continue;

    // 推理内容（DeepSeek: reasoning_content；其他: reasoning）
    const reasoningDelta = (delta.reasoning_content ?? delta.reasoning) as string | undefined;
    if (typeof reasoningDelta === 'string' && reasoningDelta.length > 0) {
      let block = latestOfKind('reasoning');
      if (!block) {
        const opened = openBlock('reasoning');
        block = opened.block;
        for (const ev of opened.events) yield ev;
      }
      for (const ev of pushText(block, 'reasoning', reasoningDelta)) yield ev;
    }

    // 文本内容
    const textDelta = delta.content as string | undefined;
    if (typeof textDelta === 'string' && textDelta.length > 0) {
      let block = latestOfKind('text');
      if (!block) {
        const opened = openBlock('text');
        block = opened.block;
        for (const ev of opened.events) yield ev;
      }
      for (const ev of pushText(block, 'text', textDelta)) yield ev;
    }

    // 工具调用
    const toolCalls = delta.tool_calls as Array<{
      index?: number; id?: string; type?: string;
      function?: { name?: string; arguments?: string };
    }> | undefined;
    if (Array.isArray(toolCalls)) {
      for (const tc of toolCalls) {
        const fn = tc.function;
        if (fn?.name) {
          // 新工具调用开始
          const opened = openBlock('tool-call', { id: tc.id, name: fn.name, lastWireIndex: tc.index, args: fn.arguments ?? '' });
          const block = opened.block;
          for (const ev of opened.events) yield ev;
          if (tc.index !== undefined) byWireIndex.set(tc.index, block);
          if (fn.arguments) yield { type: 'tool-call-delta', index: block.index, id: tc.id, name: fn.name, argumentsDelta: fn.arguments };
        } else {
          // 已有工具调用的参数追加 — index 匹配优先，缺失回退到最近 tool 块
          let block = tc.index !== undefined ? byWireIndex.get(tc.index) : undefined;
          if (!block) block = latestOfKind('tool-call');
          if (block) {
            for (const ev of pushArgs(block, fn?.arguments ?? '')) yield ev;
          }
        }
      }
    }
  }

  if (!sawDone) {
    throw new StreamError('STREAM_CLOSED', 'payload stream closed before [DONE]');
  }

  // ---- 延迟发射：全部 block-end → usage → finish ----
  const openedAny = blocks.length > 0;
  for (const b of blocks) {
    if (b.kind === 'tool-call') {
      yield { type: 'block-end', index: b.index, block: { kind: 'tool-call', id: b.id ?? '', name: b.name ?? '', arguments: b.args ?? '' } };
    } else if (b.kind === 'reasoning') {
      yield { type: 'block-end', index: b.index, block: { kind: 'reasoning', text: b.text ?? '' } };
    } else {
      yield { type: 'block-end', index: b.index, block: { kind: 'text', text: b.text ?? '' } };
    }
  }
  if (usage) yield { type: 'usage', usage };

  const reason = finishReasonRaw != null ? mapFinishReason(finishReasonRaw) : { kind: 'stop' as const };
  // stop / max-tokens 但无任何内容块 → 空响应错误
  if (!openedAny && (reason.kind === 'stop' || reason.kind === 'max-tokens')) {
    yield { type: 'finish', reason: { kind: 'error', message: 'empty response', code: 'EMPTY_RESPONSE' } };
    return;
  }
  yield { type: 'finish', reason };
}

// ---------------------------------------------------------------------------
// 请求构建辅助（对齐 harness serialize.ts）
// ---------------------------------------------------------------------------

export interface BuildBodyArgs {
  model: string;
  messages: Array<Record<string, unknown>>;
  tools?: ChatRequestBody['tools'];
  tool_choice?: ChatRequestBody['tool_choice'];
  deepThinking?: boolean;
  reasoningEffort?: 'low' | 'medium' | 'high';
  /** provider 是否支持 thinking 参数（由 providerSupportsThinking 判断） */
  supportsThinking: boolean;
  max_tokens?: number;
  temperature?: number;
}

/** 构建 OpenAI 兼容 chat/completions 请求体（thinking 由 supportsThinking 门控） */
export function buildChatRequestBody(args: BuildBodyArgs): ChatRequestBody {
  const body: ChatRequestBody = {
    model: args.model,
    messages: args.messages,
    stream: true,
    stream_options: { include_usage: true },
  };
  if (args.tools && args.tools.length > 0) body.tools = args.tools;
  if (args.tool_choice) body.tool_choice = args.tool_choice;
  if (args.supportsThinking) {
    body.thinking = { type: args.deepThinking === false ? 'disabled' : 'enabled' };
    if (args.deepThinking !== false && args.reasoningEffort) body.reasoning_effort = args.reasoningEffort;
  }
  if (args.max_tokens != null) body.max_tokens = args.max_tokens;
  if (args.temperature != null) body.temperature = args.temperature;
  return body;
}

/**
 * 安全解析工具调用 arguments — 失败降级为文本（不透传异常，不炸流）。
 * 返回 { args, ok }；ok=false 时调用方应以文本形式把原始字符串传给工具。
 */
export function parseToolArgsSafe(raw: string | null | undefined): { args: Record<string, unknown>; ok: boolean } {
  if (!raw || raw.trim() === '') return { args: {}, ok: true };
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { args: parsed as Record<string, unknown>, ok: true };
    }
    return { args: {}, ok: true };
  } catch {
    return { args: {}, ok: false };
  }
}