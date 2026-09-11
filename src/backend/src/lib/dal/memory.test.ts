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

  // ── P1-19：中文关键词提取（split(/\s+/) 对无空格中文失效）──

  it('P1-19: extractKeywords 对中文整句拆出多元关键词（非单一大词）', async () => {
    const { extractKeywords } = await import('./active-memories.js');
    const kws = extractKeywords('帮我继续完成上次那个济南项目');
    // 中文整句应拆出多个 ≥2 字关键词（bigram/trigram），而非整个句子一个词
    assert.ok(Array.isArray(kws) && kws.length > 1, `应拆出多个关键词，实际: ${JSON.stringify(kws)}`);
    // 应包含项目相关片段（济南/项目）
    const joined = kws.join('');
    assert.ok(joined.includes('济南') || joined.includes('项目'), `应包含项目实体字词，实际: ${JSON.stringify(kws)}`);
    assert.ok(kws.every(w => typeof w === 'string' && w.length >= 2), '每个关键词应 ≥2 字');
    assert.ok(kws.length <= 8, '关键词上限 8 个');
  });

  it('P1-19: extractKeywords 英文/数字词正常切分', async () => {
    const { extractKeywords } = await import('./active-memories.js');
    const kws = extractKeywords('帮我看看 React useState hook 的用法');
    assert.ok(kws.includes('react'), `应包含小写英文词 react，实际: ${JSON.stringify(kws)}`);
    assert.ok(kws.includes('usestate'), `应包含 usestate，实际: ${JSON.stringify(kws)}`);
  });

  it('P1-19: getActiveMemoriesFormatted 用中文关键词召回相关记忆', async () => {
    const { getActiveMemoriesFormatted } = await import('./active-memories.js');
    // 先保存两条记忆
    await saveMemory('济南项目需要明天交付,重点是数据迁移', 'project');
    await saveMemory('今天天气很好适合出去走走', 'short_term');
    // 用中文整句查询（无空格）——旧实现整句单关键词会召回不到济南项目
    const formatted = await getActiveMemoriesFormatted('济南项目的进度如何了');
    assert.ok(formatted.includes('济南项目'), `中文关键词应召回相关记忆，实际输出: ${formatted.slice(0, 200)}`);
  });

  // ── P1-16：查询条件 AND 语义（scope AND type AND content）──

  it('P1-16: SqliteMemoryStore.query 条件为 AND（scope+type 同时过滤）', async () => {
    const { SqliteMemoryStore } = await import('../../lib/memory-runtime-bridge.js');
    const store = new SqliteMemoryStore();
    await saveMemory('scope user project pak', 'project');
    await saveMemory('scope user short pak', 'short_term');
    // 同时限定 scope=user + type=project —— 只应返回 project 那条
    const results = await store.query({ scope: 'user', type: 'project' } as never);
    assert.ok(results.length === 1, `AND 语义应只命中 1 条，实际 ${results.length}（OR 会返回 2）`);
    assert.equal(results[0].content, 'scope user project pak');
  });

  // ── P1-17：expiresAt 过期记忆不参与召回 ──

  it('P1-17: SqliteMemoryStore.query 过滤已过期记忆（expiresAt 过去）', async () => {
    const { SqliteMemoryStore } = await import('../../lib/memory-runtime-bridge.js');
    const store = new SqliteMemoryStore();
    await saveMemory('有效记忆内容alpha', 'long_term');
    // 直接插入一条已过期记忆
    const db = getDb();
    const now = new Date().toISOString();
    db.insert(memories).values({
      id: 'expired-mem-1',
      type: 'long_term',
      key: '过期记忆内容beta',
      content: '过期记忆内容beta',
      tags: '[]',
      scope: 'user',
      importance: 0.9,
      expiresAt: new Date(Date.now() - 1000).toISOString(), // 已过期
      createdAt: now,
      updatedAt: now,
    }).run();

    const results = await store.query({} as never);
    assert.ok(!results.some(r => r.id === 'expired-mem-1'), '过期记忆不应被召回');
    assert.ok(results.some(r => r.content.includes('alpha')), '有效记忆应被召回');
  });

  it('P1-17: getActiveMemoriesFormatted 不包含已过期记忆', async () => {
    const { getActiveMemoriesFormatted } = await import('./active-memories.js');
    const db = getDb();
    const now = new Date().toISOString();
    db.insert(memories).values({
      id: 'expired-mem-2',
      type: 'long_term',
      key: '过期记忆内容gamma',
      content: '过期记忆内容gamma',
      tags: '[]',
      scope: 'user',
      importance: 0.9,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
      createdAt: now,
      updatedAt: now,
    }).run();
    const formatted = await getActiveMemoriesFormatted('gamma 记忆');
    assert.ok(!formatted.includes('gamma'), '过期记忆不得进入格式化召回输出');
  });
});