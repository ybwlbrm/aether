/**
 * SSE 帧解析器 — 对齐 DeepSeek Harness `packages/llm/llm-deepseek/src/sse.ts` 的语义。
 *
 * 契约（与 eventsource-parser 行为一致，自主实现以支持 onComment 与精确错误码）：
 * - 只在空行（\n\n 或 \r\n\r\n）处分发一个完整事件帧；
 * - 多行 `data:` 以换行符拼接；注释行（`:` 开头）跳过并回调 onComment；
 * - UTF-8 BOM 剥离；CRLF / LF 均支持；跨 chunk 的帧正确重组；
 * - `[DONE]` 作为普通 data 载荷产出，之后正常结束；
 * - EOF 时未用空行终止的尾部丢弃（不触发、不报错）；
 * - EOF 时若从未产出 `[DONE]` → 抛 SseStreamError('STREAM_CLOSED')（断流检测）。
 */
import { StreamError, type StreamErrorCode } from '@pacc/shared';

export class SseStreamError extends StreamError {
  constructor(code: StreamErrorCode, message: string) {
    super(code, message);
    this.name = 'SseStreamError';
  }
}

/** 帧边界：连续空行（\n\n 或 \r\n\r\n，含混合） */
const FRAME_BOUNDARY = /\r\n\r\n|\n\n/;

/** 单帧解析结果 */
interface SseFrame {
  eventName: string;
  comments: string[];
  dataLines: string[];
}

/**
 * 一帧内 yield 出 payload（不含 [DONE]）；注释回调 onComment。
 * 返回是否遇到 [DONE]。
 */
function dispatchFrame(frame: SseFrame, onComment: ((comment: string) => void) | undefined, sink: (payload: string) => void): boolean {
  for (const c of frame.comments) {
    onComment?.(c);
  }
  const joined = frame.dataLines.join('\n');
  if (joined === '[DONE]') {
    sink('[DONE]');
    return true;
  }
  if (joined.length > 0) sink(joined);
  return false;
}

/**
 * 生成器式 SSE 解析：把二进制 chunk 流 → data payload 字符串流。
 * 产出 `[DONE]` 后继续读到 EOF（宽容尾帧）；EOF 无 [DONE] 抛 STREAM_CLOSED。
 */
export async function* parseSse(
  chunks: AsyncIterable<Uint8Array>,
  onComment?: (comment: string) => void,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let buffer = '';
  let sawDone = false;

  // 逐行解析当前帧文本，返回该帧是否命中 [DONE]
  const parseFrameLines = (raw: string): boolean => {
    const frame: SseFrame = { eventName: 'message', comments: [], dataLines: [] };
    for (const line0 of raw.split(/\r?\n/)) {
      // 去除 data: 后单前导空格；其余行保留原样
      const line = line0.replace(/\r$/, '');
      if (line.startsWith(':')) {
        frame.comments.push(line.slice(1).replace(/^ /, ''));
      } else if (line.startsWith('data:')) {
        frame.dataLines.push(line.slice(5).replace(/^ /, ''));
      } else if (line.startsWith('event:')) {
        frame.eventName = line.slice(6).trim();
      }
      // id: / retry: 行忽略（本协议不需要）
    }
    return dispatchFrame(frame, onComment, (p) => {
      // 延后 [DONE] 产出：用 sentinel 数组标记，由外层 yield
      pendingPayloads.push(p);
    });
  };

  const pendingPayloads: string[] = [];

  for await (const chunk of chunks) {
    buffer += decoder.decode(chunk, { stream: true });
    // 按帧边界切分
    let m: RegExpExecArray | null;
    while ((m = FRAME_BOUNDARY.exec(buffer)) !== null) {
      const end = m.index + m[0].length;
      const head = buffer.slice(0, m.index);
      buffer = buffer.slice(end);
      if (head.length > 0) {
        const hasDone = parseFrameLines(head);
        if (sawDone) continue; // [DONE] 之后再产出的帧：宽容丢弃
        sawDone = hasDone;
      }
      // 产出本帧 payload
      while (pendingPayloads.length > 0) {
        yield pendingPayloads.shift()!;
      }
    }
  }

  // EOF：flush 解码器残余
  buffer += decoder.decode();
  // 未用空行终止的尾部：丢弃（不触发、不报错）——符合契约
  if (!sawDone) {
    throw new SseStreamError('STREAM_CLOSED', 'SSE stream closed before [DONE] sentinel');
  }
}

/**
 * 单块读取超时包装 — 保持现有 readChunkWithTimeout 语义（60s），
 * 同时尊重外部 AbortSignal：abort 时取消底层流。
 */
export async function* withChunkTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  signal?: AbortSignal,
): AsyncGenerator<Uint8Array> {
  while (true) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let aborted = false;
    const onAbort = () => {
      aborted = true;
      const a = signal!.reason;
      void reader.cancel(a).catch(() => {});
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      const readPromise = reader.read().finally(() => {
        if (timer !== undefined) clearTimeout(timer);
      });
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          void reader.cancel().catch(() => {});
          reject(new Error(`AI 响应流读取超时：${timeoutMs / 1000} 秒内未收到新数据`));
        }, timeoutMs);
      });
      const { done, value } = await Promise.race([readPromise, timeoutPromise]);
      if (done) return;
      yield value;
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
    if (aborted) {
      throw (signal!.reason instanceof Error ? signal!.reason : new Error(String(signal!.reason ?? 'aborted')));
    }
  }
}