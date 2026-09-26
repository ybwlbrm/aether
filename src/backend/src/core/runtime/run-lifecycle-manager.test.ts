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
import { RunLifecycleManager, resetRunLifecycleManager } from './run-lifecycle-manager.js'
import { RuntimeError } from '../errors/index.js'
import { runs } from '../../db/schema/index.js'
import { eq, sql } from 'drizzle-orm'

let cfg: BackendConfig
let dir: string

function ageRun(runId: string, ageMs: number): void {
  getDb().run(
    sql`UPDATE runs SET last_updated_at = ${new Date(Date.now() - ageMs).toISOString()} WHERE id = ${runId}`,
  )
}

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

  it('CAS：两个终态竞争时只允许一个写入并报告并发冲突', () => {
    const lm = new RunLifecycleManager(getDb())
    lm.createAndStart({ runId: 'r-cas', mode: 'normal' })

    const completed = lm.transition('r-cas', 'complete', {
      endReason: 'completed',
      expectedStatus: 'running',
    })
    assert.equal(completed.status, 'completed')

    assert.throws(
      () => lm.transition('r-cas', 'fail', {
        error: 'late failure',
        expectedStatus: 'running',
      }),
      (error: unknown) => {
        assert.ok(error instanceof RuntimeError)
        assert.equal(error.code, 'RUN_TRANSITION_CONFLICT')
        return true
      },
    )
    assert.equal(lm.get('r-cas')?.status, 'completed')
  })

  it('CAS affected=0：状态在读取后改变时不覆盖并抛冲突', () => {
    const lm = new RunLifecycleManager(getDb())
    lm.createAndStart({ runId: 'r-cas-affected', mode: 'normal' })
    const read = lm.get.bind(lm)
    let injected = false
    lm.get = (runId: string) => {
      const current = read(runId)
      if (current && !injected) {
        injected = true
        getDb().update(runs).set({ status: 'waiting' }).where(eq(runs.id, runId)).run()
        return { ...current, status: 'running' }
      }
      return current
    }

    assert.throws(
      () => lm.transition('r-cas-affected', 'complete', { expectedStatus: 'running' }),
      (error: unknown) => {
        assert.ok(error instanceof RuntimeError)
        assert.equal(error.code, 'RUN_TRANSITION_CONFLICT')
        return true
      },
    )
    assert.equal(lm.get('r-cas-affected')?.status, 'waiting')
  })

  it('新状态动作串行通过 retry/verify/budget 终态并保存重试元数据', () => {
    const lm = new RunLifecycleManager(getDb())
    lm.createAndStart({
      runId: 'r-new-states',
      parentRunId: 'parent-run',
      retryOfRunId: 'previous-run',
      attempt: 2,
      retryType: 'transient',
      mode: 'normal',
    })

    lm.transition('r-new-states', 'retry_waiting', { error: 'temporary provider failure' })
    lm.transition('r-new-states', 'retrying')
    lm.transition('r-new-states', 'resume')
    lm.transition('r-new-states', 'verifying')
    const completed = lm.transition('r-new-states', 'complete', { endReason: 'verified' })

    assert.equal(completed.status, 'completed')
    assert.equal(completed.parentRunId, 'parent-run')
    assert.equal(completed.retryOfRunId, 'previous-run')
    assert.equal(completed.attempt, 2)
    assert.equal(completed.retryType, 'transient')
    assert.equal(completed.error, 'temporary provider failure')

    lm.createAndStart({ runId: 'r-budget', mode: 'normal' })
    const budget = lm.transition('r-budget', 'budget_exceeded', { endReason: 'tokens' })
    assert.equal(budget.status, 'budget_exceeded')
    assert.equal(budget.endReason, 'tokens')
    assert.ok(budget.completedAt)
  })

  it('fail transition 持久化真实 error 而不是 endReason', () => {
    const lm = new RunLifecycleManager(getDb())
    lm.createAndStart({ runId: 'r-error-persist', mode: 'normal' })

    const row = lm.transition('r-error-persist', 'fail', {
      error: 'provider connection reset',
      endReason: 'error',
    })

    assert.equal(row.status, 'failed')
    assert.equal(row.error, 'provider connection reset')
    assert.equal(row.endReason, 'error')
  })

  it('§36 token 累加防膨胀：running 期间多次增量更新不重复累计 total', () => {
    const lm = new RunLifecycleManager(getDb())
    lm.createAndStart({ runId: 'r-tok-delta', mode: 'normal' })
    // 第一轮增量：input 100, output 30（running → waiting，token 随 transition 累加）
    lm.transition('r-tok-delta', 'pause', { inputTokens: 100, outputTokens: 30 })
    // 第二轮增量：input 50, output 10（waiting → running）
    lm.transition('r-tok-delta', 'resume', { inputTokens: 50, outputTokens: 10 })
    // 终态 complete（running → completed）
    lm.transition('r-tok-delta', 'complete', { endReason: 'completed' })
    const row = lm.get('r-tok-delta')
    assert.equal(row?.inputTokens, 150, 'input 应累加 100+50')
    assert.equal(row?.outputTokens, 40, 'output 应累加 30+10')
    assert.equal(row?.totalTokens, 190, 'total 应为 150+40（不膨胀）')
  })

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

  it('recoverStale：只恢复超过租约阈值的 running/waiting，保留新 Run', () => {
    const lm = new RunLifecycleManager(getDb())
    lm.createAndStart({ runId: 'r-stale-1', mode: 'normal' })
    lm.createAndStart({ runId: 'r-stale-2', mode: 'normal' })
    lm.transition('r-stale-2', 'pause')
    lm.createAndStart({ runId: 'r-fresh', mode: 'normal' })
    lm.createAndStart({ runId: 'r-done', mode: 'normal' })
    lm.transition('r-done', 'complete', { endReason: 'completed' })
    ageRun('r-stale-1', 31 * 60 * 1000)
    ageRun('r-stale-2', 31 * 60 * 1000)

    const marked = lm.recoverStale()
    assert.equal(marked, 2)

    const s1 = getDb().select().from(runs).where(eq(runs.id, 'r-stale-1')).get()
    assert.equal(s1?.status, 'interrupted')
    assert.equal(s1?.endReason, 'crashed')
    const s2 = getDb().select().from(runs).where(eq(runs.id, 'r-stale-2')).get()
    assert.equal(s2?.status, 'interrupted')
    const fresh = getDb().select().from(runs).where(eq(runs.id, 'r-fresh')).get()
    assert.equal(fresh?.status, 'running')
    const done = getDb().select().from(runs).where(eq(runs.id, 'r-done')).get()
    assert.equal(done?.status, 'completed', 'completed run 不得被 recover 改动')
  })

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
