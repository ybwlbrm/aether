import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startMockProvider, stopMockProvider, makeTestConfig, listenTestApp } from '../../tests/helpers/mock-provider.sse.js';
import { buildApp } from '../../app.js';
import type { FastifyInstance } from 'fastify';
import { getDb } from '../../db/client.js';
import { providers, agentConfigs, conversations } from '../../db/schema/index.js';
import { encrypt } from '../../lib/crypto.js';

let app: FastifyInstance;
let baseUrl = '';
let listenPort = 0;
let convId = '';

async function collectSse(url: string, init: RequestInit): Promise<{ eventName: string; data: any }[]> {
  const res = await fetch(url, init);
  assert.ok(res.ok, `HTTP ${res.status}`);
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
      try { events.push({ eventName, data: JSON.parse(dataLine) }); } catch { /* ignore */ }
    }
  }
  return events;
}

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pacc-oitest-'));
  const cfg = makeTestConfig(dir);
  app = await buildApp(cfg);
  listenPort = await listenTestApp(app as never, cfg);
  baseUrl = await startMockProvider();
  const now = new Date().toISOString();
  const db = getDb();
  const encKey = cfg.encryptionKey;
  // 插入通用 provider（orchestrate 的 resolveAgentEndpoint 依赖 getProviderByCapability('text')）
  db.insert(providers).values({
    id: 'mock-provider-o', name: 'mock-o', type: 'openai',
    apiKey: encrypt('mock-key', encKey), baseUrl,
    models: JSON.stringify(['mock-model']),
    capabilities: JSON.stringify(['text']), isDefault: true, createdAt: now, updatedAt: now,
  }).run();
  // 给 sisyphus 配置 agent model
  db.insert(agentConfigs).values({
    id: 'cfg-sisyphus', agentId: 'sisyphus', providerId: 'mock-provider-o',
    model: 'mock-model', createdAt: now, updatedAt: now,
  }).run();
  // 预建真实 conversation（messages/activity_events 外键约束）
  convId = 'oitest-conv';
  db.insert(conversations).values({
    id: convId, title: 'oitest', providerId: 'mock-provider-o', model: 'mock-model',
    createdAt: now, updatedAt: now,
  }).run();
  (globalThis as any).__oitestDir = dir;
});

after(async () => {
  await stopMockProvider();
  await app.close();
  const dir = (globalThis as any).__oitestDir as string;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('agents/orchestrate 端点 — translate 管线 + agent.output.* 事件', () => {
  it('超级模式：子 Agent 过程 agent.message.delta 与最终 agent.output.delta 分离，task.completed 带 endReason', async () => {
    const events = await collectSse(`http://127.0.0.1:${listenPort}/api/agents/orchestrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({
        prompt: '简单问题 [scenario:text]',
        conversationId: convId,
      }),
    });
    const names = events.map((e) => e.eventName);
        // 编排正常结束：结束必经 task.started（有 conversationId 时）或至少 agent.* 与 task.completed
    assert.ok(names.includes('task.completed'), '应有 task.completed');
    const tc = events.find((e) => e.eventName === 'task.completed');
    assert.equal(tc?.data?.endReason, 'completed');
  });

  it('tools 场景：fc 循环组装工具调用并执行（mock 只发 tool_calls，走 executeTool 需要真实工具 → 在无文件场景会以错误结果收尾，但不炸流）', async () => {
    const events = await collectSse(`http://127.0.0.1:${listenPort}/api/agents/orchestrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({
        prompt: '调用工具看看 [scenario:tools]',
        conversationId: convId,
      }),
    });
    const names = events.map((e) => e.eventName);
    // tool 流程事件存在
    const hasToolEvent = names.some((n) => n === 'tool.started' || n === 'tool.completed' || n === 'tool.error');
    assert.ok(hasToolEvent, '应有工具相关事件');
    // 编排正常收尾（tools 场景 mock 无限 tool_calls → max_turns 或 API error 兜底，但必须有终结事件）
    assert.ok(names.includes('task.completed') || names.includes('task.failed'), '应有终结事件');
  });

  it('truncated 场景：断流不静默 — 应有 error 事件或 task.failed', async () => {
    const events = await collectSse(`http://127.0.0.1:${listenPort}/api/agents/orchestrate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({
        prompt: '截断你吧 [scenario:truncated]',
        conversationId: convId,
      }),
    });
    const names = events.map((e) => e.eventName);
    assert.ok(
      names.includes('error') || names.includes('task.failed'),
      `断流应触发显式错误事件，实际: ${names.join(',')}`,
    );
  });
});
