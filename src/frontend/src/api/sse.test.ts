import { describe, it, expect, vi, afterEach, type Mock } from 'vitest';
import type { AgentEvent } from '@pacc/shared';
import { createFrameDecoder, streamRunEvents, type RunStreamEvent, type SseCloseInfo } from './sse';

// client.ts 的 getAuthToken 由模块级内存状态提供；这里替换为可控值，
// 避免测试依赖 /api/auth/token 网络调用。
const authState = vi.hoisted(() => ({ token: 'test-token' as string | null }));
vi.mock('./client', () => ({ getAuthToken: () => authState.token }));

// ── fixtures ──────────────────────────────────────────────────────────

/** v2 BaseEvent 公共字段（每个具体事件类型各自补 type + 专属 payload —— 判别联合不允许把 type 参数化） */
function v2Base(seq: number) {
  return {
    eventId: `evt-${seq}`,
    sessionId: 'sess-1',
    runId: 'run-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    seq,
    version: 2,
  };
}

/** AgentOutputDeltaEvent —— 普通增量帧 */
function outputDelta(seq: number): AgentEvent {
  return { ...v2Base(seq), type: 'agent.output.delta', payload: { content: `片段-${seq}` } };
}

/** RunCompletedEvent —— run 终态帧 */
function runCompleted(seq: number): AgentEvent {
  return {
    ...v2Base(seq),
    type: 'run.completed',
    payload: { endReason: 'completed', tokenUsage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 } },
  };
}

/** 与后端 formatSseEvent 完全一致的三行帧格式 */
function wireFrame(event: AgentEvent): string {
  return `event: ${event.type}\ndata: ${JSON.stringify(event)}\nid: ${event.seq}\n\n`;
}

function abortError(): Error {
  return Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
}

interface StreamOpts {
  signal?: AbortSignal;
  /** 不 close —— 模拟仍在进行的流（abort 测试用） */
  holdOpen?: boolean;
  /** 推完 chunks 后以该错误中断 —— 模拟网络掉线 */
  failWith?: Error;
}

function sseStream(
  chunks: ReadonlyArray<string | Uint8Array>,
  opts: StreamOpts = {},
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let cursor = 0;
  return new ReadableStream<Uint8Array>(
    {
      // 必须用 pull 而非 start 一次性 enqueue：stream 一旦 error，队列里的 chunk 会被
      // 丢弃，reader 一个都读不到 —— 那样就测不到"读到一半掉线"了。
      pull(controller) {
        if (cursor < chunks.length) {
          const chunk = chunks[cursor++];
          controller.enqueue(typeof chunk === 'string' ? encoder.encode(chunk) : chunk);
          return;
        }
        if (opts.failWith) controller.error(opts.failWith);
        else if (!opts.holdOpen) controller.close();
      },
      start(controller) {
        // 模拟浏览器行为：signal abort 时底层 body stream 立即 error
        opts.signal?.addEventListener('abort', () => controller.error(abortError()), { once: true });
      },
    },
    { highWaterMark: 1 }, // 每次 read 恰好触发一次 pull —— 保证"消费完才断流"
  );
}

function sseResponse(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
}

/** stub fetch 并记录调用；factory 让每个测试自选响应 */
function mockFetch(factory: (call: { url: string; init: RequestInit }) => Response): Array<{ url: string; init: RequestInit }> {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchMock = vi.fn<typeof fetch>((input, init) => {
    const call = { url: String(input), init: init ?? {} };
    calls.push(call);
    return Promise.resolve(factory(call));
  });
  vi.stubGlobal('fetch', fetchMock);
  return calls;
}

function headerOf(call: { init: RequestInit }, name: string): string | null {
  return new Headers(call.init.headers).get(name);
}

afterEach(() => {
  vi.unstubAllGlobals();
  authState.token = 'test-token';
});

