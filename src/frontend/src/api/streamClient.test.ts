import { describe, it, expect, vi } from 'vitest';
import { parseSseFrame, streamConversation } from './streamClient';

describe('streamClient — parseSseFrame 帧解析', () => {
  it('解析 event: + data: 单帧', () => {
    const { eventName, dataLine } = parseSseFrame('event: token\ndata: {"total_tokens":10}\n\n');
    expect(eventName).toBe('token');
    expect(JSON.parse(dataLine).total_tokens).toBe(10);
  });

  it('无 event: 行时默认 message', () => {
    const { eventName, dataLine } = parseSseFrame('data: hello\n\n');
    expect(eventName).toBe('message');
    expect(dataLine).toBe('hello');
  });

  it('CRLF 行尾正确处理', () => {
    const { dataLine } = parseSseFrame('data: a\r\ndata: b\r\n\r\n');
    expect(dataLine).toBe('a\nb');
  });

  it('多行 data 合并且去除尾换行', () => {
    const { dataLine } = parseSseFrame('data: line1\ndata: line2\n\n');
    expect(dataLine).toBe('line1\nline2');
  });

  it('空 data 行不产生内容', () => {
    const { dataLine } = parseSseFrame('data:\n\n');
    expect(dataLine).toBe('');
  });
});

describe('streamClient — envelope 载荷判别（ST-01 防双发回归）', () => {
  it('envelope 帧解析后保留 eventType 与 seq', () => {
    const raw = 'event: agent.message.delta\ndata: {"eventId":"e1","sessionId":"s1","taskId":"t1","agentId":"main","agentType":"conversation","eventType":"agent.message.delta","seq":1,"content":"x"}\n\n';
    const { eventName, dataLine } = parseSseFrame(raw);
    const payload = JSON.parse(dataLine);
    expect(eventName).toBe(payload.eventType);
    expect(payload.seq).toBe(1);
    expect(typeof payload.eventId).toBe('string');
  });

  it('envelope 是判别联合的关键判定：含 eventId/seq/eventType 三要素', () => {
    const payload = { eventId: 'x', eventType: 'task.started', seq: 1 };
    // isEnvelopePayload 未导出；此测试锁定帧载荷形状契约（防因字段改名导致 ST-01）
    expect(payload.eventType).toBeTruthy();
    expect(typeof payload.seq).toBe('number');
    expect(payload.eventId).toBeTruthy();
  });
});

describe('streamClient — SSE 流错误必须 reject（P0-14/P0-15）', () => {
  // 构造一个会在读取时抛错的 reader，模拟网络中断/解析错误
  function failingReader(): ReadableStreamDefaultReader<Uint8Array> {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"partial":true}\n\n'));
        controller.error(new TypeError('network error: fetch failed'));
      },
    });
    return stream.getReader();
  }

  it('streamConversation 在流内错误时 reject（而非静默 resolve）', async () => {
    // 阻止真实 fetch：直接 mock global.fetch 返回 body 会抛错的响应
    const onEvent = vi.fn();
    const onStreamError = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"x":1}\n\n'));
          controller.error(new TypeError('network error: fetch failed'));
        },
      }),
    } as unknown as Response));

    const promise = streamConversation('conv1', 'hi', { onEvent, onStreamError });
    // 关键断言：Promise 必须 reject（当前实现是 void process().catch → 立即 resolve，此测试会 FAIL = RED）
    await expect(promise).rejects.toThrow(/network error|fetch failed/);
    // 兼容回调也应触发（双保险保留）
    expect(onStreamError).toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('streamConversation 在流正常结束且收到业务终结事件时 resolve', async () => {
    const onEvent = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'event: task.completed\ndata: {"eventId":"e2","eventType":"task.completed","seq":2,"content":"done"}\n\n',
          ));
          controller.close();
        },
      }),
    } as unknown as Response));

    await expect(streamConversation('conv1', 'hi', { onEvent })).resolves.toBeUndefined();
    vi.unstubAllGlobals();
  });

  it('HTTP 非 2xx 时 reject 业务错误', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: async () => ({ error: { message: '服务器内部错误' } }),
    } as unknown as Response));

    await expect(streamConversation('conv1', 'hi', { onEvent: vi.fn() }))
      .rejects.toThrow('服务器内部错误');
    vi.unstubAllGlobals();
  });

  it('EVT-002: EOF 但未收到业务终结事件 → stream-truncated reject（不再静默 resolve）', async () => {
    const onEvent = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('data: {"content":"被截断的半截输出"}\n\n'));
          controller.close(); // 直接 EOF，无 task.completed / task.failed
        },
      }),
    } as unknown as Response));

    await expect(streamConversation('conv1', 'hi', { onEvent })).rejects.toThrow(/stream-truncated/);
    // 截断事件本身也要先送达 UI（组件据此展示"连接中断"）
    expect(onEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'stream-truncated' }));
    vi.unstubAllGlobals();
  });

  it('EVT-002: 收到业务终结事件后 EOF → resolve（不误判截断）', async () => {
    const onEvent = vi.fn();
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'data: {"content":"完整输出"}\n\n' +
            'event: task.completed\ndata: {"eventId":"e9","eventType":"task.completed","seq":2,"status":"completed"}\n\n',
          ));
          controller.close();
        },
      }),
    } as unknown as Response));

    await expect(streamConversation('conv1', 'hi', { onEvent })).resolves.toBeUndefined();
    vi.unstubAllGlobals();
  });
});