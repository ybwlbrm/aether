/**
 * EventStoreRuntime tests (P0-11: critical event write failure must not be swallowed)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../db/migrate.js';
import { initDb, getDb } from '../db/client.js';
import { makeTestConfig } from '../tests/helpers/mock-provider.sse.js';
import type { BackendConfig } from '../config/index.js';
import { emitV2Event, resetV2EventRuntime, getV2EventStore, ensureRunRow, finalizeRunTokens } from './event-store-runtime.js';
import { runs } from '../db/schema/index.js';
import { eq } from 'drizzle-orm';

let cfg: BackendConfig;
let dir: string;

/** events 表对 runs 有 FK —— 必须在 emit 前为测试 run 建行（conversationId=null 避免 conversations FK） */
async function ensureRun(runId: string): Promise<void> {
  await runMigrations(cfg as never);
  ensureRunRow(getDb(), runId);
}

describe('lib/event-store-runtime', () => {
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pacc-esr-'));
    cfg = makeTestConfig(dir);
    await runMigrations(cfg as never);
    await initDb(cfg as never);
  });

  after(() => {
    resetV2EventRuntime();
    rmSync(dir, { recursive: true, force: true });
  });

  it('writes a real v2 event and returns it', async () => {
    resetV2EventRuntime();
    await ensureRun('run-green');
    const ev = await emitV2Event({
      runId: 'run-green',
      sessionId: 'sess-green',
      taskId: 'task-green',
      agentId: 'sisyphus',
      type: 'run.started',
      payload: { mode: 'super' },
    });
    assert.ok(ev, 'event should be written');
    assert.equal(ev.type, 'run.started');
    assert.ok(ev.seq >= 1);
    assert.equal(ev.runId, 'run-green');
  });

  it('emitV2Event default mode swallows append failure (returns null)', async () => {
    await ensureRun('run-swallow');
    const store = getV2EventStore();
    const orig = store.append.bind(store);
    Object.defineProperty(store, 'append', {
      value: async () => { throw new Error('db down (simulated)'); },
      configurable: true,
    });
    try {
      const r = await emitV2Event({ runId: 'run-swallow', sessionId: 's1', type: 'agent.started', payload: {} });
      assert.equal(r, null, 'default mode must not throw');
    } finally {
      Object.defineProperty(store, 'append', { value: orig, configurable: true });
    }
  });

  it('P0-11: critical mode propagates append failure (throws)', async () => {
    await ensureRun('run-critical');
    const store = getV2EventStore();
    const orig = store.append.bind(store);
    Object.defineProperty(store, 'append', {
      value: async () => { throw new Error('db down (simulated)'); },
      configurable: true,
    });
    try {
      await assert.rejects(
        emitV2Event({ runId: 'run-critical', sessionId: 's1', type: 'run.started', payload: {}, critical: true }),
        /db down/,
      );
    } finally {
      Object.defineProperty(store, 'append', { value: orig, configurable: true });
    }
  });

  it('RUN-001: finalizeRunTokens 合法终态写入成功（running→completed）', () => {
    ensureRunRow(getDb(), 'run-ok');
    finalizeRunTokens(getDb(), 'run-ok', 'completed', { inputTokens: 10, outputTokens: 2 }, undefined);
    const row = getDb().select({ status: runs.status, totalTokens: runs.totalTokens }).from(runs)
      .where(eq(runs.id, 'run-ok')).get();
    assert.ok(row);
    assert.equal(row.status, 'completed');
    assert.equal(row.totalTokens, 12);
  });

  it('RUN-001: 终态不再允许转移（completed→completed）→ 抛 INVALID_RUN_TRANSITION 且不覆盖', () => {
    ensureRunRow(getDb(), 'run-terminal');
    finalizeRunTokens(getDb(), 'run-terminal', 'completed', { inputTokens: 1 }, undefined);
    // 非法：completed 后的再次 finalize —— 状态机必须拒绝
    assert.throws(
      () => finalizeRunTokens(getDb(), 'run-terminal', 'completed', { inputTokens: 99 }, undefined),
      (err: unknown) => {
        assert.match(String((err as Error).message), /INVALID_RUN_TRANSITION|非法状态转移/);
        return true;
      },
    );
    const row = getDb().select({ inputTokens: runs.inputTokens }).from(runs)
      .where(eq(runs.id, 'run-terminal')).get();
    assert.equal(row!.inputTokens, 1, '非法转移不得写入任何字段');
  });

  it('RUN-001: created→completed 非法（created 只能 → running）', () => {
    // 手动插入 created 状态 run
    getDb().insert(runs).values({
      id: 'run-created',
      conversationId: null,
      status: 'created',
      mode: 'normal',
      startedAt: null,
      createdAt: new Date().toISOString(),
    }).run();
    assert.throws(
      () => finalizeRunTokens(getDb(), 'run-created', 'completed', {}, undefined),
      /INVALID_RUN_TRANSITION|非法状态转移/,
    );
  });
});