/** 类型化的回调 mock —— 避免 vi.fn() 默认的 any 签名掩盖调用点类型错误 */
const eventSpy = (): Mock<(e: RunStreamEvent) => void> => vi.fn<(e: RunStreamEvent) => void>();
const closeSpy = (): Mock<(i: SseCloseInfo) => void> => vi.fn<(i: SseCloseInfo) => void>();
const errorSpy = (): Mock<(e: Error) => void> => vi.fn<(e: Error) => void>();

// ── createFrameDecoder：帧终止符 ────────────────────────────────────────

describe('createFrameDecoder — 帧终止符', () => {
  it('\\n\\n 终止单帧', () => {
    const d = createFrameDecoder();
    expect(d.push('event: token\ndata: {"a":1}\nid: 7\n\n')).toEqual([
      { event: 'token', data: '{"a":1}', id: '7' },
    ]);
  });

  it('\\r\\n\\r\\n 终止单帧', () => {
    const d = createFrameDecoder();
    expect(d.push('event: token\r\ndata: {"a":1}\r\nid: 7\r\n\r\n')).toEqual([
      { event: 'token', data: '{"a":1}', id: '7' },
    ]);
  });

  it('\\r\\r 终止单帧：尾部孤立 \\r 推迟到下一 chunk / flush 判定', () => {
    // 尾部单个 \r 可能是 \r\n 的前半，无法判定 —— 若在此凭空当作行终止符，
    // 下一个 chunk 的 \n 会被读成一个空行，导致一帧被提前截断。
    const d = createFrameDecoder();
    expect(d.push('event: a\rdata: 1\rid: 1\r\revent: b\rdata: 2\rid: 2\r')).toEqual([
      { event: 'a', data: '1', id: '1' },
    ]);
    expect(d.flush()).toEqual([{ event: 'b', data: '2', id: '2' }]);
  });

  it('CRLF 跨 chunk 边界不产生假空行（\\r 结尾 + \\n 开头）', () => {
    const d = createFrameDecoder();
    expect(d.push('event: token\r')).toEqual([]);
    expect(d.push('\ndata: {"a":1}\r')).toEqual([]);
    expect(d.push('\n\r\n')).toEqual([{ event: 'token', data: '{"a":1}' }]);
  });

  it('一 chunk 内两帧一次性产出', () => {
    const d = createFrameDecoder();
    expect(d.push('id: 1\ndata: one\n\nevent: e2\ndata: two\nid: 2\n\n')).toEqual([
      { id: '1', data: 'one' },
      { event: 'e2', data: 'two', id: '2' },
    ]);
  });
});

// ── createFrameDecoder：字段语义 ───────────────────────────────────────

describe('createFrameDecoder — 字段语义', () => {
  it('id:/event:/data: 顺序任意，结果一致', () => {
    const d = createFrameDecoder();
    expect(d.push('data: payload\nid: 42\nevent: run.completed\n\n')).toEqual([
      { id: '42', event: 'run.completed', data: 'payload' },
    ]);
  });

  it('多行 data 用 \\n 拼接', () => {
    const d = createFrameDecoder();
    expect(d.push('data: line1\ndata: line2\ndata: line3\n\n')).toEqual([
      { data: 'line1\nline2\nline3' },
    ]);
  });

  it('data: 后仅剥一个前导空格（data:hello 与 data: hello 等价，双空格保留一个）', () => {
    const d = createFrameDecoder();
    expect(d.push('data:hello\ndata:  x\n\n')).toEqual([{ data: 'hello\n x' }]);
  });

  it('注释行（keep-alive）被忽略且不产出帧', () => {
    const d = createFrameDecoder();
    expect(d.push(': keep-alive\n\n')).toEqual([]);
  });

  it('帧内注释行不影响同帧其他字段', () => {
    const d = createFrameDecoder();
    expect(d.push('event: token\n: 心跳\ndata: {"a":1}\n\n')).toEqual([
      { event: 'token', data: '{"a":1}' },
    ]);
  });

  it('无冒号行与未知字段被忽略', () => {
    const d = createFrameDecoder();
    expect(d.push('retry\nfoo: bar\ndata: {"a":1}\n\n')).toEqual([{ data: '{"a":1}' }]);
  });

  it('缺少 id:/event: 时对应键不出现在帧上', () => {
    const d = createFrameDecoder();
    const [frame] = d.push('data: {"a":1}\n\n');
    expect(frame).toBeDefined();
    expect(frame).not.toHaveProperty('id');
    expect(frame).not.toHaveProperty('event');
  });
});

