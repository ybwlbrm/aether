import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  translate,
  buildChatRequestBody,
  parseToolArgsSafe,
  mapFinishReason,
  type WireChunk,
} from './stream-translate.js';
import type { StreamChunk } from '@pacc/shared';

/** 构造 OpenAI 兼容 wire chunk 的辅助 */
function wire(partial: Partial<WireChunk> & { delta?: Record<string, unknown>; usage?: Record<string, number>; finish_reason?: string | null }): string {
  const delta = partial.delta ?? {};
  return JSON.stringify({
    id: 'chatcmpl-test',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'test',
    choices: [{
      index: 0,
      delta: { role: 'assistant', ...delta },
      finish_reason: partial.finish_reason ?? null,
    }],
    ...(partial.usage ? { usage: partial.usage } : {}),
  });
}

/** 便捷：同步数组转 async iterable */
async function* fromArr(items: string[]): AsyncGenerator<string> {
  for (const it of items) yield it;
}

async function collect(chunks: AsyncIterable<string>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = [];
  for await (const c of translate(chunks)) out.push(c);
  return out;
}

/** 类型谓词辅助 */
const kinds = (cs: StreamChunk[]) => cs.map((c) => c.type);

describe('translate — 块打开与增量', () => {
  it('reasoning 先于 content 打开独立块', async () => {
    const out = await collect(fromArr([
      wire({ delta: { reasoning_content: '思考中' } }),
      wire({ delta: { content: '答复' } }),
      wire({ finish_reason: 'stop' }),
      '[DONE]',
    ]));
    const starts = out.filter((c) => c.type === 'block-start') as Extract<StreamChunk, { type: 'block-start' }>[];
    assert.equal(starts.length, 2);
    assert.equal(starts[0].blockType, 'reasoning');
    assert.equal(starts[1].blockType, 'text');
  });

  it('空字符串 delta 不创建块', async () => {
    const out = await collect(fromArr([
      wire({ delta: { reasoning_content: '' } }),
      wire({ delta: { content: '直接回答' } }),
      wire({ finish_reason: 'stop' }),
      '[DONE]',
    ]));
    const starts = out.filter((c) => c.type === 'block-start');
    assert.equal(starts.length, 1);
    assert.equal((starts[0] as { blockType: string }).blockType, 'text');
  });

  it('交错 delta 追加到最近同 kind 块', async () => {
    const out = await collect(fromArr([
      wire({ delta: { reasoning_content: 'r1' } }),
      wire({ delta: { content: 't1' } }),
      wire({ delta: { reasoning_content: 'r2' } }),
      wire({ delta: { content: 't2' } }),
      wire({ finish_reason: 'stop' }),
      '[DONE]',
    ]));
    const ends = out.filter((c) => c.type === 'block-end') as Extract<StreamChunk, { type: 'block-end' }>[];
    assert.equal(ends.length, 2);
    assert.equal(ends[0].block.kind, 'reasoning');
    assert.equal(ends[0].block.text, 'r1r2');
    assert.equal(ends[1].block.kind, 'text');
    assert.equal(ends[1].block.text, 't1t2');
  });
});

describe('translate — 工具调用组装', () => {
  it('tool_calls 按 wire index 组装 arguments', async () => {
    const out = await collect(fromArr([
      wire({ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"path":' } }] } }),
      wire({ delta: { tool_calls: [{ index: 0, function: { arguments: '"a.ts"}' } }] } }),
      wire({ finish_reason: 'tool_calls' }),
      '[DONE]',
    ]));
    const ends = out.filter((c) => c.type === 'block-end') as Extract<StreamChunk, { type: 'block-end' }>[];
    assert.equal(ends.length, 1);
    const tc = ends[0].block;
    assert.equal(tc.kind, 'tool-call');
    if (tc.kind === 'tool-call') {
      assert.equal(tc.name, 'read_file');
      assert.equal(tc.id, 'call_1');
      assert.equal(tc.arguments, '{"path":"a.ts"}');
    }
  });

  it('wire index 缺失时追加到最近 tool 块', async () => {
    const out = await collect(fromArr([
      wire({ delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'grep', arguments: '{"p":' } }] } }),
      wire({ delta: { tool_calls: [{ function: { arguments: '"x"}' } }] } }),
      wire({ finish_reason: 'tool_calls' }),
      '[DONE]',
    ]));
    const ends = out.filter((c) => c.type === 'block-end') as Extract<StreamChunk, { type: 'block-end' }>[];
    const tc = ends[0].block;
    if (tc.kind === 'tool-call') assert.equal(tc.arguments, '{"p":"x"}');
  });

  it('并行多个 tool_calls 各自独立组装', async () => {
    const out = await collect(fromArr([
      wire({ delta: { tool_calls: [
        { index: 0, id: 'c0', type: 'function', function: { name: 'a', arguments: '{"i":' } },
        { index: 1, id: 'c1', type: 'function', function: { name: 'b', arguments: '{"j":' } },
      ] } }),
      wire({ delta: { tool_calls: [
        { index: 0, function: { arguments: '0}' } },
        { index: 1, function: { arguments: '1}' } },
      ] } }),
      wire({ finish_reason: 'tool_calls' }),
      '[DONE]',
    ]));
    const ends = out.filter((c) => c.type === 'block-end') as Extract<StreamChunk, { type: 'block-end' }>[];
    assert.equal(ends.length, 2);
    const blocks = ends.map((e) => e.block);
    assert.ok(blocks.some((b) => b.kind === 'tool-call' && b.arguments === '{"i":0}'));
    assert.ok(blocks.some((b) => b.kind === 'tool-call' && b.arguments === '{"j":1}'));
  });
});

