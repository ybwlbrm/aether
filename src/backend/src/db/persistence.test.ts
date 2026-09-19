/**
 * 对话持久化回归测试 —— 修复"关闭应用后对话丢失"。
 *
 * 根因：flushNow 在距上次 markDirty < FLUSH_MAX_LATENCY_MS(5s) 时只重排定时器
 * 并 return（不写盘）。关闭场景（onClose → flushDbSync → flushNow）同样命中该
 * 分支 → app.close() 完成后进程退出，定时器未执行 → dirty 数据从未写盘 → 对话全丢。
 *
 * 修复：flushDbSync(force=true) 无条件导出写盘，忽略 debounce。
 *
 * 测试场景：
 * S1 happy: 创建对话 + 立即 flushDbSync → 文件包含该对话
 * S2 edge: 多次 markDirty 后立即 flushDbSync（<5s 窗口）→ 数据仍完整落盘
 * S3 regression: 防抖路径（非 force）仍按 5s 延迟调度，不误写
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import initSqlJs from 'sql.js';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../db/migrate.js';
import { initDb, getDb, flushDbSync, saveDb, markDirty } from '../db/client.js';
import { conversations, providers } from '../db/schema/index.js';
import { makeTestConfig } from '../tests/helpers/mock-provider.sse.js';
import type { BackendConfig } from '../config/index.js';

let dir: string;
let cfg: BackendConfig;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pacc-persist-'));
  cfg = makeTestConfig(dir);
  await runMigrations(cfg);
  await initDb(cfg);
  // conversations.provider_id 有 FK → 先插 provider
  getDb().insert(providers).values({
    id: 'p', name: 'persist-test', type: 'openai', apiKey: 'enc:test',
    models: JSON.stringify(['m']), capabilities: JSON.stringify(['text']),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }).run();
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('对话持久化（关闭应用不丢失）', () => {
  test('S1: 创建对话 + 立即 flushDbSync → 数据库文件包含该对话', () => {
    const db = getDb();
    const now = new Date().toISOString();
    db.insert(conversations).values({
      id: 'persist-conv-1', title: '持久化测试对话', providerId: 'p', model: 'm',
      createdAt: now, updatedAt: now,
    }).run();
    // 关键：刚 markDirty（<5s 窗口）就立即强制落盘 —— 修复前会走 debounce 分支不写盘
    const ok = flushDbSync(cfg);
    assert.equal(ok, true, 'flushDbSync 应成功');
    assert.ok(existsSync(cfg.dbPath), '数据库文件应存在');
    // 重新打开文件验证对话在
    const SQL = initSqlJs();
    return SQL.then((sql) => {
      const db2 = new sql.Database(readFileSync(cfg.dbPath));
      const r = db2.exec("SELECT title FROM conversations WHERE id='persist-conv-1'");
      assert.ok(r[0] && r[0].values.length === 1, '关闭后对话必须存在于文件中');
      assert.equal(r[0].values[0][0], '持久化测试对话');
      db2.close();
    });
  });

  test('S2: 模拟"关闭前最后一次写入"（距上次 markDirty < 5s）→ 强制落盘数据完整', () => {
    const db = getDb();
    const now = new Date().toISOString();
    db.insert(conversations).values({
      id: 'persist-conv-2', title: '关闭前对话', providerId: 'p', model: 'm',
      createdAt: now, updatedAt: now,
    }).run();
    // 立即强制落盘（正是关闭应用场景：写入后立刻 flushDbSync）
    const ok = flushDbSync(cfg);
    assert.equal(ok, true);
    const SQL = initSqlJs();
    return SQL.then((sql) => {
      const db2 = new sql.Database(readFileSync(cfg.dbPath));
      const r = db2.exec("SELECT title FROM conversations WHERE id='persist-conv-2'");
      assert.ok(r[0] && r[0].values.length === 1, '关闭前写入的对话必须保留');
      db2.close();
    });
  });

  test('S3: 防抖路径（saveDb）不立即写盘，但最终 flushDbSync 兜底', () => {
    const db = getDb();
    const now = new Date().toISOString();
    db.insert(conversations).values({
      id: 'persist-conv-3', title: '防抖对话', providerId: 'p', model: 'm',
      createdAt: now, updatedAt: now,
    }).run();
    saveDb(cfg); // 防抖（不强制）
    // 立即强制落盘（模拟应用关闭）
    flushDbSync(cfg);
    const SQL = initSqlJs();
    return SQL.then((sql) => {
      const db2 = new sql.Database(readFileSync(cfg.dbPath));
      const r = db2.exec("SELECT title FROM conversations WHERE id='persist-conv-3'");
      assert.ok(r[0] && r[0].values.length === 1, '防抖后强制落盘应保留数据');
      db2.close();
    });
  });
});