// ── createFrameDecoder：跨 chunk 边界与 flush ──────────────────────────

describe('createFrameDecoder — 跨 chunk 边界与 flush', () => {
  it('单帧跨任意 chunk 边界（逐字符喂入）只在完整时产出一次', () => {
    const d = createFrameDecoder();
    const wire = 'event: agent.output.delta\ndata: {"content":"你好世界"}\nid: 3\n\n';
    const collected = [];
    for (const ch of wire) collected.push(...d.push(ch));
    expect(collected).toEqual([{ event: 'agent.output.delta', data: '{"content":"你好世界"}', id: '3' }]);
  });

  it('flush() 恢复尾部未以空行结束的不完整帧', () => {
    const d = createFrameDecoder();
    expect(d.push('event: token\ndata: {"a":1}\nid: 9\n')).toEqual([]);
    expect(d.flush()).toEqual([{ event: 'token', data: '{"a":1}', id: '9' }]);
  });

  it('flush() 恢复尾部孤立 \\r 后的内容', () => {
    const d = createFrameDecoder();
    expect(d.push('data: tail\r')).toEqual([]);
    expect(d.flush()).toEqual([{ data: 'tail' }]);
  });

  it('flush() 后状态清空：同一帧不重复产出', () => {
    const d = createFrameDecoder();
    d.push('data: x\n\n');
    expect(d.flush()).toEqual([]);
    expect(d.push('data: y\n\n')).toEqual([{ data: 'y' }]);
  });

  it('连续空行不产出空帧', () => {
    const d = createFrameDecoder();
    expect(d.push('\n\n\n\n')).toEqual([]);
  });
});

// ── streamRunEvents：请求构造 ──────────────────────────────────────────

describe('streamRunEvents — 请求构造', () => {
  it('happy path：多帧按序送达，服务端关闭即完成（onClose 一次，reason=completed）', async () => {
    const events = [outputDelta(1), outputDelta(2), runCompleted(3)];
    const calls = mockFetch(() => sseResponse(sseStream(events.map(wireFrame))));
    const onEvent = eventSpy();
    const onError = errorSpy();
    const onClose = closeSpy();

    await streamRunEvents('run-1', { signal: new AbortController().signal, onEvent, onError, onClose });

    expect(calls[0]?.url).toBe('/api/runs/run-1/stream');
    expect(headerOf(calls[0]!, 'Accept')).toBe('text/event-stream');
    expect(headerOf(calls[0]!, 'X-Requested-With')).toBe('XMLHttpRequest');
    expect(headerOf(calls[0]!, 'Authorization')).toBe('Bearer test-token');
    // 未指定 lastEventId 时不得发送续传头
    expect(headerOf(calls[0]!, 'Last-Event-ID')).toBeNull();

    const received = onEvent.mock.calls.map((c) => c[0]);
    expect(received).toHaveLength(3);
    expect(received.map((r) => (r.kind === 'agent' ? r.data.type : r.kind))).toEqual([
      'agent.output.delta',
      'agent.output.delta',
      'run.completed',
    ]);
    // 每帧产出 { eventId(SSE id=seq), eventName, data }
    expect(received[0]).toEqual({
      kind: 'agent',
      eventId: '1',
      eventName: 'agent.output.delta',
      data: outputDelta(1),
    });
    expect(onError).not.toHaveBeenCalled();
    // 流关闭是正常完成信号，不是 error
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith({ reason: 'completed', lastEventId: '3' });
  });

  it('runId 特殊字符被 URL 编码', async () => {
    const calls = mockFetch(() => sseResponse(sseStream([])));
    await streamRunEvents('run/../x', {
      signal: new AbortController().signal,
      onEvent: eventSpy(),
      onError: errorSpy(),
      onClose: closeSpy(),
    });
    expect(calls[0]?.url).toBe('/api/runs/run%2F..%2Fx/stream');
  });

  it('无 token 时不带 Authorization 头', async () => {
    authState.token = null;
    const calls = mockFetch(() => sseResponse(sseStream([])));
    await streamRunEvents('run-1', {
      signal: new AbortController().signal,
      onEvent: eventSpy(),
      onError: errorSpy(),
      onClose: closeSpy(),
    });
    expect(headerOf(calls[0]!, 'Authorization')).toBeNull();
  });

  it('指定 lastEventId 时携带 Last-Event-ID 头', async () => {
    const calls = mockFetch(() => sseResponse(sseStream([])));
    await streamRunEvents('run-1', {
      lastEventId: '5',
      signal: new AbortController().signal,
      onEvent: eventSpy(),
      onError: errorSpy(),
      onClose: closeSpy(),
    });
    expect(headerOf(calls[0]!, 'Last-Event-ID')).toBe('5');
  });
});

