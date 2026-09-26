import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockProvider, stopMockProvider, makeTestConfig, listenTestApp } from '../../tests/helpers/mock-provider.sse.js';
import { buildApp } from '../../app.js';
import type { FastifyInstance } from 'fastify';
import { getDb } from '../../db/client.js';
import { messages, providers } from '../../db/schema/index.js';
import { eq } from 'drizzle-orm';
import { encrypt } from '../../lib/crypto.js';
import { generateLocalAuthToken, getLocalAuthToken } from '../../lib/auth-token.js';
import { countOrphanToolMessages, rebuildProviderMessages } from '../../lib/message-history.js';

type SseEvent = {
  readonly eventName: string
  readonly data: unknown
}

let app: FastifyInstance;
let baseUrl = '';
let providerId = '';
let listenPort = 0;
let testDir = '';
/** 整改计划第 1 章（P0）：auth-guard 默认拒绝 —— 测试请求必须携带 Bearer token */
let authToken = '';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readStringField(value: unknown, field: string): string | null {
  if (!isRecord(value)) return null
  const fieldValue = value[field]
  return typeof fieldValue === 'string' ? fieldValue : null
}

function parseConversation(value: unknown): { id: string } {
  if (!isRecord(value) || typeof value.id !== 'string') {
    throw new Error('conversation response missing id')
  }
  return { id: value.id }
}

/** 附加 Authorization 的请求头 */
function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { ...extra, Authorization: `Bearer ${authToken}` };
}

/** SSE 响应收集 */
async function collectSse(url: string, init: RequestInit): Promise<SseEvent[]> {
  const res = await fetch(url, init);
  assert.ok(res.ok, `HTTP ${res.status}`);
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  if (!res.body) throw new Error('SSE response body missing');
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events: SseEvent[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      let eventName = 'message';
      let dataLine = '';
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith('event:')) eventName = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLine += line.slice(5) + '\n';
      }
      dataLine = dataLine.replace(/\n$/, '');
      if (!dataLine) continue;
      try {
        const parsed: unknown = JSON.parse(dataLine);
        events.push({ eventName, data: parsed });
      } catch {
        // 非 JSON（例如 [DONE]）不进入事件投影
      }
    }
  }
  return events;
}

before(async () => {
   const dir = mkdtempSync(join(tmpdir(), 'pacc-itest-'));
   testDir = dir;
   const cfg = makeTestConfig(dir);

  // 整改计划第 1 章：auth-guard 默认拒绝 —— 测试请求必须携带 Bearer token。
  // 注意：buildApp() 内部会调用 generateLocalAuthToken() 重新生成 token，
  // 因此必须在 buildApp 之后读取（否则拿到的是被覆盖前的旧 token，全部 401）。
  app = await buildApp(cfg);
  authToken = getLocalAuthToken() || '';
  assert.ok(authToken, 'buildApp 后应能读取本地认证 token');
   listenPort = await listenTestApp(app, cfg);

  baseUrl = await startMockProvider();
  // 注册 provider（指向 mock）
  providerId = 'mock-provider-itest';
  const now = new Date().toISOString();
  const db = getDb();
  db.insert(providers).values({
    id: providerId, name: 'mock-itest', type: 'openai',
    apiKey: encrypt('mock-key', cfg.encryptionKey), baseUrl, models: JSON.stringify(['mock-model']),
    capabilities: JSON.stringify(['text']), isDefault: false, createdAt: now, updatedAt: now,
  }).run();

});

after(async () => {
  await stopMockProvider();
  await app.close();
   if (testDir) rmSync(testDir, { recursive: true, force: true });

});

