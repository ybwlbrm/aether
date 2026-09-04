import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import initSqlJs from 'sql.js';
// import type { BackendConfig } from '../config/index.js';

/** 用内存 sql.js DB 直接执行迁移 SQL（复用 migrate.ts 的可迁移片段，最小化外部依赖） */
const MIGRATION_SQL = `
CREATE TABLE IF NOT EXISTS providers (id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL, api_key TEXT NOT NULL, base_url TEXT, models TEXT NOT NULL, capabilities TEXT NOT NULL DEFAULT '["text"]', is_default INTEGER DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '新对话', provider_id TEXT NOT NULL, model TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, tool_calls TEXT, tool_results TEXT, created_at TEXT NOT NULL);
`;

describe('runMigrations — reasoning_content 列迁移', () => {
  let SQL: Awaited<ReturnType<typeof initSqlJs>>;

  before(async () => {
    SQL = await initSqlJs();
  });

  function applyMigrationLikeSql(db: any, reasoningAlreadyExists: boolean): void {
    // 模拟 migrate.ts 版本 8 的逻辑：PRAGMA 检查 + ALTER ADD COLUMN
    if (!reasoningAlreadyExists) {
      const cols = db.exec('PRAGMA table_info(messages)');
      const has = cols.length > 0 && cols[0].values.some((r: unknown[]) => r[1] === 'reasoning_content');
      if (!has) {
        db.run('ALTER TABLE messages ADD COLUMN reasoning_content TEXT');
      }
    } else {
      // 已经存在的库：什么都不做（幂等）
      const cols = db.exec('PRAGMA table_info(messages)');
      const has = cols.length > 0 && cols[0].values.some((r: unknown[]) => r[1] === 'reasoning_content');
      assert.ok(has, 'pre-existing DB should already have the column');
    }
  }

  it('旧库（无列）迁移后获得 reasoning_content 列且可写入', () => {
    const db = new SQL.Database();
    db.run('PRAGMA foreign_keys = ON');
    db.run(MIGRATION_SQL);
    applyMigrationLikeSql(db, false);
    db.run("INSERT INTO messages (id, conversation_id, role, content, reasoning_content, created_at) VALUES ('m1', 'c1', 'assistant', 'hello', '思考过程', '2026-08-25T00:00:00Z')");
    const rows = db.exec('SELECT reasoning_content FROM messages WHERE id = \'m1\'');
    assert.equal(rows[0].values[0][0], '思考过程');
    db.close();
  });

  it('新库（已有列）迁移幂等，不起冲突', () => {
    const db = new SQL.Database();
    db.run(MIGRATION_SQL);
    db.run('ALTER TABLE messages ADD COLUMN reasoning_content TEXT');
    applyMigrationLikeSql(db, true); // 幂等：不重复 ADD
    db.close();
  });

  it('真实 migrate.ts 入口能跑通（用临时目录 DB）', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pacc-migrate-'));
    const dbPath = join(dir, 'pacc.db');
    try {
      const config: Record<string, unknown> = {
        encryptionKey: 'test-key-12345678901234567890123456789012',
        dbPath,
        dataDir: dir,
        allowedDirs: [dir],
      };
      const { runMigrations } = await import('../db/migrate.js');
      await runMigrations(config as never);
      assert.ok(existsSync(dbPath), 'DB file should be created');
      // 再次运行应幂等成功（旧库兼容路径）
      const config2: Record<string, unknown> = { ...config, dbPath: resolve(dir, 'pacc.db') };
      await runMigrations(config2 as never);
      // 用 sql.js 打开验证列存在
      const buffer = readFileSync(dbPath);
      const db = new SQL.Database(buffer);
      const cols = db.exec('PRAGMA table_info(messages)');
      const has = cols[0].values.some((r: unknown[]) => r[1] === 'reasoning_content');
      assert.ok(has, 'messages should have reasoning_content after migration');
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});