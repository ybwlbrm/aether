/**
 * Aether v2 Run SSE — 可续传 fetch-based SSE reader
 *
 * 消费 `GET /api/runs/:runId/stream`。之所以不用 native `EventSource`：它无法设置
 * `Authorization` / `Last-Event-ID` header，而本项目后端默认拒绝鉴权，且断线续传
 * 依赖 `Last-Event-ID`。fetch + ReadableStream 是唯一能同时满足两者的通道。
 *
 * 模块被刻意拆成两个可独立测试的半部：
 * - `createFrameDecoder()` —— 纯函数增量解码器（chunk 边界安全，无 IO、无全局状态）
 * - `streamRunEvents()`     —— fetch reader 封装（IO、路由、生命周期）
 *
 * 终态语义：服务端在推完终态事件后主动关闭连接。**流关闭是 run 完成的正常信号，
 * 不是错误** —— reader 只把关闭事实交给调用方，不在这里猜测 run 状态。
 */

import { AGENT_EVENT_TYPES_V2, isAgentEvent, type AgentEvent } from '@pacc/shared';
import { getAuthToken } from './client';

const BASE = '/api';

/** 单个 SSE 帧（字段语义与后端 core/events/sse-transport.formatSseEvent 对齐） */
export interface SseFrame {
  /** 帧 id —— 后端写入 `id: <seq>`，即 Last-Event-ID 续传游标 */
  id?: string;
  /** 事件名 —— 后端写入 `event: <type>`；缺省时为 'message' */
  event?: string;
  /** 拼接后的 data 内容（多行 data 以 '\n' 连接） */
  data: string;
}

/** 增量帧解码器 */
export interface FrameDecoder {
  /** 投喂一段原始文本，吐出本次投喂范围内已完整的帧 */
  push(chunk: string): SseFrame[];
  /** 流结束时调用：吐出尾部未以空行收束的残帧 */
  flush(): SseFrame[];
}

/** 从 buffer 切出一条完整行；`final=false` 时遇到尾部孤立 `\r` 会等待下一个 chunk */
function takeLine(
  buffer: string,
  final: boolean,
): { line: string; rest: string } | null {
  for (let i = 0; i < buffer.length; i++) {
    const c = buffer[i];
    if (c === '\n') return { line: buffer.slice(0, i), rest: buffer.slice(i + 1) };
    if (c === '\r') {
      // 尾部 `\r` 可能是 `\r\n` 的前半 —— 非 final 时不能判定，必须留到下一 chunk。
      // 误判会把 CRLF 边界读成一个空行，从而凭空提前结束一帧。
      if (i + 1 === buffer.length && !final) return null;
      const skip = buffer[i + 1] === '\n' ? 2 : 1;
      return { line: buffer.slice(0, i), rest: buffer.slice(i + skip) };
    }
  }
  // 无终止符的残行：final 时按一行收束（SSE 流尾常见），否则等更多数据
  return final && buffer.length > 0 ? { line: buffer, rest: '' } : null;
}

/**
 * 创建 SSE 帧解码器。
 *
 * 帧以空行（`\n\n` / `\r\n\r\n` / `\r\r`，含混合）终止；单帧可跨任意 chunk 边界。
 * `: 注释行`（后端 30s keep-alive）被忽略；无 id/event/data 的空帧不产出。
 * 纯函数语义：相同输入序列产生相同输出，无 IO、无全局可变状态。
 */
