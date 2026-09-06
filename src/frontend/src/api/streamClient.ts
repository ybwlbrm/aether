import type { AgentEventEnvelope } from '@pacc/shared';

const BASE = '/api';

/**
 * 统一流事件 — 判别联合（对齐 StreamChunk 中间层 + 后端 agent.output.* 协议）。
 * Chat/CodingHome 只消费此联合，不再感知 SSE 事件名与新旧协议差异。
 */
export type StreamEvent =
  | { kind: 'envelope'; ev: AgentEventEnvelope }
  | { kind: 'text-delta'; text: string }
  | { kind: 'reasoning-delta'; text: string }
  | { kind: 'reasoning-end' }
  | { kind: 'usage'; usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } }
  | { kind: 'retry'; retry: { attempt: number; maxRetries: number; status: number; delay: number } }
  | { kind: 'tool-call'; toolCall: { name: string; arguments: any; id: string } }
  | { kind: 'tool-result'; toolResult: { name: string; result: string; id: string } }
  | { kind: 'replace'; content: string }
  | { kind: 'ask-confirm'; approval: { id: string; toolName: string; argsSummary: string } }
  | { kind: 'error'; message: string }
  | { kind: 'stream-truncated' };

export interface StreamCallbacks {
  /** 判别联合统一事件 */
  onEvent: (event: StreamEvent) => void;
  /** 兼容旧协议回调（保留一个版本作为弃用 shim，内部由同一解析器驱动） */
  onChunk?: (delta: string) => void;
  onToken?: (usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }) => void;
  onToolCall?: (toolCall: { name: string; arguments: any; id: string }) => void;
  onToolResult?: (toolResult: { name: string; result: string; id: string }) => void;
  onReasoning?: (reasoning: string) => void;
  onRetry?: (retry: { attempt: number; maxRetries: number; status: number; delay: number }) => void;
  onReplace?: (content: string) => void;
  onStreamError?: (e: unknown) => void;
}

interface SseFrame {
  eventName: string;
  dataLine: string;
}

/** 解析单个 SSE 帧（CRLF / 多行 data 均正确处理）——导出供页面/测试复用 */
export function parseSseFrame(rawEvent: string): SseFrame {
  let eventName = 'message';
  let dataLine = '';
  for (const line of rawEvent.split(/\r?\n/)) {
    if (line.startsWith('event:')) eventName = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLine += stripSseDataSpace(line.slice(5)) + '\n';
  }
  dataLine = dataLine.replace(/\n$/, '');
  return { eventName, dataLine };
}

/** SSE 规范：`data:` 后的单个可选空格应被忽略（`data: hello` 与 `data:hello` 等价） */
function stripSseDataSpace(value: string): string {
  return value.startsWith(' ') ? value.slice(1) : value;
}

/** 是否为统一协议 envelope（事件名 = eventType，载荷含 eventId/seq） */
function isEnvelopePayload(payload: any): payload is AgentEventEnvelope {
  return Boolean(payload && payload.eventType && typeof payload.seq === 'number' && payload.eventId);
}

/**
 * 统一 SSE 流解析器 — 全事件转 StreamEvent 判别联合。
 * 后端双轨（新协议 envelope 事件名 + 旧事件名）在此单点归一，页面只消费联合。
 *
 * P0-14/P0-15：返回 Promise<void> — 只有流**完整结束**（或业务终结事件已收到）
 * 才 resolve；网络错误 / 解析错误 / 意外 EOF 一律 reject，让调用方（useStreamSend）
 * 能正确进入 error 分支。onStreamError 回调保留为双保险（兼容层）。
 */
