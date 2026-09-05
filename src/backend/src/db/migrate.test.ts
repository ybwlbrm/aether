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

/** v1..v9 迁移 SQL 片段（用于构造已迁移到 v9 的旧库） */
const V1_TO_V9_SQL = `
CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS providers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
  api_key TEXT NOT NULL, base_url TEXT, models TEXT NOT NULL,
  capabilities TEXT NOT NULL DEFAULT '["text"]',
  is_default INTEGER DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversations (
  id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '新对话',
  provider_id TEXT NOT NULL REFERENCES providers(id),
  model TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  generation_status TEXT NOT NULL DEFAULT 'idle',
  generation_state TEXT,
  token_total INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
  role TEXT NOT NULL, content TEXT NOT NULL,
  tool_calls TEXT, tool_results TEXT, reasoning_content TEXT, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
  cover TEXT, screenshots TEXT DEFAULT '[]', tech_stack TEXT DEFAULT '[]',
  links TEXT DEFAULT '[]', github TEXT,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS versions (
  id TEXT PRIMARY KEY, entity_type TEXT NOT NULL, entity_id TEXT NOT NULL,
  version INTEGER NOT NULL, snapshot TEXT NOT NULL, message TEXT DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, key TEXT NOT NULL,
  content TEXT NOT NULL, tags TEXT DEFAULT '[]',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS media_assets (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL,
  path TEXT NOT NULL, mime_type TEXT NOT NULL, size INTEGER NOT NULL,
  metadata TEXT DEFAULT '{}', created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY, type TEXT NOT NULL, name TEXT NOT NULL,
  path TEXT, status TEXT DEFAULT 'draft',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS agent_configs (
  id TEXT PRIMARY KEY, agent_id TEXT NOT NULL UNIQUE,
  provider_id TEXT NOT NULL, model TEXT NOT NULL,
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS mcp_servers (
  id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL DEFAULT 'local', command TEXT,
  cwd TEXT, environment TEXT, url TEXT,
  enabled INTEGER NOT NULL DEFAULT 1, timeout INTEGER DEFAULT 5000,
  headers TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS search_history (
  id TEXT PRIMARY KEY, query TEXT NOT NULL,
  sources TEXT NOT NULL DEFAULT '["duckduckgo"]',
  result_count INTEGER DEFAULT 0, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workflows (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
  nodes TEXT NOT NULL DEFAULT '[]', edges TEXT NOT NULL DEFAULT '[]',
  trigger TEXT NOT NULL DEFAULT 'manual',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS workflow_runs (
  id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflows(id),
  status TEXT NOT NULL DEFAULT 'pending', current_node_id TEXT,
  results TEXT DEFAULT '{}', error TEXT,
  started_at TEXT NOT NULL, completed_at TEXT
);
CREATE TABLE IF NOT EXISTS wiki_pages (
  id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT '通用',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS prompt_templates (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, content TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS activity_events (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  task_id TEXT NOT NULL,
  agent_id TEXT NOT NULL DEFAULT 'main',
  agent_type TEXT NOT NULL DEFAULT 'conversation',
  event_type TEXT NOT NULL,
  seq INTEGER NOT NULL,
  status TEXT,
  content TEXT,
  tool TEXT,
  parent_event_id TEXT,
  metadata TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_activity_events_conv_seq ON activity_events(conversation_id, seq);
`;