export function createFrameDecoder(): FrameDecoder {
  let buffer = '';
  let id: string | undefined;
  let event: string | undefined;
  const dataLines: string[] = [];
  let hasFields = false;

  const reset = (): void => {
    id = undefined;
    event = undefined;
    dataLines.length = 0;
    hasFields = false;
  };

  /** 空行触发收束。hasFields 与 id/event/dataLines 始终同步，故为 false 时无需 reset。 */
  const dispatch = (out: SseFrame[]): void => {
    if (!hasFields) return;
    out.push({
      ...(id === undefined ? null : { id }),
      ...(event === undefined ? null : { event }),
      data: dataLines.join('\n'),
    });
    reset();
  };

  const applyLine = (line: string, out: SseFrame[]): void => {
    if (line === '') {
      dispatch(out);
      return;
    }
    const colon = line.indexOf(':');
    // 注释行（后端 30s keep-alive）以 ':' 开头 → 字段名为空串 → 落到 default 被忽略
    const field = colon === -1 ? line : line.slice(0, colon);
    // SSE 规范：冒号后仅剥掉一个前导空格
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    switch (field) {
      case 'id':
        id = value;
        hasFields = true;
        break;
      case 'event':
        event = value;
        hasFields = true;
        break;
      case 'data':
        dataLines.push(value);
        hasFields = true;
        break;
      default:
        break; // 注释行 / retry 等未知字段
    }
  };

  const consume = (final: boolean, out: SseFrame[]): void => {
    for (;;) {
      const taken = takeLine(buffer, final);
      if (!taken) return;
      buffer = taken.rest;
      applyLine(taken.line, out);
    }
  };

  return {
    push(chunk: string): SseFrame[] {
      buffer += chunk;
      const out: SseFrame[] = [];
      consume(false, out);
      return out;
    },
    flush(): SseFrame[] {
      const out: SseFrame[] = [];
      consume(true, out);
      // 尾部无空行收束的残帧：按已收到的字段补发（不完整内容不应被静默吞掉）
      if (hasFields) dispatch(out);
      return out;
    },
  };
}

// ── 半部二：fetch reader ──────────────────────────────────────────────

/** v2 协议已知事件名集合（后端 formatSseEvent 写 `event: <type>`） */
const KNOWN_EVENT_NAMES: ReadonlySet<string> = new Set(AGENT_EVENT_TYPES_V2);

/** SSE 规范：帧内无 `event:` 字段时事件名为 'message' */
const DEFAULT_EVENT_NAME = 'message';

/**
 * streamRunEvents 交给 onEvent 的归一化记录。
 * `eventId` 是 SSE 帧 id（后端写入 `id: <seq>`，即 Last-Event-ID 续传游标）；
 * `data` 是已解析的 JSON。
 */
export type RunStreamEvent =
  /** 已知 v2 事件名 + 合法 v2 载荷 */
  | { kind: 'agent'; eventId?: string; eventName: string; data: AgentEvent }
  /** fallback：未知事件名 / 非法载荷 / 非 JSON —— 一律送达，不中断流、不 crash */
  | { kind: 'unknown'; eventId?: string; eventName: string; data: unknown };

/** 终止原因 */
export type SseCloseReason =
  /** 服务端推完终态事件后主动关闭 —— run 完成的正常信号 */
  | 'completed'
  /** 调用方通过 signal 主动取消 */
  | 'aborted'
  /** 传输层失败（非 2xx / 无 body / fetch 失败 / 流中断） */
  | 'failed';

export interface SseCloseInfo {
  reason: SseCloseReason;
  /** 最后收到的帧 id（= seq）；回传给下一次调用的 lastEventId 即可从断点续传 */
  lastEventId?: string;
}

export interface StreamRunEventsOptions {
  /** 续传游标 —— 作为 `Last-Event-ID` 头发送；通常取自上一次 onClose 的 lastEventId */
  lastEventId?: string;
  /** 主动取消通道 */
  signal: AbortSignal;
  /** 每帧一条归一化记录 */
  onEvent: (event: RunStreamEvent) => void;
  /** 传输层失败；流正常关闭不会触发 */
  onError: (error: Error) => void;
  /** 唯一终止钩子，恰好调用一次（携带续传游标） */
  onClose: (info: SseCloseInfo) => void;
}