function parseSSEStream(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  callbacks: StreamCallbacks,
): Promise<void> {
  const decoder = new TextDecoder();
  let buffer = '';
  let sawTerminal = false; // task.completed / task.failed / agent.output.completed

  const emit = (ev: StreamEvent) => {
    // 兼容层：旧回调从联合事件派生（单点双发，保持一个版本）
    if (ev.kind === 'text-delta') callbacks.onChunk?.(ev.text);
    else if (ev.kind === 'reasoning-delta') callbacks.onReasoning?.(ev.text);
    else if (ev.kind === 'usage') callbacks.onToken?.(ev.usage);
    else if (ev.kind === 'retry') callbacks.onRetry?.(ev.retry);
    else if (ev.kind === 'tool-call') callbacks.onToolCall?.(ev.toolCall);
    else if (ev.kind === 'tool-result') callbacks.onToolResult?.(ev.toolResult);
    else if (ev.kind === 'replace') callbacks.onReplace?.(ev.content);
    else if (ev.kind === 'error') callbacks.onStreamError?.(new Error(ev.message));
    callbacks.onEvent(ev);
  };

  const handleRawEvent = (rawEvent: string) => {
    const { eventName, dataLine } = parseSseFrame(rawEvent);
    if (!dataLine || dataLine === '[DONE]') return;
    let payload: any;
    try { payload = JSON.parse(dataLine); } catch { return; }

    // 统一协议 envelope（事件名 = eventType）
    if (isEnvelopePayload(payload)) {
      const ev = payload as AgentEventEnvelope;
      if (ev.eventType === 'task.completed' || ev.eventType === 'task.failed' || ev.eventType === 'agent.output.completed') {
        sawTerminal = true;
      }
      emit({ kind: 'envelope', ev });
      return;
    }

    // 旧事件名兼容层 → 联合事件
    switch (eventName) {
      case 'error':
        emit({ kind: 'error', message: payload.message || 'AI 响应出错' });
        break;
      case 'token':
        emit({ kind: 'usage', usage: { prompt_tokens: payload.prompt_tokens || 0, completion_tokens: payload.completion_tokens || 0, total_tokens: payload.total_tokens || 0 } });
        break;
      case 'reasoning':
        if (payload.content) emit({ kind: 'reasoning-delta', text: payload.content });
        break;
      case 'reasoning-end':
        emit({ kind: 'reasoning-end' });
        break;
      case 'retry':
        emit({ kind: 'retry', retry: { attempt: payload.attempt, maxRetries: payload.maxRetries, status: payload.status, delay: payload.delay } });
        break;
      case 'tool-call':
        emit({ kind: 'tool-call', toolCall: { name: payload.name, arguments: payload.arguments, id: payload.id } });
        break;
      case 'tool-result':
        emit({ kind: 'tool-result', toolResult: { name: payload.name, result: payload.result, id: payload.id } });
        break;
      case 'message-replace':
        emit({ kind: 'replace', content: String(payload.content || '') });
        break;
      case 'ask-confirm':
        emit({ kind: 'ask-confirm', approval: { id: payload.id, toolName: payload.toolName, argsSummary: payload.argsSummary } });
        break;
      default:
        if (typeof payload.content === 'string' && payload.content) emit({ kind: 'text-delta', text: payload.content });
    }
  };

  const process = async (): Promise<void> => {
    let eof = false;
    while (true) {
      const { done, value } = await reader.read();
      if (done) { eof = true; break; }
      buffer += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const rawEvent = buffer.slice(0, idx);
        buffer = buffer.slice(idx + (buffer[idx] === '\r' ? 4 : 2));
        handleRawEvent(rawEvent);
      }
    }
    const tail = decoder.decode();
    if (tail) buffer += tail;
    let idx;
    while ((idx = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const rawEvent = buffer.slice(0, idx);
      buffer = buffer.slice(idx + (buffer[idx] === '\r' ? 4 : 2));
      handleRawEvent(rawEvent);
    }
    // 断流检测：EOF 但未收到任何终结事件 → 暴露 stream-truncated（对齐 harness STREAM_CLOSED 语义）
    if (eof && !sawTerminal) {
      emit({ kind: 'stream-truncated' });
    }
  };

  // P0-14/P0-15：process 的异常必须向外 reject；同时保留 onStreamError 双保险。
  return process().catch((e: unknown) => {
    callbacks.onStreamError?.(e);
    throw e;
  });
}

/**
 * 统一流式发送：普通模式对话（POST /conversations/:id/messages）
 */
export async function streamConversation(
  conversationId: string,
  content: string,
  callbacks: StreamCallbacks,
  opts?: { signal?: AbortSignal; images?: string[]; providerId?: string; model?: string; files?: { name: string; dataUrl: string }[]; deepThinking?: boolean; reasoningEffort?: 'low' | 'medium' | 'high'; webSearch?: boolean; loop?: boolean },
): Promise<void> {
  const res = await fetch(`${BASE}/conversations/${conversationId}/messages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    body: JSON.stringify({
      content,
      images: opts?.images,
      providerId: opts?.providerId,
      model: opts?.model,
      files: opts?.files,
  deepThinking: opts?.deepThinking,
  reasoningEffort: opts?.reasoningEffort,
  webSearch: opts?.webSearch,
  loop: opts?.loop,
    }),
    signal: opts?.signal,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: { message: '网络错误' } }));
    throw new Error(err.error?.message || `请求失败: ${res.status}`);
  }
  if (!res.body) throw new Error('浏览器不支持流式响应');
  // P0-14：await 整个 SSE 流 —— 完整结束 / 业务终态 / 错误 / abort 后才返回
  await parseSSEStream(res.body.getReader(), callbacks);
}

/**
 * 统一流式发送：超级模式编排（POST /agents/orchestrate）
 */
export async function streamOrchestrate(
  body: { prompt: string; conversationId?: string; history?: any[]; images?: string[]; files?: { name: string; dataUrl: string }[]; deepThinking?: boolean; reasoningEffort?: 'low' | 'medium' | 'high'; webSearch?: boolean; loop?: boolean },
  callbacks: StreamCallbacks,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${BASE}/agents/orchestrate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    body: JSON.stringify(body),
    signal,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: { message: '网络错误' } }));
    throw new Error(err.error?.message || `请求失败: ${res.status}`);
  }
  if (!res.body) throw new Error('浏览器不支持流式响应');
  // P0-14：await 整个 SSE 流 —— 完整结束 / 业务终态 / 错误 / abort 后才返回
  await parseSSEStream(res.body.getReader(), callbacks);
}

/**
 * 回放 / 增量 catch-up：拉取某会话 afterSeq 之后的事件（刷新/断线恢复）
 */
export async function fetchEvents(
  conversationId: string,
  afterSeq?: number,
): Promise<AgentEventEnvelope[]> {
  const query = afterSeq != null ? `?afterSeq=${afterSeq}` : '';
  const res = await fetch(`${BASE}/conversations/${conversationId}/events${query}`, {
    headers: { 'X-Requested-With': 'XMLHttpRequest' },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: { message: '网络错误' } }));
    throw new Error(err.error?.message || `请求失败: ${res.status}`);
  }
  const data = await res.json();
  return Array.isArray(data?.events) ? (data.events as AgentEventEnvelope[]) : [];
}