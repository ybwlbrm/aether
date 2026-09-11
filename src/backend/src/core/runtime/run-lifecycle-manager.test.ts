/**
 * RunLifecycleManager tests — 唯一 Run 状态机写入入口（P0-05 收口）
 *
 * 覆盖：
 * - create：created 状态创建（幂等），禁止绕过状态机直接 running
 * - createAndStart：created → running 一步到位
 * - transition：合法/非法转移校验（RUN-001）
 * - token 累计：终态写入 token 快照
 * - recoverStale：遗留 running/waiting → interrupted
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../../db/migrate.js';
import { initDb, getDb } from '../../db/client.js';
import { makeTestConfig } from '../../tests/helpers/mock-provider.sse.js';
import type { BackendConfig } from '../../config/index.js';
import { RunLifecycleManager, resetRunLifecycleManager } from './run-lifecycle-manager.js';
import { runs } from '../../db/schema/index.js';
import { eq } from 'drizzle-orm';

let cfg: BackendConfig;
let dir: string;

describe('core/runtime/run-lifecycle-manager', () => {
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pacc-rlm-'));
    cfg = makeTestConfig(dir);
    await runMigrations(cfg as never);
    await initDb(cfg as never);
  });

  after(() => {
    resetRunLifecycleManager();
    rmSync(dir, { recursive: true, force: true });
  });

  it('create 以 created 状态创建（非 running，P0-05 不再绕过状态机）', () => {
    const lm = new RunLifecycleManager(getDb());
    const row = lm.create({ runId: 'r-create-1', mode: 'normal' });
    assert.equal(row.status, 'created');
    assert.equal(row.startedAt, null);
  });

  it('create 幂等：重复创建返回已有行', () => {
    const lm = new RunLifecycleManager(getDb());
    lm.create({ runId: 'r-idem', mode: 'normal' });
    const row = lm.create({ runId: 'r-idem', mode: 'normal' });
    assert.equal(row.status, 'created');
    const count = getDb().select().from(runs).where(eq(runs.id, 'r-idem')).all();
    assert.equal(count.length, 1);
  });

  it('createAndStart：created → running 一步到位', () => {
    const lm = new RunLifecycleManager(getDb());
    const row = lm.createAndStart({ runId: 'r-start-1', conversationId: null, mode: 'normal' });
    assert.equal(row.status, 'running');
    assert.ok(row.startedAt, 'startedAt 应被设置');
  });

  it('transition start：created → running，重复 start 抛 INVALID_RUN_TRANSITION', () => {
    const lm = new RunLifecycleManager(getDb());
    lm.create({ runId: 'r-trans-start', mode: 'normal' });
    const running = lm.transition('r-trans-start', 'start');
    assert.equal(running.status, 'running');
    assert.throws(
      () => lm.transition('r-trans-start', 'start'),
      (err: unknown) => {
        assert.match(String((err as Error).message), /INVALID_RUN_TRANSITION|非法状态转移/);
        return true;
      },
    );
  });

  it('transition complete：running → completed 并写入 token 快照', () => {
    const lm = new RunLifecycleManager(getDb());
    lm.createAndStart({ runId: 'r-tok', mode: 'normal' });
    const row = lm.transition('r-tok', 'complete', { inputTokens: 10, outputTokens: 2, endReason: 'completed' });
    assert.equal(row.status, 'completed');
    assert.equal(row.inputTokens, 10);
    assert.equal(row.outputTokens, 2);
    assert.equal(row.totalTokens, 12);
    assert.ok(row.completedAt, 'completedAt 应被设置');
  });

  it('transition cancel：waiting → cancelled', () => {
    const lm = new RunLifecycleManager(getDb());
    lm.createAndStart({ runId: 'r-cancel', mode: 'normal' });
    lm.transition('r-cancel', 'pause');
    const row = lm.transition('r-cancel', 'cancel');
    assert.equal(row.status, 'cancelled');
    assert.equal(row.endReason, 'cancelled');
  });

  it('非法转移：created → completed 抛错（created 只能 → running）', () => {
    const lm = new RunLifecycleManager(getDb());
    lm.create({ runId: 'r-illegal', mode: 'normal' });
    assert.throws(
      () => lm.transition('r-illegal', 'complete'),
      /INVALID_RUN_TRANSITION|非法状态转移/,
    );
  });

  it('终态吸收：completed 后不再允许任何转移', () => {
    const lm = new RunLifecycleManager(getDb());
    lm.createAndStart({ runId: 'r-terminal', mode: 'normal' });
    lm.transition('r-terminal', 'complete', { endReason: 'completed' });
    assert.throws(
      () => lm.transition('r-terminal', 'complete'),
      /INVALID_RUN_TRANSITION|非法状态转移/,
    );
    assert.throws(
      () => lm.transition('r-terminal', 'cancel'),
      /INVALID_RUN_TRANSITION|非法状态转移/,
    );
  });

  it('recoverStale：遗留 running/waiting → interrupted（completed 不动）', () => {
    const lm = new RunLifecycleManager(getDb());
    lm.createAndStart({ runId: 'r-stale-1', mode: 'normal' });
    lm.createAndStart({ runId: 'r-stale-2', mode: 'normal' });
    lm.transition('r-stale-2', 'pause');
    lm.createAndStart({ runId: 'r-done', mode: 'normal' });
    lm.transition('r-done', 'complete', { endReason: 'completed' });

    const marked = lm.recoverStale();
    assert.ok(marked >= 2, `应恢复至少 2 个遗留 run，实际 ${marked}`);

    const s1 = getDb().select().from(runs).where(eq(runs.id, 'r-stale-1')).get();
    assert.equal(s1!.status, 'interrupted');
    assert.equal(s1!.endReason, 'crashed');
    const s2 = getDb().select().from(runs).where(eq(runs.id, 'r-stale-2')).get();
    assert.equal(s2!.status, 'interrupted');
    const done = getDb().select().from(runs).where(eq(runs.id, 'r-done')).get();
    assert.equal(done!.status, 'completed', 'completed run 不得被 recover 改动');
  });

  it('transition 不存在的 run 抛 RUN_NOT_FOUND', () => {
    const lm = new RunLifecycleManager(getDb());
    assert.throws(
      () => lm.transition('r-ghost', 'start'),
      (err: unknown) => {
        assert.match(String((err as Error).message), /RUN_NOT_FOUND|不存在/);
        return true;
      },
    );
  });
});
