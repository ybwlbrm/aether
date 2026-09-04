import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockProvider, stopMockProvider, makeTestConfig, listenTestApp } from '../../tests/helpers/mock-provider.sse.js';
import { buildApp } from '../../app.js';
import type { FastifyInstance } from 'fastify';
import { getDb } from '../../db/client.js';
import { providers } from '../../db/schema/index.js';
import { encrypt } from '../../lib/crypto.js';

let app: FastifyInstance;
let baseUrl = '';
let providerId = '';
let listenPort = 0;

/** SSE 响应收集 */
async function collectSse(url: string, init: RequestInit): Promise<{ eventName: string; data: any }[]> {
  const res = await fetch(url, init);
  assert.ok(res.ok, `HTTP ${res.status}`);
  assert.equal(res.headers.get('content-type'), 'text/event-stream');
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const events: { eventName: string; data: any }[] = [];
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
      try { events.push({ eventName, data: JSON.parse(dataLine) }); } catch { /* 非 JSON（如 [DONE]）忽略 */ }
    }
  }
  return events;
}

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pacc-itest-'));
  const cfg = makeTestConfig(dir);
  app = await buildApp(cfg);
  listenPort = await listenTestApp(app as never, cfg);
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
  (globalThis as any).__itestDir = dir;
});

after(async () => {
  await stopMockProvider();
  await app.close();
  const dir = (globalThis as any).__itestDir as string;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('conversations 端点 — translate 管线集成', () => {
  it('S5a: 普通文本流事件序列（reasoning 无 / message* / token / task.completed endReason=completed）', async () => {
    // 创建对话
    const convRes = await fetch(`http://127.0.0.1:${listenPort}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ title: 'itest', providerId, model: 'mock-model' }),
    });
    assert.equal(convRes.status, 200);
    const conv = await convRes.json() as { id: string };

    const events = await collectSse(`http://127.0.0.1:${listenPort}/api/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
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
    assert.equal(tc.data.endReason, 'completed');
    // 旧协议 message 事件存在（兼容层）
    assert.ok(names.includes('message'), '旧协议 message 事件仍应发射');
  });

  it('S5b: reasoning 流（thinking 输入作为首条 user 消息触发 mock reasoning 场景）', async () => {
    const convRes = await fetch(`http://127.0.0.1:${listenPort}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ title: 'itest-r', providerId, model: 'mock-model' }),
    });
    const conv = await convRes.json() as { id: string };
    const events = await collectSse(`http://127.0.0.1:${listenPort}/api/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ content: '带着推理 [scenario:reasoning]' }),
    });
    const names = events.map((e) => e.eventName);
    assert.ok(names.includes('agent.reasoning.delta'), '应发射 agent.reasoning.delta');
    const rd = events.filter((e) => e.eventName === 'agent.reasoning.delta').map((e) => e.data.content).join('');
    assert.equal(rd, '让我思考一下');
  });

  it('S5c: args-bad 场景 — 工具参数非法 JSON 降级为文本，流不炸', async () => {
    const convRes = await fetch(`http://127.0.0.1:${listenPort}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ title: 'itest-bad', providerId, model: 'mock-model' }),
    });
    const conv = await convRes.json() as { id: string };
    const events = await collectSse(`http://127.0.0.1:${listenPort}/api/conversations/${conv.id}/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ content: '执行工具 [scenario:args-bad]' }),
    });
    const names = events.map((e) => e.eventName);
    assert.ok(names.includes('tool-result'), '非法参数应发 tool-result');
    const tr = events.find((e) => e.eventName === 'tool-result');
    assert.ok((tr?.data?.result || '').includes('不是合法 JSON'), 'tool-result 内容应为降级错误文本');
    // 流正常结束（task.completed 或 task.failed 之一；因为 fc 循环 10 轮内 mock 只回 tool_calls，最终 max_turns → completed）
    assert.ok(names.includes('task.completed') || names.includes('task.failed'));
  });
});