describe('translate — 延迟发射与结束', () => {
  it('block-end/usage/finish 全部延迟到 [DONE]（顺序: ends → usage → finish）', async () => {
    const out = await collect(fromArr([
      wire({ delta: { content: 'hi' } }),
      wire({ usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } }),
      wire({ finish_reason: 'stop' }),
      '[DONE]',
    ]));
    const tail = out.slice(out.length - 3);
    assert.deepEqual(kinds(tail), ['block-end', 'usage', 'finish']);
    const fin = tail[2] as Extract<StreamChunk, { type: 'finish' }>;
    assert.equal(fin.reason.kind, 'stop');
  });

  it('finish 之后再无输出', async () => {
    const out = await collect(fromArr([
      wire({ delta: { content: 'done' } }),
      wire({ finish_reason: 'stop' }),
      '[DONE]',
    ]));
    assert.equal(kinds(out).at(-1), 'finish');
  });

  it('finish_reason 映射: length → max-tokens', async () => {
    const out = await collect(fromArr([
      wire({ delta: { content: 'x' } }),
      wire({ finish_reason: 'length' }),
      '[DONE]',
    ]));
    const fin = out.at(-1) as Extract<StreamChunk, { type: 'finish' }>;
    assert.equal(fin.reason.kind, 'max-tokens');
  });

  it('finish_reason 未知 → error（code 大写）', async () => {
    const out = await collect(fromArr([
      wire({ delta: { content: 'x' } }),
      wire({ finish_reason: 'weird_thing' }),
      '[DONE]',
    ]));
    const fin = out.at(-1) as Extract<StreamChunk, { type: 'finish' }>;
    assert.equal(fin.reason.kind, 'error');
    assert.equal((fin.reason as { code?: string }).code, 'WEIRD_THING');
  });

  it('stop 且无任何块 → EMPTY_RESPONSE', async () => {
    const out = await collect(fromArr([
      wire({ finish_reason: 'stop' }),
      '[DONE]',
    ]));
    const fin = out.at(-1) as Extract<StreamChunk, { type: 'finish' }>;
    assert.equal(fin.reason.kind, 'error');
    assert.equal((fin.reason as { code?: string }).code, 'EMPTY_RESPONSE');
  });

  it('尾部 usage-only chunk 生效', async () => {
    const out = await collect(fromArr([
      wire({ usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }),
      wire({ usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 } }),
      wire({ finish_reason: 'stop' }),
      '[DONE]',
    ]));
    const u = out.find((c) => c.type === 'usage') as Extract<StreamChunk, { type: 'usage' }>;
    assert.equal(u.usage.outputTokens, 50);
  });

  it('payload 非法 JSON → MALFORMED_RESPONSE', async () => {
    await assert.rejects(
      collect(fromArr(['not-json', 'data: [DONE]'])),
      (e: unknown) => (e as { code?: string }).code === 'MALFORMED_RESPONSE',
    );
  });

  it('源无 [DONE] → STREAM_CLOSED', async () => {
    await assert.rejects(
      collect(fromArr([wire({ delta: { content: 'x' } })])),
      (e: unknown) => (e as { code?: string }).code === 'STREAM_CLOSED',
    );
  });
});

describe('mapFinishReason', () => {
  it('映射表正确', () => {
    assert.equal(mapFinishReason('stop').kind, 'stop');
    assert.equal(mapFinishReason('tool_calls').kind, 'tool_calls');
    assert.equal(mapFinishReason('length').kind, 'max-tokens');
    assert.equal(mapFinishReason('function_call').kind, 'tool_calls');
    assert.equal((mapFinishReason('content_filter') as { code?: string }).code, 'CONTENT_FILTER');
  });
});

describe('buildChatRequestBody', () => {
  it('thinking enabled + reasoning_effort 附加', () => {
    const body = buildChatRequestBody({
      model: 'deepseek-reasoner',
      messages: [{ role: 'user', content: 'hi' }],
      deepThinking: true,
      reasoningEffort: 'medium',
      supportsThinking: true,
    } as never);
    assert.deepEqual(body.thinking, { type: 'enabled' });
    assert.equal(body.reasoning_effort, 'medium');
  });

  it('thinking disabled 或不支持时不带 reasoning_effort', () => {
    const body = buildChatRequestBody({
      model: 'deepseek-chat',
      messages: [],
      deepThinking: false,
      supportsThinking: true,
    } as never);
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.equal(body.reasoning_effort, undefined);

    const body2 = buildChatRequestBody({
      model: 'gpt-4o',
      messages: [],
      deepThinking: true,
      supportsThinking: false,
    } as never);
    assert.equal(body2.thinking, undefined);
    assert.equal(body2.reasoning_effort, undefined);
  });

  it('stream 与 stream_options 恒开', () => {
    const body = buildChatRequestBody({ model: 'm', messages: [], supportsThinking: false } as never);
    assert.equal(body.stream, true);
    assert.deepEqual(body.stream_options, { include_usage: true });
  });
});

describe('parseToolArgsSafe', () => {
  it('合法 JSON → { args, ok:true }', () => {
    const r = parseToolArgsSafe('{"path":"a.ts"}');
    assert.equal(r.ok, true);
    assert.deepEqual(r.args, { path: 'a.ts' });
  });

  it('非法 JSON → { ok:false, args:{} }，不透传异常', () => {
    const r = parseToolArgsSafe('{not json');
    assert.equal(r.ok, false);
    assert.deepEqual(r.args, {});
  });

  it('空/undefined → 空对象', () => {
    assert.equal(parseToolArgsSafe('').ok, true);
    assert.equal(parseToolArgsSafe(undefined as never).ok, true);
  });
});