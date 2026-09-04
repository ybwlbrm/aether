import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { parseSse, withChunkTimeout, SseStreamError } from './sse-parser.js';

/** 把 string 切成任意大小 chunk 的辅助（模拟网络分片） */
async function* chunks(text: string, size: number): AsyncGenerator<Uint8Array> {
  const bytes = new TextEncoder().encode(text);
  for (let i = 0; i < bytes.length; i += size) {
    yield bytes.slice(i, i + size);
  }
}

/** 收集解析器输出 */
async function collect(gen: AsyncGenerator<string>): Promise<string[]> {
  const out: string[] = [];
  for await (const p of gen) out.push(p);
  return out;
}

describe('parseSse — 帧解析', () => {
  it('解析 LF 分隔的多事件帧', async () => {
    const text = 'data: {"a":1}\n\ndata: {"b":2}\n\ndata: [DONE]\n\n';
    const out = await collect(parseSse(chunks(text, 64)));
    assert.deepEqual(out, ['{"a":1}', '{"b":2}', '[DONE]']);
  });

  it('解析 CRLF 分隔帧', async () => {
    const text = 'data: {"a":1}\r\n\r\ndata: [DONE]\r\n\r\n';
    const out = await collect(parseSse(chunks(text, 32)));
    assert.deepEqual(out, ['{"a":1}', '[DONE]']);
  });

  it('多行 data 以换行拼接', async () => {
    const text = 'data: {"line1"\ndata: "line2"}\n\ndata: [DONE]\n\n';
    const out = await collect(parseSse(chunks(text, 16)));
    assert.deepEqual(out, ['{"line1"\n"line2"}', '[DONE]']);
  });

  it('跨 chunk 边界的帧正确重组', async () => {
    const text = 'data: {"chunked":1}\n\ndata: [DONE]\n\n';
    const out = await collect(parseSse(chunks(text, 7)));
    assert.deepEqual(out, ['{"chunked":1}', '[DONE]']);
  });

  it('交错拆分（2 字节包裹）仍稳定', async () => {
    const text = 'data: abc\n\ndata: def\n\ndata: [DONE]\n\n';
    const out = await collect(parseSse(chunks(text, 2)));
    assert.deepEqual(out, ['abc', 'def', '[DONE]']);
  });

  it('注释行被跳过并回调 onComment', async () => {
    const comments: string[] = [];
    const text = ': keep-alive\n\ndata: {"x":1}\n\n: ping\ndata: [DONE]\n\n';
    const out = await collect(parseSse(chunks(text, 64), (c: string) => comments.push(c)));
    assert.deepEqual(out, ['{"x":1}', '[DONE]']);
    assert.ok(comments.some((c) => c.includes('keep-alive')));
  });

  it('UTF-8 BOM 被剥离', async () => {
    const text = '\uFEFFdata: {"bom":1}\n\ndata: [DONE]\n\n';
    const out = await collect(parseSse(chunks(text, 64)));
    assert.deepEqual(out, ['{"bom":1}', '[DONE]']);
  });

  it('未用空行终止的 EOF 尾部丢弃（不触发，整体仍报 STREAM_CLOSED）', async () => {
    const text = 'data: {"complete":1}\n\ndata: {"truncated-tail"';
    const produced: string[] = [];
    await assert.rejects(
      (async () => {
        for await (const p of parseSse(chunks(text, 32))) produced.push(p);
      })(),
      (e: unknown) => (e as SseStreamError).code === 'STREAM_CLOSED',
    );
    // 已产出的完整帧保留，未终止尾部不产出
    assert.deepEqual(produced, ['{"complete":1}']);
  });
});

describe('parseSse — [DONE] 哨兵与断流检测', () => {
  it('EOF 无 [DONE] → STREAM_CLOSED', async () => {
    const text = 'data: {"a":1}\n\n';
    await assert.rejects(
      collect(parseSse(chunks(text, 32))),
      (e: unknown) => (e as SseStreamError).code === 'STREAM_CLOSED',
    );
  });

  it('最后一条为 [DONE] 正常结束', async () => {
    const text = 'data: {"a":1}\n\ndata: [DONE]\n\n';
    const out = await collect(parseSse(chunks(text, 32)));
    assert.deepEqual(out, ['{"a":1}', '[DONE]']);
  });
});

describe('withChunkTimeout — 单块超时保护', () => {
  function readerFrom(text: string, delays: number[]): ReadableStreamDefaultReader<Uint8Array> {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const lines = new TextEncoder().encode(text);
        controller.enqueue(lines);
        controller.close();
      },
    });
    return stream.getReader();
  }

  it('正常读完全部块', async () => {
    const chunksReceived: string[] = [];
    const reader = readerFrom('data: hi\n\n', []);
    for await (const c of withChunkTimeout(reader, 1000)) {
      chunksReceived.push(new TextDecoder().decode(c));
    }
    assert.deepEqual(chunksReceived, ['data: hi\n\n']);
  });

  it('超时会取消底层流并抛错', async () => {
    // 永不 resolve 的 stream（一个 pending 的 read）
    const stream = new ReadableStream<Uint8Array>({
      start() { /* never enqueue/close */ },
    });
    const reader = stream.getReader();
    await assert.rejects(
      async () => {
        for await (const _c of withChunkTimeout(reader, 50)) { /* noop */ }
      },
      /超时|timeout/i,
    );
  });
});