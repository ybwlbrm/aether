import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { BackendConfig } from '../config/index.js';

/** 原子写库（tmp + rename + fsync），防止中途强杀导致主库损坏 */
function atomicWrite(path: string, buffer: Buffer): void {
  const tmpPath = join(path, '..', `pacc.db.tmp.${randomBytes(8).toString('hex')}`);
  try {
    const fd = openSync(tmpPath, 'w');
    writeFileSync(fd, buffer);
    try { fsyncSync(fd); } catch { /* fsync best-effort */ }
    closeSync(fd);
    renameSync(tmpPath, path);
  } catch (e) {
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch (_e: unknown) { /* ignore - intentional */ }
    // 非原子回退：至少不丢数据
    writeFileSync(path, buffer);
  }
}

/** 打开数据库，若损坏则备份坏库并重建空库，避免启动崩溃黑屏 */
function openDatabase(SQL: Awaited<ReturnType<typeof initSqlJs>>, dbPath: string): any {
  if (!existsSync(dbPath)) {
    return new SQL.Database();
  }

  let db: any;
  try {
    const buffer = readFileSync(dbPath);
    db = new SQL.Database(buffer);
    // 触发懒解析，立即暴露损坏（损坏库在第一条 SQL 时才抛 "file is not a database"）
    db.exec('SELECT name FROM sqlite_master LIMIT 1');
    return db;
  } catch (e) {
    // 备份坏库，避免用户数据被直接覆盖（后续可手动找回）
    try {
      const bakPath = `${dbPath}.corrupt.${Date.now()}`;
      renameSync(dbPath, bakPath);
      console.error(`[DB] 检测到损坏的数据库，已备份到 ${bakPath}，重建新库。原因: ${(e as Error).message}`);
    } catch (_e: unknown) {
      console.error('[DB] 损坏库备份失败，直接重建');
    }
    return new SQL.Database();
  }
}