describe('conversations 端点 — translate 管线集成', () => {
  it('S5a: 普通文本流事件序列（reasoning 无 / message* / token / task.completed endReason=completed）', async () => {
    // 创建对话
    const convRes = await fetch(`http://127.0.0.1:${listenPort}/api/conversations`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }),
      body: JSON.stringify({ title: 'itest', providerId, model: 'mock-model' }),
    });
    assert.equal(convRes.status, 200);
     const conv = parseConversation(await convRes.json());


    const events = await collectSse(`http://127.0.0.1:${listenPort}/api/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }),
      body: JSON.stringify({ content: '测试一下' }),
    });

    const names = events.map((e) => e.eventName);
    // 新协议事件序列断言
    assert.ok(names.includes('task.started'), '应发射 task.started');
    assert.ok(names.includes('agent.message.delta'), '应发射 agent.message.delta');
    assert.ok(names.includes('agent.message.completed'), '应发射 agent.message.completed');
    assert.ok(names.includes('token'), '应发射 token');
    const tc = events.find((e) => e.eventName === 'task.completed');
    assert.ok(tc, '应发射 task.completed');
     assert.equal(readStringField(tc.data, 'endReason'), 'completed');

    // 旧协议 message 事件存在（兼容层）
    assert.ok(names.includes('message'), '旧协议 message 事件仍应发射');
  });

  it('S5b: reasoning 流（thinking 输入作为首条 user 消息触发 mock reasoning 场景）', async () => {
    const convRes = await fetch(`http://127.0.0.1:${listenPort}/api/conversations`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }),
      body: JSON.stringify({ title: 'itest-r', providerId, model: 'mock-model' }),
    });
     const conv = parseConversation(await convRes.json());

    const events = await collectSse(`http://127.0.0.1:${listenPort}/api/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }),
      body: JSON.stringify({ content: '带着推理 [scenario:reasoning]' }),
    });
    const names = events.map((e) => e.eventName);
    assert.ok(names.includes('agent.reasoning.delta'), '应发射 agent.reasoning.delta');
     const rd = events.filter((e) => e.eventName === 'agent.reasoning.delta')
       .map((e) => readStringField(e.data, 'content') ?? '')
       .join('');

    assert.equal(rd, '让我思考一下');
  });

  it('S5c: args-bad 场景 — 工具参数非法 JSON 降级为文本，流不炸', async () => {
    const convRes = await fetch(`http://127.0.0.1:${listenPort}/api/conversations`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }),
      body: JSON.stringify({ title: 'itest-bad', providerId, model: 'mock-model' }),
    });
     const conv = parseConversation(await convRes.json());

    const events = await collectSse(`http://127.0.0.1:${listenPort}/api/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }),
      body: JSON.stringify({ content: '执行工具 [scenario:args-bad]' }),
    });
    const names = events.map((e) => e.eventName);
    assert.ok(names.includes('tool-result'), '非法参数应发 tool-result');
    const tr = events.find((e) => e.eventName === 'tool-result');
     const toolResult = tr ? readStringField(tr.data, 'result') : null;
     assert.ok(toolResult?.includes('不是合法 JSON'), 'tool-result 内容应为降级错误文本');

    // 流正常结束（task.completed 或 task.failed 之一；因为 fc 循环 10 轮内 mock 只回 tool_calls，最终 max_turns → completed）
    assert.ok(names.includes('task.completed') || names.includes('task.failed'));
  });

  it('max-tokens 场景经过 tool-loop 和 chat-handler 后不得发 task.completed', async () => {
    // Given
    const convRes = await fetch(`http://127.0.0.1:${listenPort}/api/conversations`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }),
      body: JSON.stringify({ title: 'itest-max-tokens', providerId, model: 'mock-model' }),
    });
    assert.equal(convRes.status, 200);
    const conv = parseConversation(await convRes.json());

    // When
    const events = await collectSse(`http://127.0.0.1:${listenPort}/api/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }),
      body: JSON.stringify({ content: '请输出长回答 [scenario:max-tokens]' }),
    });

    // Then
    const names = events.map((event) => event.eventName);
    assert.ok(!names.includes('task.completed'), 'max-tokens 不得伪发 task.completed');
    const failed = events.find((event) => event.eventName === 'task.failed');
    assert.ok(failed, 'max-tokens 应发 task.failed');
    assert.equal(readStringField(failed.data, 'endReason'), 'interrupted');
    assert.equal(readStringField(failed.data, 'status'), 'interrupted');
  });

  it('content_filter 场景经过 tool-loop 和 chat-handler 后不得发 task.completed', async () => {
    // Given
    const convRes = await fetch(`http://127.0.0.1:${listenPort}/api/conversations`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }),
      body: JSON.stringify({ title: 'itest-content-filter', providerId, model: 'mock-model' }),
    });
    assert.equal(convRes.status, 200);
    const conv = parseConversation(await convRes.json());

    // When
    const events = await collectSse(`http://127.0.0.1:${listenPort}/api/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }),
      body: JSON.stringify({ content: '请输出回答 [scenario:content-filter]' }),
    });

    // Then
    const names = events.map((event) => event.eventName);
    assert.ok(!names.includes('task.completed'), 'content_filter 不得伪发 task.completed');
    const failed = events.find((event) => event.eventName === 'task.failed');
    assert.ok(failed, 'content_filter 应发 task.failed');
    assert.equal(readStringField(failed.data, 'endReason'), 'interrupted');
    assert.equal(readStringField(failed.data, 'status'), 'interrupted');
  });

  it('工具调用结果与 assistant.tool_calls 成对持久化并可重建 Provider 上下文', async () => {
    // Given
    const convRes = await fetch(`http://127.0.0.1:${listenPort}/api/conversations`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }),
      body: JSON.stringify({ title: 'itest-tool-chain', providerId, model: 'mock-model' }),
    });
    assert.equal(convRes.status, 200);
     const conv = parseConversation(await convRes.json());


    // When
    await collectSse(`http://127.0.0.1:${listenPort}/api/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }),
      body: JSON.stringify({ content: '执行工具 [scenario:tools]' }),
    });

    // Then
     const rows = getDb().select().from(messages)
       .where(eq(messages.conversationId, conv.id))
       .orderBy(messages.seq, messages.createdAt)
       .all();
     const rebuilt = rebuildProviderMessages(rows);
     assert.equal(countOrphanToolMessages(rebuilt), 0, 'Provider 上下文不得包含孤立 tool');
     const assistantToolMessages = rebuilt.filter((message) =>
       message.role === 'assistant' && Array.isArray(message.tool_calls));
     assert.ok(assistantToolMessages.length > 0, '工具轮必须持久化 assistant.tool_calls');
     const firstAssistant = assistantToolMessages[0];
     assert.ok(firstAssistant && Array.isArray(firstAssistant.tool_calls));
     const calls = firstAssistant.tool_calls;
     assert.ok(Array.isArray(calls) && calls.length >= 2, '多工具调用必须完整保留');
     const callNames = calls.flatMap((call) => {
       if (!isRecord(call) || !isRecord(call.function)) return [];
       return typeof call.function.name === 'string' ? [call.function.name] : [];
     });
     assert.ok(callNames.includes('read_file'));
     assert.ok(callNames.includes('grep'));
     const toolMessages = rebuilt.filter((message) => message.role === 'tool');
     assert.ok(toolMessages.length >= 2, '每个工具调用都必须有对应结果');
     const callIds = calls.flatMap((call) => {
       if (!isRecord(call) || typeof call.id !== 'string') return [];
       return [call.id];
     });
     for (const toolMessage of toolMessages) {
       const toolCallId = readStringField(toolMessage, 'tool_call_id');
       assert.ok(toolCallId, 'Provider tool 消息必须带 tool_call_id');
       assert.ok(callIds.includes(toolCallId), 'tool_call_id 必须匹配前置 assistant.tool_calls.id');
     }
     const serialized = JSON.stringify(rebuilt);
     assert.match(serialized, /"tool_calls"/);
     assert.match(serialized, /"tool_call_id"/);

  });
});
