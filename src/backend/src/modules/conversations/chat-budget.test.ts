/**
 * AEX-P0-003 — 预算耗尽不得触发隐藏模型调用
 *
 * 缺陷：工具循环因预算耗尽（budgetExceeded != null）停止且没有产出文本时，
 * chat-handler 仍会调用 executeForceSummary —— 那是一次规范未授权的额外模型
 * 请求（隐藏调用）：用户已经因预算被打断，系统却在他背后继续烧 token。
 *
 * 规范：budget_exceeded / cancelled / interrupted / failed 一律不得发起隐藏总结调用。
 *
 * 本测试自带一个「只回 tool_calls」的 mock provider（参数非法 → 不执行真实工具，
 * 快速耗尽轮数预算），并记录每个请求体：
 * - 断言请求体中不含强制总结提示词 ⇒ executeForceSummary 未被调用
 * - 断言最终落库的 assistant 文本不是任何伪造的「处理完成」兜底
 *
 * 注：执行循环在预算耗尽时会写入结构化停止说明（finalizeOnBudgetExceeded），
 * 因此当前生产路径下 aiContent 非空 —— 本用例是回归锁（防未来改动让隐藏调用复活）；
 * 决策规则本身的 RED 证据见 compaction.test.ts 的 resolveTextFallback 用例。
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../app.js';
import { getDb } from '../../db/client.js';
import { providers, messages } from '../../db/schema/index.js';
import { encrypt } from '../../lib/crypto.js';
import { getLocalAuthToken } from '../../lib/auth-token.js';
import { makeTestConfig, listenTestApp } from '../../tests/helpers/mock-provider.sse.js';
import { eq } from 'drizzle-orm';

/** executeForceSummary 追加的唯一 user 提示词片段（用于识别隐藏调用） */
const FORCE_SUMMARY_MARKER = '请基于上面所有工具执行的结果';

let app: FastifyInstance;
let listenPort = 0;
let providerId = '';
let testDir = '';
let authToken = '';
let provider: Server | null = null;
/** mock provider 收到的每个请求体（按到达顺序） */
let requestBodies: string[] = [];

function authHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { ...extra, Authorization: `Bearer ${authToken}` };
}

type SseEvent = { readonly eventName: string; readonly data: unknown };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readStringField(value: unknown, field: string): string | null {
  if (!isRecord(value)) return null;
  const fieldValue = value[field];
  return typeof fieldValue === 'string' ? fieldValue : null;
}

async function collectSse(url: string, init: RequestInit): Promise<SseEvent[]> {
  const res = await fetch(url, init);
  assert.ok(res.ok, `HTTP ${res.status}`);
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  const events: SseEvent[] = [];
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
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

/** 启动「只回 tool_calls」的 mock provider：参数非法（降级为文本错误，不执行真实工具） */
function startToolCallOnlyProvider(): Promise<string> {
  provider = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      requestBodies.push(body);
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write('data: ' + JSON.stringify({
        id: 'chatcmpl-budget', object: 'chat.completion.chunk', created: 0, model: 'mock',
        choices: [{ index: 0, delta: { role: 'assistant', tool_calls: [{ index: 0, id: 'call_budget', type: 'function', function: { name: 'read_file', arguments: '{not-json' } }] }, finish_reason: null }],
      }) + '\n\n');
      res.write('data: ' + JSON.stringify({
        id: 'chatcmpl-budget', object: 'chat.completion.chunk', created: 0, model: 'mock',
        choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
      }) + '\n\n');
      res.write('data: [DONE]\n\n');
      res.end();
    });
  });
  return new Promise((resolve) => {
    provider!.listen(0, '127.0.0.1', () => {
      const addr = provider!.address() as AddressInfo;
      resolve(`http://127.0.0.1:${addr.port}/v1`);
    });
  });
}

before(async () => {
  testDir = mkdtempSync(join(tmpdir(), 'pacc-budget-'));
  const cfg = makeTestConfig(testDir);
  app = await buildApp(cfg);
  authToken = getLocalAuthToken() || '';
  assert.ok(authToken, 'buildApp 后应能读取本地认证 token');
  listenPort = await listenTestApp(app as never, cfg);
  const baseUrl = await startToolCallOnlyProvider();
  providerId = 'mock-provider-budget';
  const now = new Date().toISOString();
  const db = getDb();
  db.insert(providers).values({
    id: providerId, name: 'mock-budget', type: 'openai',
    apiKey: encrypt('mock-key', cfg.encryptionKey), baseUrl, models: JSON.stringify(['mock-model']),
    capabilities: JSON.stringify(['text']), isDefault: false, createdAt: now, updatedAt: now,
  }).run();
});

after(async () => {
  if (provider) await new Promise<void>((resolve) => provider!.close(() => resolve()));
  await app.close();
  if (testDir) rmSync(testDir, { recursive: true, force: true });
});

describe('AEX-P0-003 conversations 预算耗尽不得触发隐藏模型调用', () => {
  it('轮数预算耗尽后不再发起强制总结请求，且不落库「处理完成」兜底文案', async () => {
    // Given
    const convRes = await fetch(`http://127.0.0.1:${listenPort}/api/conversations`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }),
      body: JSON.stringify({ title: 'budget', providerId, model: 'mock-model' }),
    });
    assert.equal(convRes.status, 200);
    const convJson: unknown = await convRes.json();
    assert.ok(isRecord(convJson) && typeof convJson.id === 'string', 'conversation response missing id');
    const convId = convJson.id;
    requestBodies = [];

    // When
    const events = await collectSse(`http://127.0.0.1:${listenPort}/api/conversations/${convId}/messages`, {
      method: 'POST',
      headers: authHeaders({ 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' }),
      body: JSON.stringify({ content: '一直调用工具直到预算耗尽' }),
    });

    // Then（1）预算是真的耗尽了（否则本用例无意义）
    const errorEvent = events.find((event) => event.eventName === 'error');
    assert.ok(errorEvent, '预算耗尽必须发 error 事件');
    assert.equal(readStringField(errorEvent.data, 'code'), 'BUDGET_EXCEEDED');
    assert.ok(requestBodies.length >= 2, `工具循环应多轮执行，实际请求数 ${requestBodies.length}`);

    // Then（2）没有任何一次请求携带强制总结提示词 ⇒ executeForceSummary 未被调用
    const forceSummaryCalls = requestBodies.filter((body) => body.includes(FORCE_SUMMARY_MARKER));
    assert.equal(
      forceSummaryCalls.length,
      0,
      `预算耗尽后不得发起隐藏总结模型调用（实际 ${forceSummaryCalls.length} 次）`,
    );

    // Then（3）落库的 assistant 文本不得是任何伪造的「处理完成」兜底
    const assistantRows = getDb().select().from(messages)
      .where(eq(messages.conversationId, convId))
      .orderBy(messages.seq)
      .all()
      .filter((row) => row.role === 'assistant');
    const lastAssistant = assistantRows[assistantRows.length - 1];
    assert.ok(lastAssistant, '应有落库的 assistant 消息');
    assert.doesNotMatch(
      lastAssistant.content,
      /处理完成（工具调用已执行）|处理完成（无文本输出）/,
      '预算耗尽不得落库伪造的「处理完成」兜底文案',
    );
    assert.notEqual(lastAssistant.content.trim(), '', '预算耗尽仍应保留真实的停止说明');
  });
});
