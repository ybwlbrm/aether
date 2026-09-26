/**
 * AEX-P0-011 — 编排关键事件必须被 await（补偿路径必须是活代码）
 *
 * 缺陷：`void emitV2Event({ type: 'run.created', critical: true })` 让 emit 的
 * rejection 变成无主 Promise —— 外层 try/catch 的 `transition(runId, 'fail')`
 * 补偿永远不触发（死代码），于是「run 已经在跑但 events 表没有起点」的
 * 假稳定状态被静默接受。
 *
 * 本测试把生产 EventStore 的 append 打坏（模拟 events 表不可写），
 * 断言 run 行被状态机标记为 failed 且 error 为补偿文案。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { startMockProvider, stopMockProvider, makeTestConfig, listenTestApp } from '../../tests/helpers/mock-provider.sse.js';
import { buildApp } from '../../app.js';
import { getDb } from '../../db/client.js';
import { providers, agentConfigs, conversations, runs } from '../../db/schema/index.js';
import { encrypt } from '../../lib/crypto.js';
import { getLocalAuthToken } from '../../lib/auth-token.js';
import { eq } from 'drizzle-orm';
import { getV2EventStore, resetV2EventRuntime } from '../../lib/event-store-runtime.js';

let app: FastifyInstance;
let baseUrl = '';
let listenPort = 0;
let convId = '';
let testDir = '';
/** 整改计划第 1 章（P0）：auth-guard 默认拒绝 —— 测试请求必须携带 Bearer token */
let authToken = '';

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { ...extra, Authorization: `Bearer ${authToken}` };
}

/** 读完 SSE 直到连接关闭（编排无论成败都会 end） */
async function drainSse(url: string, init: RequestInit): Promise<string[]> {
  const res = await fetch(url, init);
  assert.ok(res.ok, `HTTP ${res.status}`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const names: string[] = [];
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n\n')) !== -1) {
      const raw = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      for (const line of raw.split(/\r?\n/)) {
        if (line.startsWith('event:')) names.push(line.slice(6).trim());
      }
    }
  }
  return names;
}

before(async () => {
  testDir = mkdtempSync(join(tmpdir(), 'pacc-oevents-'));
  const cfg = makeTestConfig(testDir);
  app = await buildApp(cfg);
  authToken = getLocalAuthToken() || '';
  assert.ok(authToken, 'buildApp 后应能读取本地认证 token');
  listenPort = await listenTestApp(app as never, cfg);
  baseUrl = await startMockProvider();
  const now = new Date().toISOString();
  const db = getDb();
  db.insert(providers).values({
    id: 'mock-provider-oe', name: 'mock-oe', type: 'openai',
    apiKey: encrypt('mock-key', cfg.encryptionKey), baseUrl,
    models: JSON.stringify(['mock-model']),
    capabilities: JSON.stringify(['text']), isDefault: true, createdAt: now, updatedAt: now,
  }).run();
  db.insert(agentConfigs).values({
    id: 'cfg-sisyphus-oe', agentId: 'sisyphus', providerId: 'mock-provider-oe',
    model: 'mock-model', createdAt: now, updatedAt: now,
  }).run();
  convId = 'oevents-conv';
  db.insert(conversations).values({
    id: convId, title: 'oevents', providerId: 'mock-provider-oe', model: 'mock-model',
    createdAt: now, updatedAt: now,
  }).run();
});

after(async () => {
  resetV2EventRuntime();
  await stopMockProvider();
  await app.close();
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

describe('AEX-P0-011 agents/orchestrate 关键事件 await 语义', () => {
  it('events 表不可写时 run.created 的 fail 补偿必须真正生效（await 而非 void）', async () => {
    // Given：生产 v2 EventStore 写入失败（events 表不可用）
    const store = getV2EventStore();
    const originalAppend = store.append.bind(store);
    Object.defineProperty(store, 'append', {
      value: async () => { throw new Error('events store unavailable (simulated)'); },
      configurable: true,
    });

    try {
      // When：发起一次编排
      await drainSse(`http://127.0.0.1:${listenPort}/api/agents/orchestrate`, {
        method: 'POST',
        headers: authHeaders({ 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }),
        body: JSON.stringify({ prompt: '简单问题 [scenario:text]', conversationId: convId }),
      });

      // Then：runs 行被状态机补偿为 failed（而不是继续跑到 completed）
      const rows = getDb().select().from(runs).where(eq(runs.conversationId, convId)).all();
      assert.equal(rows.length, 1, '一次编排只应有一个 run 行');
      const row = rows[0]!;
      assert.equal(row.status, 'failed', `run 应被补偿为 failed，实际 ${row.status}`);
      assert.match(String(row.error ?? ''), /event store write failed/);
      assert.equal(row.endReason, 'error');
    } finally {
      Object.defineProperty(store, 'append', { value: originalAppend, configurable: true });
    }
  });
});
