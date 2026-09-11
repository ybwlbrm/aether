/**
 * SqliteMemoryRuntime tests (P1-18: MemoryRuntime → MemoryStore → SQLite 生产链路)
 *
 * 覆盖：
 * - remember 持久化到 SQLite（进程内 store 可回读）
 * - recall 查询（scope/type/contentContains AND 语义）
 * - recall 跳过过期记忆（P1-17 由 store 层保证）
 * - forget 删除
 * - release 幂等
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../../db/migrate.js';
import { getDb, setDbForTest, initDb } from '../../db/client.js';
import { SqliteMemoryRuntime, createProductionMemoryRuntime, resetSqliteMemoryRuntime, bindSqliteStoreProvider } from './memory-runtime.js';
import { SqliteMemoryStore } from '../../lib/memory-runtime-bridge.js';
import { memories } from '../../db/schema/index.js';
import type { BackendConfig } from '../../config/index.js';

let testDir: string;
let testConfig: BackendConfig;

before(async () => {
  testDir = mkdtempSync(join(tmpdir(), 'pacc-mrt-'));
  testConfig = {
    dataDir: testDir,
    dbPath: join(testDir, 'pacc.db'),
    encryptionKey: 'test-encryption-key-32-bytes-long!!',
    port: 0,
    allowedDirs: [testDir],
    allowedOrigins: [],
    enableSwagger: false,
    host: 'localhost',
  } as BackendConfig;
  await runMigrations(testConfig as never);
  const db = await initDb(testConfig as never);
  setDbForTest(db);
});

after(() => {
  setDbForTest(null);
  resetSqliteMemoryRuntime();
  rmSync(testDir, { recursive: true, force: true });
});

beforeEach(() => {
  resetSqliteMemoryRuntime();
  const db = getDb();
  db.delete(memories).run();
});

/** 构建绑定 SQLite store 的生产 runtime（显式传入 store） */
function makeRuntime(): SqliteMemoryRuntime {
  return createProductionMemoryRuntime(new SqliteMemoryStore()) as SqliteMemoryRuntime;
}

describe('core/memory/sqlite-memory-runtime (P1-18)', () => {
  it('remember 持久化到 SQLite — 新 runtime 实例可回读', async () => {
    const rt = makeRuntime();
    const created = await rt.remember({
      type: 'fact', content: '用户喜欢喝黑咖啡', scope: 'user', importance: 0.8,
    });
    assert.ok(created.id, '应生成 id');
    assert.ok(created.createdAt, '应设置 createdAt');

    // 新实例（同一 DB）可回读 —— 证明真正持久化
    const rt2 = makeRuntime();
    const recalled = await rt2.recall({ type: 'fact' });
    assert.ok(recalled.some(r => r.content === '用户喜欢喝黑咖啡'), 'SQLite 持久化的记忆应可回读');
  });

  it('recall 支持 scope/type/contentContains AND 语义', async () => {
    const rt = makeRuntime();
    await rt.remember({ type: 'project', content: 'P1 项目：商标注册', scope: 'user', importance: 0.9 });
    await rt.remember({ type: 'short_term', content: 'P1 会议纪要', scope: 'user' });

    // scope=user AND type=project —— 只应返回 project 那条
    const results = await rt.recall({ scope: 'user', type: 'project' });
    assert.equal(results.length, 1);
    assert.equal(results[0].content, 'P1 项目：商标注册');

    // contentContains 过滤
    const byContent = await rt.recall({ type: 'short_term', contentContains: '会议' });
    assert.equal(byContent.length, 1);
  });

  it('recall 排除已过期记忆（expiresAt 过去）', async () => {
    const rt = makeRuntime();
    await rt.remember({ type: 'fact', content: '有效记忆 xyz', scope: 'user' });
    await rt.remember({
      type: 'fact', content: '已过期记忆 abc', scope: 'user',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    const all = await rt.recall({});
    assert.ok(all.some(r => r.content.includes('xyz')), '有效记忆应被召回');
    assert.ok(!all.some(r => r.content.includes('abc')), '过期记忆不得被召回');
  });

  it('forget 删除成功返回 true，不存在返回 false', async () => {
    const rt = makeRuntime();
    const created = await rt.remember({ type: 'fact', content: '待删除记忆', scope: 'user' });
    const ok = await rt.forget(created.id);
    assert.equal(ok, true);
    const again = await rt.forget(created.id);
    assert.equal(again, false);
  });

  it('release 幂等且 release 后 recall 返回空', async () => {
    const rt = makeRuntime();
    await rt.remember({ type: 'fact', content: 'release 测试记忆', scope: 'user' });
    rt.release();
    rt.release(); // 幂等
    const results = await rt.recall({});
    assert.equal(results.length, 0, 'release 后不应返回记忆');
  });

  it('bindSqliteStoreProvider 注入后可经工厂创建并使用', async () => {
    resetSqliteMemoryRuntime();
    bindSqliteStoreProvider(() => new SqliteMemoryStore());
    const rt = createProductionMemoryRuntime();
    const created = await rt.remember({ type: 'fact', content: 'provider 绑定测试', scope: 'user' });
    assert.ok(created.id);
    const recalled = await rt.recall({ contentContains: 'provider 绑定' });
    assert.ok(recalled.some(r => r.content.includes('provider 绑定')));
  });
});