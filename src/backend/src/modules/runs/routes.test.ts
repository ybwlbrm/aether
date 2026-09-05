/**
 * Aether 2.0 Run API 集成测试（P2）— 无监听端口，使用 fastify app.inject()
 *
 * 覆盖：happy path 状态机（create→start→cancel→get）、非法状态转移 409 INVALID_TRANSITION、
 * run 不存在 404 RUN_NOT_FOUND、列表 status 过滤 + limit/offset 分页 + total、pause/resume 往返、终态吸收。
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance, type LightMyRequestResponse } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../../db/migrate.js';
import { initDb, flushDbSync } from '../../db/client.js';
import { registerErrorHandler } from '../../plugins/error-handler.js';
import { registerRunRoutes } from './index.js';
import { makeTestConfig } from '../../tests/helpers/mock-provider.sse.js';
import type { BackendConfig } from '../../config/index.js';

interface RunJson {
  id: string;
  conversationId: string | null;
  status: string;
  mode: string;
  rootAgentId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  endReason: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  error: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

let app: FastifyInstance;
let cfg: BackendConfig;
let dir: string;

const JSON_HEADERS = { 'content-type': 'application/json' };

async function createRun(payload: Record<string, unknown> = {}): Promise<RunJson> {
  const res = await app.inject({ method: 'POST', url: '/api/runs', payload, headers: JSON_HEADERS });
  assert.equal(res.statusCode, 201, `POST /api/runs 应返回 201，实际 ${res.statusCode}: ${res.body}`);
  return res.json() as RunJson;
}

function postTransition(id: string, action: string): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'POST', url: `/api/runs/${id}/${action}` });
}

function asError(body: unknown): { error: { code: string } } {
  return body as { error: { code: string } };
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pacc-runs-itest-'));
  cfg = makeTestConfig(dir);
  await runMigrations(cfg);
  await initDb(cfg);
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerRunRoutes(app, cfg);
});

after(async () => {
  flushDbSync(cfg);
  if (app) await app.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('runs 端点 — Aether 2.0 Run API（P2）', () => {
  it('happy path：create → start → cancel → get 全链路状态机', async () => {
    const created = await createRun({ mode: 'super', metadata: { source: 'itest' } });
    assert.equal(created.status, 'created');
    assert.equal(created.mode, 'super');
    assert.deepEqual(created.metadata, { source: 'itest' });
    assert.ok(created.id, '应返回生成的 id');
    assert.ok(created.createdAt, '应返回 created_at');
    assert.equal(created.conversationId, null);
    assert.equal(created.rootAgentId, null);
    assert.equal(created.startedAt, null);
    assert.equal(created.completedAt, null);
    assert.equal(created.endReason, null);
    assert.equal(created.totalTokens, 0);

    const startRes = await postTransition(created.id, 'start');
    assert.equal(startRes.statusCode, 200);
    const started = startRes.json() as RunJson;
    assert.equal(started.status, 'running');
    assert.ok(started.startedAt, 'startedAt 应被设置');

    const cancelRes = await postTransition(created.id, 'cancel');
    assert.equal(cancelRes.statusCode, 200);
    const cancelled = cancelRes.json() as RunJson;
    assert.equal(cancelled.status, 'cancelled');
    assert.ok(cancelled.completedAt, 'completedAt 应被设置');
    assert.equal(cancelled.endReason, 'cancelled');

    const got = await app.inject({ method: 'GET', url: `/api/runs/${created.id}` });
    assert.equal(got.statusCode, 200);
    const gotBody = got.json() as RunJson;
    assert.equal(gotBody.id, created.id);
    assert.equal(gotBody.status, 'cancelled');
    assert.equal(gotBody.mode, 'super');
    assert.deepEqual(gotBody.metadata, { source: 'itest' });
    assert.equal(gotBody.totalTokens, 0);
  });

  it('INVALID_TRANSITION：已启动（非 created）或终态的 run 再次 start → 409', async () => {
    const run = await createRun();
    const firstStart = await postTransition(run.id, 'start');
    assert.equal(firstStart.statusCode, 200);
    // 已启动（running）再 start → 409
    const secondStart = await postTransition(run.id, 'start');
    assert.equal(secondStart.statusCode, 409);
    assert.equal(asError(secondStart.json()).error.code, 'INVALID_TRANSITION');
    // 进入终态（cancelled）后再 start → 409（终态吸收）
    await postTransition(run.id, 'cancel');
    const startAfterTerminal = await postTransition(run.id, 'start');
    assert.equal(startAfterTerminal.statusCode, 409);
    assert.equal(asError(startAfterTerminal.json()).error.code, 'INVALID_TRANSITION');
  });

  it('RUN_NOT_FOUND：GET / start 不存在的 run → 404', async () => {
    const got = await app.inject({ method: 'GET', url: '/api/runs/does-not-exist' });
    assert.equal(got.statusCode, 404);
    assert.equal(asError(got.json()).error.code, 'RUN_NOT_FOUND');
    const start = await postTransition('does-not-exist', 'start');
    assert.equal(start.statusCode, 404);
    assert.equal(asError(start.json()).error.code, 'RUN_NOT_FOUND');
  });

  it('list：status 过滤 + limit/offset 分页 + total 正确', async () => {
    const list = async (query: string) => {
      const res = await app.inject({ method: 'GET', url: `/api/runs${query}` });
      assert.equal(res.statusCode, 200);
      return res.json() as { runs: RunJson[]; total: number };
    };

    const createdBefore = (await list('?status=created')).total;
    const runningBefore = (await list('?status=running')).total;
    const totalBefore = (await list('')).total;

    const created = await createRun();
    const started = await createRun();
    await postTransition(started.id, 'start');

    const createdAfter = await list('?status=created');
    assert.equal(createdAfter.total, createdBefore + 1, 'created 过滤 total 应 +1');
    assert.equal(createdAfter.runs.length, 1);
    assert.equal(createdAfter.runs[0].id, created.id);

    const runningAfter = await list('?status=running');
    assert.equal(runningAfter.total, runningBefore + 1);
    assert.equal(runningAfter.runs[0].id, started.id);

    const allAfter = await list('');
    assert.equal(allAfter.total, totalBefore + 2);

    const page = await list('?limit=2');
    assert.equal(page.runs.length, 2, 'limit=2 应只返回 2 条');
    assert.equal(page.total, allAfter.total);

    const clamp = await list('?limit=500');
    assert.ok(clamp.runs.length <= 200, 'limit 超 200 应被截断为最大值 200');
    await postTransition(started.id, 'cancel');
  });

  it('list：非法 status → 400 VALIDATION_ERROR', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/runs?status=bogus' });
    assert.equal(res.statusCode, 400);
    assert.equal(asError(res.json()).error.code, 'VALIDATION_ERROR');
  });

  it('create：非法 mode → 400 VALIDATION_ERROR', async () => {
    const res = await app.inject({ method: 'POST', url: '/api/runs', payload: { mode: 'bogus' }, headers: JSON_HEADERS });
    assert.equal(res.statusCode, 400);
    assert.equal(asError(res.json()).error.code, 'VALIDATION_ERROR');
  });

  it('create 默认值：mode=normal，可选字段置 null', async () => {
    const run = await createRun();
    assert.equal(run.mode, 'normal');
    assert.equal(run.status, 'created');
    assert.equal(run.conversationId, null);
    assert.equal(run.rootAgentId, null);
  });

  it('pause/resume 往返：running⇄waiting，且 created 直接 cancel → 409', async () => {
    const run = await createRun();
    await postTransition(run.id, 'start');
    const pauseRes = await postTransition(run.id, 'pause');
    assert.equal(pauseRes.statusCode, 200);
    assert.equal((pauseRes.json() as RunJson).status, 'waiting');

    const pauseAgain = await postTransition(run.id, 'pause');
    assert.equal(pauseAgain.statusCode, 409, 'waiting 状态再 pause 应 409');
    assert.equal(asError(pauseAgain.json()).error.code, 'INVALID_TRANSITION');

    const resumeRes = await postTransition(run.id, 'resume');
    assert.equal(resumeRes.statusCode, 200);
    assert.equal((resumeRes.json() as RunJson).status, 'running');

    const fresh = await createRun();
    const cancelCreated = await postTransition(fresh.id, 'cancel');
    assert.equal(cancelCreated.statusCode, 409, 'created 状态直接 cancel 应 409（仅 running|waiting 可取消）');
    assert.equal(asError(cancelCreated.json()).error.code, 'INVALID_TRANSITION');
  });
});