/** 创建所有表 */
export async function runMigrations(config: BackendConfig): Promise<void> {
  const SQL = await initSqlJs();
  const db = openDatabase(SQL, config.dbPath);

  db.run('PRAGMA foreign_keys = ON');

  const createTables = `
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, type TEXT NOT NULL,
      api_key TEXT NOT NULL, base_url TEXT, models TEXT NOT NULL,
      capabilities TEXT NOT NULL DEFAULT '["text"]',
      is_default INTEGER DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '新对话',
      provider_id TEXT NOT NULL REFERENCES providers(id),
      model TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id),
      role TEXT NOT NULL, content TEXT NOT NULL,
      tool_calls TEXT, tool_results TEXT, created_at TEXT NOT NULL
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
  `;

  db.run(createTables);

  // P2-6: schema 版本表 — 追踪迁移状态，支持增量迁移
  db.run(`CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`);
  const versionResult = db.exec('SELECT MAX(version) FROM schema_version');
  const currentVersion = versionResult.length > 0 && versionResult[0].values[0][0] !== null
    ? versionResult[0].values[0][0] as number
    : 0;

  // 版本 1: baseline（所有 CREATE TABLE 已在上面执行）
  if (currentVersion < 1) {
    db.run(`INSERT INTO schema_version (version, applied_at) VALUES (1, ?)`, [new Date().toISOString()]);
  }

  // 版本 2: 向后兼容 — 为旧库补充 capabilities 列
  if (currentVersion < 2) {
    const providerCols = db.exec('PRAGMA table_info(providers)');
    const hasCapabilities = providerCols.length > 0
      && providerCols[0].values.some((row: unknown[]) => row[1] === 'capabilities');
    if (!hasCapabilities) {
      db.run('ALTER TABLE providers ADD COLUMN capabilities TEXT NOT NULL DEFAULT \'["text"]\'');
    }
    db.run(`INSERT INTO schema_version (version, applied_at) VALUES (2, ?)`, [new Date().toISOString()]);
  }

  // 版本 3: 搜索历史表
  if (currentVersion < 3) {
    db.run(`CREATE TABLE IF NOT EXISTS search_history (
      id TEXT PRIMARY KEY, query TEXT NOT NULL,
      sources TEXT NOT NULL DEFAULT '["duckduckgo"]',
      result_count INTEGER DEFAULT 0, created_at TEXT NOT NULL
    )`);
    db.run(`INSERT INTO schema_version (version, applied_at) VALUES (3, ?)`, [new Date().toISOString()]);
  }

  // 版本 4: 工作流表 + 工作流运行记录表
  if (currentVersion < 4) {
    db.run(`CREATE TABLE IF NOT EXISTS workflows (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '',
      nodes TEXT NOT NULL DEFAULT '[]', edges TEXT NOT NULL DEFAULT '[]',
      trigger TEXT NOT NULL DEFAULT 'manual',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS workflow_runs (
      id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflows(id),
      status TEXT NOT NULL DEFAULT 'pending', current_node_id TEXT,
      results TEXT DEFAULT '{}', error TEXT,
      started_at TEXT NOT NULL, completed_at TEXT
    )`);
    db.run(`INSERT INTO schema_version (version, applied_at) VALUES (4, ?)`, [new Date().toISOString()]);
  }

  // 版本 5: 知识库页面表 + 提示词模板表
  if (currentVersion < 5) {
    db.run(`CREATE TABLE IF NOT EXISTS wiki_pages (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '',
      category TEXT NOT NULL DEFAULT '通用',
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS prompt_templates (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, content TEXT NOT NULL,
      created_at TEXT NOT NULL
    )`);
    db.run(`INSERT INTO schema_version (version, applied_at) VALUES (5, ?)`, [new Date().toISOString()]);
  }

  // 版本 6: 会话持久化 — conversations 表增加 generation_status 和 generation_state 列
  if (currentVersion < 6) {
    const convCols = db.exec('PRAGMA table_info(conversations)');
    const hasStatus = convCols.length > 0
      && convCols[0].values.some((row: unknown[]) => row[1] === 'generation_status');
    if (!hasStatus) {
      db.run("ALTER TABLE conversations ADD COLUMN generation_status TEXT NOT NULL DEFAULT 'idle'");
      db.run("ALTER TABLE conversations ADD COLUMN generation_state TEXT");
    }
    db.run(`INSERT INTO schema_version (version, applied_at) VALUES (6, ?)`, [new Date().toISOString()]);
  }

  // 版本 7: Agent Activity Event 表 — Event-driven Activity Stream 的事件日志
  // （对应 db/schema/index.ts 的 activityEvents 定义）
  if (currentVersion < 7) {
    db.run(`CREATE TABLE IF NOT EXISTS activity_events (
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
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_activity_events_conv_seq ON activity_events(conversation_id, seq)`);
    db.run(`INSERT INTO schema_version (version, applied_at) VALUES (7, ?)`, [new Date().toISOString()]);
  }

  // 版本 8: messages 表增加 reasoning_content 列（thinking 模式回传持久化）
  if (currentVersion < 8) {
    const msgCols = db.exec('PRAGMA table_info(messages)');
    const hasReasoning = msgCols.length > 0
      && msgCols[0].values.some((row: unknown[]) => row[1] === 'reasoning_content');
    if (!hasReasoning) {
      db.run('ALTER TABLE messages ADD COLUMN reasoning_content TEXT');
    }
    db.run(`INSERT INTO schema_version (version, applied_at) VALUES (8, ?)`, [new Date().toISOString()]);
  }

  // 版本 9: conversations 表增加 tokenTotal 列 + 回填历史数据
  // PF-01: 避免会话列表/详情的 N+1 全表扫描聚合
  if (currentVersion < 9) {
    const convCols = db.exec('PRAGMA table_info(conversations)');
    const hasTokenTotal = convCols.length > 0
      && convCols[0].values.some((row: unknown[]) => row[1] === 'token_total');
    if (!hasTokenTotal) {
      db.run('ALTER TABLE conversations ADD COLUMN token_total INTEGER NOT NULL DEFAULT 0');
    }
    // 回填：从现有 assistant 消息的 toolResults 中提取 total_tokens 汇总到 conversations.token_total
    // 逻辑与原 GET /api/conversations 聚合一致：解析 toolResults JSON，累加 total_tokens
    db.exec(`
      UPDATE conversations
      SET token_total = (
        SELECT COALESCE(SUM(
          CASE
            WHEN json_valid(m.tool_results) AND json_type(m.tool_results) = 'object'
            THEN CAST(json_extract(m.tool_results, '$.total_tokens') AS INTEGER)
            ELSE 0
          END
        ), 0)
        FROM messages m
        WHERE m.conversation_id = conversations.id
          AND m.role = 'assistant'
          AND m.tool_results IS NOT NULL
      )
    `);
    db.run(`INSERT INTO schema_version (version, applied_at) VALUES (9, ?)`, [new Date().toISOString()]);
  }

  // 保存到文件（原子写，防止强杀损坏主库）
  const data = db.export();
  const buffer = Buffer.from(data);
  atomicWrite(config.dbPath, buffer);

  db.close();
}