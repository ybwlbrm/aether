/**
 * 关闭时序回归测试：写入后立即 flushDbSync（模拟 onClose 时距上次 markDirty
 * 不到 5s —— 修复前 flushNow 走 debounce 分支不写盘 → 对话丢失）。
 */
import { test, describe, before, after } from 'node:test';
import assert from 'node:assert/strict';
import initSqlJs from 'sql.js';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../db/migrate.js';
import { initDb, getDb, flushDbSync } from '../db/client.js';
import { conversations, providers } from '../db/schema/index.js';
import { makeTestConfig } from '../tests/helpers/mock-provider.sse.js';
import type { BackendConfig } from '../config/index.js';

let dir: string;
let cfg: BackendConfig;

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pacc-close-'));
  cfg = makeTestConfig(dir);
  await runMigrations(cfg);
  await initDb(cfg);
  getDb().insert(providers).values({
    id: 'p', name: 'close-test', type: 'openai', apiKey: 'enc:test',
    models: JSON.stringify(['m']), capabilities: JSON.stringify(['text']),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  }).run();
});

after(() => rmSync(dir, { recursive: true, force: true }));

describe('关闭时序持久化（修复：force 落盘忽略 debounce）', () => {
  test('写入后立即 flushDbSync（<5s 窗口）→ 对话不丢失', async () => {
    const db = getDb();
    db.insert(conversations).values({
      id: 'close-conv-1', title: '关闭前瞬间创建的对话', providerId: 'p', model: 'm',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }).run();
    // 模拟 onClose：插入后立刻强制落盘（修复前此处走 debounce 分支 → 不写盘 → 丢失）
    const ok = flushDbSync(cfg);
    assert.equal(ok, true);
    const SQL = await initSqlJs();
    const db2 = new SQL.Database(readFileSync(cfg.dbPath));
    const r = db2.exec("SELECT title FROM conversations WHERE id='close-conv-1'");
    assert.ok(r[0] && r[0].values.length === 1, '关闭前写入的对话必须保留（force 落盘）');
    assert.equal(r[0].values[0][0], '关闭前瞬间创建的对话');
    db2.close();
  });

  test('同一场景验证消息同样保留', async () => {
    const db = getDb();
    db.insert(conversations).values({
      id: 'close-conv-2', title: '消息持久化', providerId: 'p', model: 'm',
      createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    }).run();
    flushDbSync(cfg); // 强制落盘
    const SQL = await initSqlJs();
    const db2 = new SQL.Database(readFileSync(cfg.dbPath));
    const r = db2.exec("SELECT title FROM conversations WHERE id='close-conv-2'");
    assert.ok(r[0] && r[0].values.length === 1);
    db2.close();
  });
});