/** 帧 → 归一化记录。非 JSON 载荷原样落到 fallback：可观测、不丢信息、不 crash。 */
function toRunEvent(frame: SseFrame): RunStreamEvent {
  const eventName = frame.event ?? DEFAULT_EVENT_NAME;
  const head = { ...(frame.id === undefined ? null : { eventId: frame.id }), eventName };
  let data: unknown;
  try {
    data = JSON.parse(frame.data);
  } catch {
    data = frame.data;
  }
  return KNOWN_EVENT_NAMES.has(eventName) && isAgentEvent(data)
    ? { kind: 'agent', ...head, data }
    : { kind: 'unknown', ...head, data };
}

function isAbort(signal: AbortSignal, cause: unknown): boolean {
  return signal.aborted || (cause instanceof Error && cause.name === 'AbortError');
}

/**
 * 订阅 `GET /api/runs/:runId/stream` 的 v2 AgentEvent 流（fetch-based，可续传）。
 *
 * 断线续传：reader 持续跟踪帧 id（= seq），无论以何种原因结束都通过 onClose 回传；
 * 调用方把它作为下一次的 `lastEventId` 传回，服务端即从 `seq > 游标` 续发，不丢不重。
 *
 * 终态：服务端在推完终态事件后主动关闭连接。本 reader **不**把关闭当错误 ——
 * onClose({ reason: 'completed' }) 就是 run 完成的信号。
 */
export async function streamRunEvents(runId: string, options: StreamRunEventsOptions): Promise<void> {
  const { lastEventId, signal, onEvent, onError, onClose } = options;
  const decoder = createFrameDecoder();
  const textDecoder = new TextDecoder();
  let cursor = lastEventId;
  let settled = false;

  /** 终止钩子恰好一次 —— 正常关闭 / 主动取消 / 失败 都只结算一次。
   *  settled 让"恰好一次"成为结构性保证，而非依赖各分支 return 写对。 */
  const close = (reason: SseCloseReason): void => {
    if (settled) return;
    settled = true;
    onClose({ reason, ...(cursor === undefined ? null : { lastEventId: cursor }) });
  };
  const fail = (message: string, cause?: unknown): void => {
    onError(new Error(message, cause === undefined ? undefined : { cause }));
  };
  const emit = (frames: readonly SseFrame[]): void => {
    for (const frame of frames) {
      if (frame.id !== undefined) cursor = frame.id;
      onEvent(toRunEvent(frame));
    }
  };

  const token = getAuthToken();
  const headers: Record<string, string> = {
    Accept: 'text/event-stream',
    'X-Requested-With': 'XMLHttpRequest',
  };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  if (lastEventId !== undefined) headers['Last-Event-ID'] = lastEventId;

  let response: Response;
  try {
    response = await fetch(`${BASE}/runs/${encodeURIComponent(runId)}/stream`, { headers, signal });
  } catch (cause: unknown) {
    if (isAbort(signal, cause)) close('aborted');
    else {
      fail('SSE 连接失败', cause);
      close('failed');
    }
    return;
  }

  if (!response.ok) {
    fail(`SSE 请求失败: ${response.status}`);
    close('failed');
    return;
  }
  if (!response.body) {
    fail('浏览器不支持流式响应');
    close('failed');
    return;
  }

  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      // stream:true —— 多字节字符跨 chunk 边界时不会产出替换字符
      emit(decoder.push(textDecoder.decode(value, { stream: true })));
    }
    // 收尾：TextDecoder 残留字节 + 无空行收束的残帧，一帧都不能漏
    emit(decoder.push(textDecoder.decode()));
    emit(decoder.flush());
  } catch (cause: unknown) {
    if (isAbort(signal, cause)) close('aborted');
    else {
      fail('SSE 流中断', cause);
      close('failed');
    }
    return;
  } finally {
    // 释放 body 的读锁：abort 路径上底层响应体仍处于活动态，不解锁连接无法被回收
    reader.releaseLock();
  }
  // 服务端推完终态事件后主动关闭连接 —— 这是 run 完成的正常信号，不是错误
  close('completed');
}
