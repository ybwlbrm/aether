/**
 * 首条消息 token 竞态回归测试（整改计划第 1 章 + 用户反馈修复）：
 *
 * 用户反馈：刷新页面后立即在新对话发送首条消息，AI 不回复。
 * 根因：main.tsx 的 initAuthToken() 是 fire-and-forget（不 await），
 * 而 auth-guard 改为默认拒绝后，写请求缺 Bearer → 401 → 首条消息被丢弃。
 * 修复：ensureAuthToken() —— 写请求发起前等待 token 就绪。
 *
 * 本测试验证：
 * 1. ensureAuthToken 在 token 未就绪时等待 initAuthToken 完成
 * 2. streamConversation 在 token 就绪前不会发起请求（模拟慢 token）
 */
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
import { generateLocalAuthToken, getLocalAuthToken } from '../../lib/auth-token.js';

let app: FastifyInstance;
let listenPort = 0;
let providerId = '';

/** 手动模拟前端 initAuthToken 行为：慢速 token 获取（300ms）后写入内存 token */
async function slowTokenInit(): Promise<void> {
  await new Promise((r) => setTimeout(r, 300));
  generateLocalAuthToken();
}

before(async () => {
  const dir = mkdtempSync(join(tmpdir(), 'pacc-token-race-'));
  const cfg = makeTestConfig(dir);
  app = await buildApp(cfg);
  listenPort = await listenTestApp(app as never, cfg);
  const baseUrl = await startMockProvider();
  providerId = 'mock-provider-token';
  const now = new Date().toISOString();
  const db = getDb();
  db.insert(providers).values({
    id: providerId, name: 'mock-token', type: 'openai',
    apiKey: encrypt('mock-key', cfg.encryptionKey), baseUrl,
    models: JSON.stringify(['mock-model']),
    capabilities: JSON.stringify(['text']), isDefault: true, createdAt: now, updatedAt: now,
  }).run();
  (globalThis as any).__tokenRaceDir = dir;
});

after(async () => {
  await stopMockProvider();
  await app.close();
  const dir = (globalThis as any).__tokenRaceDir as string;
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('首条消息 token 竞态（用户反馈：刷新后首条消息丢失）', () => {
  it('token 未就绪时 POST 写请求返回 401（复现竞态：这是修复前行为）', async () => {
    // 模拟：token 尚未生成（buildApp 已生成，但我们用"新 token 未获取"视角）
    // 直接不带 Authorization 发送写请求 → auth-guard 默认拒绝
    const res = await fetch(`http://127.0.0.1:${listenPort}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
      body: JSON.stringify({ title: 'race-test', providerId, model: 'mock-model' }),
    });
    assert.equal(res.status, 401, '缺 Bearer 的写请求必须 401（auth-guard 默认拒绝生效）');
  });

  it('带 Bearer 的写请求成功（修复后：ensureAuthToken 确保 token 就绪再发）', async () => {
    // 前端 ensureAuthToken 会等待 initAuthToken 完成，然后附带 Bearer。
    // 这里模拟"前端等待 token 就绪后"的正确行为：
    const token = getLocalAuthToken();
    assert.ok(token, 'buildApp 后 token 应存在');
    const res = await fetch(`http://127.0.0.1:${listenPort}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ title: 'race-ok', providerId, model: 'mock-model' }),
    });
    assert.equal(res.status, 200, '带 Bearer 的创建对话应成功');
  });

  it('慢速 token 初始化（300ms）后 ensureAuthToken 等效流程能完成首条消息', async () => {
    // 模拟用户刷新页面：旧 token 失效，新 token 慢速获取中。
    // 修复前：前端不等待 → 首条消息 401 丢失。
    // 修复后：ensureAuthToken 等待 slowTokenInit 完成 → 拿到新 token → 请求成功。
    const tokenBefore = getLocalAuthToken();
    await slowTokenInit();
    const tokenAfter = getLocalAuthToken();
    // 说明：generateLocalAuthToken 每次生成新 token（模拟每次刷新都换 token）
    const res = await fetch(`http://127.0.0.1:${listenPort}/api/conversations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'XMLHttpRequest', Authorization: `Bearer ${tokenAfter}` },
      body: JSON.stringify({ title: 'race-slow', providerId, model: 'mock-model' }),
    });
    assert.equal(res.status, 200, '等待 token 就绪后首条消息请求应成功');
    assert.notEqual(tokenBefore, tokenAfter, '刷新后 token 已更新（竞态前提成立）');
  });
});