describe('runMigrations — v10/v11/v12 (Aether 2.0 Runtime tables)', () => {
  let SQL: Awaited<ReturnType<typeof initSqlJs>>;

  before(async () => {
    SQL = await initSqlJs();
  });

  function makeConfig(dbPath: string, dir: string): Record<string, unknown> {
    return {
      encryptionKey: 'test-key-12345678901234567890123456789012',
      dbPath,
      dataDir: dir,
      allowedDirs: [dir],
    };
  }

  async function runMigrationsReal(config: Record<string, unknown>): Promise<void> {
    const { runMigrations } = await import('../db/migrate.js');
    await runMigrations(config as never);
  }

  function openDb(dbPath: string): any {
    const buffer = readFileSync(dbPath);
    return new SQL.Database(buffer);
  }

  it('FRESH DB: v10/v11/v12 apply cleanly on brand-new DB', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pacc-migrate-fresh-'));
    const dbPath = join(dir, 'pacc.db');
    try {
      await runMigrationsReal(makeConfig(dbPath, dir));

      const db = openDb(dbPath);
      // schema_version 最大值应为 12
      const ver = db.exec('SELECT MAX(version) FROM schema_version');
      assert.equal(ver[0].values[0][0], 12, 'schema_version should be 12');

      // 三张新表存在
      const tables = db.exec("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('runs','tasks','events')");
      const tableNames = tables[0].values.map((r: unknown[]) => r[0]).sort();
      assert.deepEqual(tableNames, ['events', 'runs', 'tasks']);

      // runs 表可写入/读取
      db.run("INSERT INTO runs (id, conversation_id, status, mode, created_at) VALUES ('run-1', 'conv-1', 'created', 'normal', '2026-01-01T00:00:00Z')");
      const runRow = db.exec("SELECT id, status, mode FROM runs WHERE id = 'run-1'");
      assert.equal(runRow[0].values[0][0], 'run-1');
      assert.equal(runRow[0].values[0][1], 'created');
      assert.equal(runRow[0].values[0][2], 'normal');

      // tasks 表可写入/读取（引用 runs）
      db.run("INSERT INTO tasks (id, run_id, agent_id, status, created_at) VALUES ('task-1', 'run-1', 'main', 'pending', '2026-01-01T00:00:00Z')");
      const taskRow = db.exec("SELECT id, run_id, status FROM tasks WHERE id = 'task-1'");
      assert.equal(taskRow[0].values[0][0], 'task-1');
      assert.equal(taskRow[0].values[0][1], 'run-1');
      assert.equal(taskRow[0].values[0][2], 'pending');

      // events 表可写入/读取
      db.run("INSERT INTO events (id, run_id, seq, event_type, payload, created_at) VALUES ('evt-1', 'run-1', 1, 'agent_start', '{}', '2026-01-01T00:00:00Z')");
      const evtRow = db.exec("SELECT id, run_id, seq, event_type FROM events WHERE id = 'evt-1'");
      assert.equal(evtRow[0].values[0][0], 'evt-1');
      assert.equal(evtRow[0].values[0][1], 'run-1');
      assert.equal(evtRow[0].values[0][2], 1);
      assert.equal(evtRow[0].values[0][3], 'agent_start');

      // idx_events_run_seq 唯一索引存在
      const indexes = db.exec("SELECT name FROM sqlite_master WHERE type='index' AND name = 'idx_events_run_seq'");
      assert.ok(indexes.length > 0 && indexes[0].values.length > 0, 'idx_events_run_seq should exist');

      // idx_tasks_run_id 和 idx_tasks_parent 索引存在
      const idxTasksRun = db.exec("SELECT name FROM sqlite_master WHERE type='index' AND name = 'idx_tasks_run_id'");
      assert.ok(idxTasksRun.length > 0 && idxTasksRun[0].values.length > 0, 'idx_tasks_run_id should exist');
      const idxTasksParent = db.exec("SELECT name FROM sqlite_master WHERE type='index' AND name = 'idx_tasks_parent'");
      assert.ok(idxTasksParent.length > 0 && idxTasksParent[0].values.length > 0, 'idx_tasks_parent should exist');

      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('UPGRADE DB: v10/v11/v12 apply on existing v9 DB with data intact', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pacc-migrate-upgrade-'));
    const dbPath = join(dir, 'pacc.db');
    try {
      // 先建一个 v9 状态的库（含数据）
      const db = new SQL.Database();
      db.run('PRAGMA foreign_keys = ON');
      db.run(V1_TO_V9_SQL);
      // 插入 schema_version 1..9
      for (let v = 1; v <= 9; v++) {
        db.run('INSERT INTO schema_version (version, applied_at) VALUES (?, ?)', [v, '2026-01-01T00:00:00Z']);
      }
      // 插入测试数据：provider, conversation, message with reasoning_content
      db.run("INSERT INTO providers (id, name, type, api_key, models, created_at, updated_at) VALUES ('prov-1', 'Test Provider', 'openai', 'sk-test', '[]', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')");
      db.run("INSERT INTO conversations (id, title, provider_id, model, created_at, updated_at, generation_status, token_total) VALUES ('conv-1', 'Test Conversation', 'prov-1', 'gpt-4', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'idle', 100)");
      db.run("INSERT INTO messages (id, conversation_id, role, content, reasoning_content, created_at) VALUES ('msg-1', 'conv-1', 'assistant', 'Hello', 'thinking...', '2026-01-01T00:00:00Z')");
      // 写入文件
      const buffer = Buffer.from(db.export());
      writeFileSync(dbPath, buffer);
      db.close();

      // 运行真实迁移
      await runMigrationsReal(makeConfig(dbPath, dir));

      // 验证：schema_version 达到 12
      const db2 = openDb(dbPath);
      const ver = db2.exec('SELECT MAX(version) FROM schema_version');
      assert.equal(ver[0].values[0][0], 12, 'schema_version should be 12 after upgrade');

      // 预存数据完好
      const prov = db2.exec("SELECT id, name FROM providers WHERE id = 'prov-1'");
      assert.equal(prov[0].values[0][0], 'prov-1');
      assert.equal(prov[0].values[0][1], 'Test Provider');

      const conv = db2.exec("SELECT id, title, token_total FROM conversations WHERE id = 'conv-1'");
      assert.equal(conv[0].values[0][0], 'conv-1');
      assert.equal(conv[0].values[0][1], 'Test Conversation');
      assert.equal(conv[0].values[0][2], 100);

      const msg = db2.exec("SELECT id, reasoning_content FROM messages WHERE id = 'msg-1'");
      assert.equal(msg[0].values[0][0], 'msg-1');
      assert.equal(msg[0].values[0][1], 'thinking...');

      // 新表已创建且可用
      const tables = db2.exec("SELECT name FROM sqlite_master WHERE type='table' AND name IN ('runs','tasks','events')");
      const tableNames = tables[0].values.map((r: unknown[]) => r[0]).sort();
      assert.deepEqual(tableNames, ['events', 'runs', 'tasks']);

      // 新表可写入
      db2.run("INSERT INTO runs (id, conversation_id, status, mode, created_at) VALUES ('run-upgrade', 'conv-1', 'running', 'super', '2026-01-01T00:00:00Z')");
      db2.run("INSERT INTO tasks (id, run_id, agent_id, status, created_at) VALUES ('task-upgrade', 'run-upgrade', 'worker', 'running', '2026-01-01T00:00:00Z')");
      db2.run("INSERT INTO events (id, run_id, seq, event_type, payload, created_at) VALUES ('evt-upgrade', 'run-upgrade', 1, 'task_start', '{}', '2026-01-01T00:00:00Z')");

      const runCheck = db2.exec("SELECT id FROM runs WHERE id = 'run-upgrade'");
      assert.equal(runCheck[0].values[0][0], 'run-upgrade');

      db2.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('UNIQUE(run_id, seq) enforcement: duplicate seq for same run_id throws', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pacc-migrate-unique-'));
    const dbPath = join(dir, 'pacc.db');
    try {
      await runMigrationsReal(makeConfig(dbPath, dir));

      const db = openDb(dbPath);
      // 第一次插入成功
      db.run("INSERT INTO events (id, run_id, seq, event_type, payload, created_at) VALUES ('evt-1', 'run-1', 1, 'agent_start', '{}', '2026-01-01T00:00:00Z')");
      // 第二次插入相同 run_id + seq 应抛出
      assert.throws(() => {
        db.run("INSERT INTO events (id, run_id, seq, event_type, payload, created_at) VALUES ('evt-2', 'run-1', 1, 'agent_end', '{}', '2026-01-01T00:00:00Z')");
      }, /UNIQUE constraint failed/);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('Idempotency: running runMigrations twice on same DB succeeds', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pacc-migrate-idempotent-'));
    const dbPath = join(dir, 'pacc.db');
    try {
      await runMigrationsReal(makeConfig(dbPath, dir));
      // 第二次运行不应报错
      await runMigrationsReal(makeConfig(dbPath, dir));

      const db = openDb(dbPath);
      const ver = db.exec('SELECT MAX(version) FROM schema_version');
      assert.equal(ver[0].values[0][0], 12, 'schema_version should still be 12 after second run');
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});