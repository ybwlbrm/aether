/**
 * Memory DAL tests (Wave0-MEM — SQLite memories 表作为唯一事实源)
 *
 * 验证：
 * 1. 写入 DB + 读出一致
 * 2. 无 JSON 落盘（memory.json 不再被运行时读写）
 * 3. 新列 scope/importance/lastUsedAt/expiresAt 正常工作
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import initSqlJs from 'sql.js';
import { getDb, setDbForTest, initDb } from '../../db/client.js';
import { runMigrations } from '../../db/migrate.js';
import { memories } from '../../db/schema/index.js';
import { eq, sql } from 'drizzle-orm';
import {
  getMemories,
  saveMemory,
  updateMemory,
  deleteMemory,
} from './memory.js';
import type { MemoryItem } from './types.js';

interface TestConfig {
  dataDir: string;
  dbPath: string;
  encryptionKey: string;
  port: number;
  allowedDirs: string[];
  allowedOrigins: string[];
  enableSwagger: boolean;
  host: string;
}

let testDir: string;
let testDbPath: string;
let testConfig: TestConfig;

before(async () => {
  testDir = mkdtempSync(join(tmpdir(), 'pacc-mem-test-'));
  testDbPath = join(testDir, 'pacc.db');
  testConfig = {
    dataDir: testDir,
    dbPath: testDbPath,
    encryptionKey: 'test-encryption-key-32-bytes-long!!',
    port: 0,
    allowedDirs: [testDir],
    allowedOrigins: [],
    enableSwagger: false,
    host: 'localhost',
  };

  // 初始化数据库并运行迁移
  await runMigrations(testConfig);
  const db = await initDb(testConfig);
  setDbForTest(db);
});

after(() => {
  setDbForTest(null);
  rmSync(testDir, { recursive: true, force: true });
});

beforeEach(async () => {
  // 清空 memories 表，确保测试隔离
  const db = getDb();
  db.delete(memories).run();
});

describe('lib/dal/memory (SQLite memories 表)', () => {
  it('saveMemory 写入并 getMemories 读出一致', async () => {
    const content = '测试记忆内容';
    const category = 'long_term';
    const saved = await saveMemory(content, category);

    assert.ok(saved.id, '应生成 id');
    assert.equal(saved.content, content);
    assert.equal(saved.category, category);
    assert.ok(saved.createdAt, '应有 createdAt');
    assert.ok(saved.updatedAt, '应有 updatedAt');
    assert.equal(saved.active, true);

    const all = await getMemories();
    assert.equal(all.length, 1);
    assert.equal(all[0].id, saved.id);
    assert.equal(all[0].content, content);
    assert.equal(all[0].category, category);
  });

  it('updateMemory 更新现有记忆', async () => {
    const saved = await saveMemory('原始内容', 'short_term');
    const updated = await updateMemory(saved.id, { content: '更新后的内容', category: 'project' });

    assert.ok(updated, '应返回更新后的记忆');
    assert.equal(updated!.content, '更新后的内容');
    assert.equal(updated!.category, 'project');
    assert.ok(new Date(updated!.updatedAt) >= new Date(saved.updatedAt), 'updatedAt 应更新');

    const all = await getMemories();
    assert.equal(all.length, 1);
    assert.equal(all[0].content, '更新后的内容');
    assert.equal(all[0].category, 'project');
  });

  it('updateMemory 不存在的 id 返回 null', async () => {
    const result = await updateMemory('non-existent-id', { content: 'test' });
    assert.equal(result, null);
  });

  it('deleteMemory 删除现有记忆返回 true', async () => {
    const saved = await saveMemory('待删除内容', 'short_term');
    const deleted = await deleteMemory(saved.id);
    assert.equal(deleted, true);

    const all = await getMemories();
    assert.equal(all.length, 0);
  });

  it('deleteMemory 不存在的 id 返回 false', async () => {
    const deleted = await deleteMemory('non-existent-id');
    assert.equal(deleted, false);
  });

  it('多条记忆按 createdAt 倒序排列', async () => {
    await saveMemory('第一条', 'short_term');
    // 稍微延迟确保时间戳不同
    await new Promise(r => setTimeout(r, 10));
    await saveMemory('第二条', 'long_term');
    await new Promise(r => setTimeout(r, 10));
    await saveMemory('第三条', 'project');

    const all = await getMemories();
    assert.equal(all.length, 3);
    // 倒序：最新的在前
    assert.equal(all[0].content, '第三条');
    assert.equal(all[1].content, '第二条');
    assert.equal(all[2].content, '第一条');
  });

  it('memory.json 文件不被运行时创建/写入', async () => {
    const memoryJsonPath = join(testDir, 'memory.json');
    // 确保测试前文件不存在
    if (existsSync(memoryJsonPath)) {
      rmSync(memoryJsonPath);
    }

    await saveMemory('测试无 JSON 落盘', 'short_term');
    await getMemories();
    await updateMemory((await getMemories())[0].id, { content: '更新' });
    await deleteMemory((await getMemories())[0].id);

    // 验证 memory.json 未被创建
    assert.equal(existsSync(memoryJsonPath), false, 'memory.json 不应被运行时创建');
  });

  it('新列 scope/importance/lastUsedAt/expiresAt 在 DB 中存在', async () => {
    // 通过 raw sql.js 查询表结构（只读 schema，不涉及数据同步问题）
    const SQL = await initSqlJs();
    const buffer = readFileSync(testDbPath);
    const db = new SQL.Database(buffer);

    const cols = db.exec("PRAGMA table_info(memories)");
    const colNames = cols[0].values.map((row: unknown[]) => String(row[1]));

    assert.ok(colNames.includes('scope'), '应有 scope 列');
    assert.ok(colNames.includes('importance'), '应有 importance 列');
    assert.ok(colNames.includes('last_used_at'), '应有 last_used_at 列');
    assert.ok(colNames.includes('expires_at'), '应有 expires_at 列');

    db.close();
  });

  it('saveMemory 写入时包含新列的默认值', async () => {
    await saveMemory('测试新列默认值', 'long_term');

    // 通过 Drizzle 直接查询原始行，验证新列默认值
    const db = getDb();
    const rows = db.select({
      scope: memories.scope,
      importance: memories.importance,
      lastUsedAt: memories.lastUsedAt,
      expiresAt: memories.expiresAt,
    }).from(memories).where(eq(memories.content, '测试新列默认值')).all();

    assert.equal(rows.length, 1);
    const row = rows[0];
    assert.equal(row.scope, 'user', 'scope 默认应为 user');
    assert.equal(row.importance, 0.5, 'importance 默认应为 0.5');
    assert.equal(row.lastUsedAt, null, 'last_used_at 默认应为 null');
    assert.equal(row.expiresAt, null, 'expires_at 默认应为 null');
  });
});