// ── streamRunEvents：掉线续传 ──────────────────────────────────────────

describe('streamRunEvents — 掉线续传（Last-Event-ID）', () => {
  it('掉线后 onClose 暴露游标，第二次调用带 Last-Event-ID 从断点续传', async () => {
    // 第一次连接：收到 seq 1、2 后网络中断（body stream error）
    const firstCalls = mockFetch(() =>
      sseResponse(sseStream([wireFrame(outputDelta(1)), wireFrame(outputDelta(2))], { failWith: new TypeError('network error') })),
    );
    const firstEvents = eventSpy();
    const firstClose = closeSpy();

    await streamRunEvents('run-1', {
      signal: new AbortController().signal,
      onEvent: firstEvents,
      onError: errorSpy(),
      onClose: firstClose,
    });

    expect(firstEvents).toHaveBeenCalledTimes(2);
    expect(firstClose).toHaveBeenCalledTimes(1);
    expect(firstClose).toHaveBeenCalledWith({ reason: 'failed', lastEventId: '2' });
    expect(headerOf(firstCalls[0]!, 'Last-Event-ID')).toBeNull();

    // 第二次连接：调用方把游标传回，服务端只补发 seq > 2 的事件
    const resumeFrom = firstClose.mock.calls[0]?.[0];
    expect(resumeFrom).toBeDefined();
    const secondCalls = mockFetch(() => sseResponse(sseStream([wireFrame(outputDelta(3))])));
    const secondEvents = eventSpy();

    await streamRunEvents('run-1', {
      lastEventId: resumeFrom?.lastEventId,
      signal: new AbortController().signal,
      onEvent: secondEvents,
      onError: errorSpy(),
      onClose: closeSpy(),
    });

    expect(headerOf(secondCalls[0]!, 'Last-Event-ID')).toBe('2');
    expect(secondEvents).toHaveBeenCalledTimes(1);
    expect(secondEvents.mock.calls[0]?.[0]).toMatchObject({ eventId: '3', eventName: 'agent.output.delta' });
  });
});

// ── streamRunEvents：终止路径 ──────────────────────────────────────────

describe('streamRunEvents — 终止路径', () => {
  it('abort 中途：onClose 恰好一次且 reason=aborted，不触发 onError', async () => {
    const controller = new AbortController();
    mockFetch(() => sseResponse(sseStream([wireFrame(outputDelta(1))], { signal: controller.signal, holdOpen: true })));
    const onEvent = eventSpy();
    const onError = errorSpy();
    const onClose = closeSpy();

    const run = streamRunEvents('run-1', { signal: controller.signal, onEvent, onError, onClose });
    await vi.waitFor(() => expect(onEvent).toHaveBeenCalledTimes(1));
    controller.abort();
    await run;

    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith({ reason: 'aborted', lastEventId: '1' });
    // 主动取消不是失败
    expect(onError).not.toHaveBeenCalled();
  });

  it('非 2xx 响应：onError 恰好一次，onClose 恰好一次', async () => {
    mockFetch(() => new Response(JSON.stringify({ error: { message: 'run 未找到' } }), { status: 404 }));
    const onEvent = eventSpy();
    const onError = errorSpy();
    const onClose = closeSpy();

    await streamRunEvents('run-1', { signal: new AbortController().signal, onEvent, onError, onClose });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[0]).toBeInstanceOf(Error);
    expect(onError.mock.calls[0]?.[0].message).toContain('404');
    expect(onEvent).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith({ reason: 'failed' });
  });

  it('响应无 body：onError 一次', async () => {
    mockFetch(() => new Response(null, { status: 200 }));
    const onError = errorSpy();
    const onClose = closeSpy();
    await streamRunEvents('run-1', {
      signal: new AbortController().signal,
      onEvent: eventSpy(),
      onError,
      onClose,
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('fetch 本身失败（非 abort）：onError 一次 + onClose(failed) 一次', async () => {
    const fetchMock = vi.fn<typeof fetch>(() => Promise.reject(new TypeError('fetch failed')));
    vi.stubGlobal('fetch', fetchMock);
    const onError = errorSpy();
    const onClose = closeSpy();

    await streamRunEvents('run-1', { signal: new AbortController().signal, onEvent: eventSpy(), onError, onClose });

    expect(onError).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledWith({ reason: 'failed' });
  });
});

// ── streamRunEvents：路由与边界 ────────────────────────────────────────

describe('streamRunEvents — 路由与边界', () => {
  it('未知 eventName 路由到 fallback，不 crash', async () => {
    const wire = 'event: totally.unknown\ndata: {"whatever":true}\nid: 1\n\n';
    mockFetch(() => sseResponse(sseStream([wire])));
    const onEvent = eventSpy();
    const onError = errorSpy();

    await streamRunEvents('run-1', {
      signal: new AbortController().signal,
      onEvent,
      onError,
      onClose: closeSpy(),
    });

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0]?.[0]).toEqual({
      kind: 'unknown',
      eventId: '1',
      eventName: 'totally.unknown',
      data: { whatever: true },
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it('以线上事件名为路由依据：eventName 未知时即使载荷是合法 v2 事件也走 fallback', async () => {
    // 路由看的是 wire 上的 `event:` 标签，而非载荷里的 type —— 标签与 type 不一致属于
    // 协议违例，必须暴露给调用方，不能被"载荷看起来对"掩盖。
    const event = outputDelta(1);
    const wire = `event: not.a.real.type\ndata: ${JSON.stringify(event)}\nid: 1\n\n`;
    mockFetch(() => sseResponse(sseStream([wire])));
    const onEvent = eventSpy();

    await streamRunEvents('run-1', {
      signal: new AbortController().signal,
      onEvent,
      onError: errorSpy(),
      onClose: closeSpy(),
    });

    expect(onEvent.mock.calls[0]?.[0]).toEqual({
      kind: 'unknown',
      eventId: '1',
      eventName: 'not.a.real.type',
      data: event,
    });
  });

  it('已知 eventName 但载荷非法时同样走 fallback', async () => {
    mockFetch(() => sseResponse(sseStream(['event: agent.output.delta\ndata: {"seq":1}\nid: 1\n\n'])));
    const onEvent = eventSpy();
    await streamRunEvents('run-1', {
      signal: new AbortController().signal,
      onEvent,
      onError: errorSpy(),
      onClose: closeSpy(),
    });
    expect(onEvent.mock.calls[0]?.[0]).toEqual({
      kind: 'unknown',
      eventId: '1',
      eventName: 'agent.output.delta',
      data: { seq: 1 },
    });
  });

  it('data 非 JSON 时落到 fallback，原始文本保留', async () => {
    mockFetch(() => sseResponse(sseStream(['event: agent.output.delta\ndata: not-json\nid: 1\n\n'])));
    const onEvent = eventSpy();
    await streamRunEvents('run-1', {
      signal: new AbortController().signal,
      onEvent,
      onError: errorSpy(),
      onClose: closeSpy(),
    });
    expect(onEvent.mock.calls[0]?.[0]).toEqual({
      kind: 'unknown',
      eventId: '1',
      eventName: 'agent.output.delta',
      data: 'not-json',
    });
  });

  it('无 event: 字段时 eventName 缺省为 message', async () => {
    mockFetch(() => sseResponse(sseStream(['data: {"x":1}\n\n'])));
    const onEvent = eventSpy();
    await streamRunEvents('run-1', {
      signal: new AbortController().signal,
      onEvent,
      onError: errorSpy(),
      onClose: closeSpy(),
    });
    expect(onEvent.mock.calls[0]?.[0]).toMatchObject({ kind: 'unknown', eventName: 'message' });
  });

  it('keep-alive 注释行不产生事件，只推进连接存活', async () => {
    mockFetch(() =>
      sseResponse(
        sseStream([wireFrame(outputDelta(1)), ': keep-alive\n\n', wireFrame(runCompleted(2))]),
      ),
    );
    const onEvent = eventSpy();
    const onClose = closeSpy();

    await streamRunEvents('run-1', {
      signal: new AbortController().signal,
      onEvent,
      onError: errorSpy(),
      onClose,
    });

    expect(onEvent).toHaveBeenCalledTimes(2);
    expect(onClose).toHaveBeenCalledWith({ reason: 'completed', lastEventId: '2' });
  });

  it('UTF-8 多字节字符跨 chunk 边界不被截断', async () => {
    const bytes = new TextEncoder().encode(wireFrame(outputDelta(1)));
    // 在第一个多字节序列（UTF-8 lead byte >= 0xC0）内部切开：
    // 若 TextDecoder 不用 stream 模式，首段会产出 U+FFFD 替换字符，载荷被污染。
    const lead = bytes.findIndex((b) => b >= 0xc0);
    expect(lead).toBeGreaterThan(0);
    mockFetch(() => sseResponse(sseStream([bytes.slice(0, lead + 1), bytes.slice(lead + 1)])));
    const onEvent = eventSpy();

    await streamRunEvents('run-1', {
      signal: new AbortController().signal,
      onEvent,
      onError: errorSpy(),
      onClose: closeSpy(),
    });

    expect(onEvent).toHaveBeenCalledTimes(1);
    const received = onEvent.mock.calls[0]?.[0];
    expect(received?.kind).toBe('agent');
    expect(received?.kind === 'agent' ? received.data : null).toEqual(outputDelta(1));
  });

  it('最后一帧缺少空行收束时由 flush 恢复（连接在写入中途结束）', async () => {
    const event = runCompleted(7);
    // 帧已完整到达，但尾部的空行（帧终止符）在连接结束时丢失
    const truncated = `event: run.completed\ndata: ${JSON.stringify(event)}\nid: 7\n`;
    mockFetch(() => sseResponse(sseStream([truncated])));
    const onEvent = eventSpy();
    const onClose = closeSpy();

    await streamRunEvents('run-1', {
      signal: new AbortController().signal,
      onEvent,
      onError: errorSpy(),
      onClose,
    });

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0]?.[0]).toEqual({
      kind: 'agent',
      eventId: '7',
      eventName: 'run.completed',
      data: event,
    });
    expect(onClose).toHaveBeenCalledWith({ reason: 'completed', lastEventId: '7' });
  });

  it('单帧字节级切碎后仍能正确重组（流读取侧边界安全）', async () => {
    const wire = wireFrame(runCompleted(1));
    const chunks = Array.from(wire).map((ch) => ch);
    mockFetch(() => sseResponse(sseStream(chunks)));
    const onEvent = eventSpy();
    const onClose = closeSpy();

    await streamRunEvents('run-1', {
      signal: new AbortController().signal,
      onEvent,
      onError: errorSpy(),
      onClose,
    });

    expect(onEvent).toHaveBeenCalledTimes(1);
    expect(onEvent.mock.calls[0]?.[0]).toMatchObject({ eventId: '1', eventName: 'run.completed' });
    expect(onClose).toHaveBeenCalledWith({ reason: 'completed', lastEventId: '1' });
  });
});
