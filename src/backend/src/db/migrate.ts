// allow: SIZE_OK — the migration ledger is intentionally sequential and atomic.
import initSqlJs from 'sql.js';
import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync, openSync, closeSync, fsyncSync, copyFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { BackendConfig } from '../config/index.js';

type SqlPrimitive = string | number | null | Uint8Array
type SqlQueryResult = {
  readonly values: SqlPrimitive[][]
}
type SqlJsDatabase = {
  run(sql: string, params?: readonly SqlPrimitive[]): void
  exec(sql: string): SqlQueryResult[]
  export(): Uint8Array
  close(): void
}
type SqlJsApi = {
  readonly Database: new (data?: Uint8Array) => SqlJsDatabase
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function columnNames(db: SqlJsDatabase, table: string): Set<string> {
  const result = db.exec(`PRAGMA table_info(${table})`)
  const values: unknown = result[0]?.values ?? []
  if (!Array.isArray(values)) return new Set()

  const names: string[] = []
  for (const row of values) {
    if (Array.isArray(row) && row.length > 1) {
      names.push(String(row[1]))
    }
  }
  return new Set(names)
}

function hasColumn(db: SqlJsDatabase, table: string, column: string): boolean {
  return columnNames(db, table).has(column)
}

/** 原子写库（tmp + rename + fsync），防止中途强杀导致主库损坏 */
function atomicWrite(path: string, buffer: Buffer): void {
  const tmpPath = join(path, '..', `pacc.db.tmp.${randomBytes(8).toString('hex')}`);
  try {
    const fd = openSync(tmpPath, 'w');
    writeFileSync(fd, buffer);
    try { fsyncSync(fd) } catch { // no-excuse-ok: catch
      // fsync is best-effort on platforms that reject directory-backed descriptors
    }
    closeSync(fd);
    renameSync(tmpPath, path);
  } catch (error: unknown) {
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath) } catch (cleanupError: unknown) { // no-excuse-ok: catch
      void cleanupError
    }
    // 非原子回退：至少不丢数据
    const reason = error instanceof Error ? error.message : String(error)
    console.warn(`[DB] 原子写入失败，回退直接写入: ${reason}`)
    writeFileSync(path, buffer)
  }
}

/** 打开数据库，若损坏则备份坏库并重建空库，避免启动崩溃黑屏 */
function openDatabase(SQL: SqlJsApi, dbPath: string): SqlJsDatabase {
  if (!existsSync(dbPath)) {
    return new SQL.Database();
  }

  let db: SqlJsDatabase
  try {
    const buffer = readFileSync(dbPath);
    db = new SQL.Database(buffer);
    // 触发懒解析，立即暴露损坏（损坏库在第一条 SQL 时才抛 "file is not a database"）
    db.exec('SELECT name FROM sqlite_master LIMIT 1');
    return db;
  } catch (error: unknown) {
    // 备份坏库，避免用户数据被直接覆盖（后续可手动找回）
    try {
      const bakPath = `${dbPath}.corrupt.${Date.now()}`
      renameSync(dbPath, bakPath)
      console.error(`[DB] 检测到损坏的数据库，已备份到 ${bakPath}，重建新库。原因: ${error instanceof Error ? error.message : String(error)}`)
    } catch (backupError: unknown) { // no-excuse-ok: catch
      console.error(`[DB] 损坏库备份失败，直接重建: ${errorMessage(backupError)}`)
    }
    return new SQL.Database()
  }
}

/**
 * 整改计划第 7 章（P1）：启动时完整性校验。
 * PRAGMA integrity_check 返回 'ok' 表示完整；非 'ok' 视为损坏，备份并重建。
 */
function verifyIntegrity(db: SqlJsDatabase, dbPath: string, SQL: SqlJsApi): SqlJsDatabase {
  try {
    const res = db.exec('PRAGMA integrity_check');
    const status = res.length > 0 && res[0].values.length > 0 ? String(res[0].values[0][0]) : 'ok';
    if (status === 'ok') return db;
    console.error(`[DB] integrity_check 异常: ${status} — 备份损坏库并重建`);
    try {
      const bakPath = `${dbPath}.corrupt.${Date.now()}`;
      renameSync(dbPath, bakPath);
      console.error(`[DB] 已备份到 ${bakPath}`);
    } catch (error: unknown) { // no-excuse-ok: catch
      console.error('[DB] 损坏库备份失败，直接重建');
    }
    return new SQL.Database();
  } catch {
    // integrity_check 本身执行失败 → 视为损坏
    try {
      const bakPath = `${dbPath}.corrupt.${Date.now()}`;
      renameSync(dbPath, bakPath);
      console.error(`[DB] integrity_check 执行失败，已备份到 ${bakPath}`);
    } catch (error: unknown) { // no-excuse-ok: catch
      /* ignore */
    }
    return new SQL.Database();
  }
}

/**
 * 整改计划第 7 章（P1）：迁移前创建 .bak 快照（rename 后 fsync 目录语义尽力而为）。
 * 迁移失败时可从 .bak 恢复。仅在源库存在时创建，且不覆盖已有 .bak。
 */
function backupBeforeMigration(dbPath: string): string | null {
  if (!existsSync(dbPath)) return null;
  const bakPath = `${dbPath}.bak`;
  if (existsSync(bakPath)) return null; // 已有备份则不覆盖（保留上一次成功态）
  try {
    copyFileSync(dbPath, bakPath);
    return bakPath;
  } catch {
    return null;
  }
}

/**
 * P0-21: SQLite cannot alter a FK constraint in place, so the table must be
 * rebuilt. Copies every existing column (projected by name, tolerant of older
 * DBs missing columns), then swaps the new table in.
 * 整改计划第 7 章：rebuildTable 包在事务中执行 —— 任一语句失败，外层 ROLLBACK 回滚。
 */
function rebuildTable(db: SqlJsDatabase, table: string, createSql: string): void {
  const existingColumns = [...columnNames(db, table)]
  const temp = `${table}__p021`;
  db.run(`DROP TABLE IF EXISTS ${temp}`);
  db.run(createSql.replace(`CREATE TABLE ${table}`, `CREATE TABLE ${temp}`));
  if (existingColumns.length > 0) {
    const cols = existingColumns.join(', ');
    db.run(`INSERT INTO ${temp} (${cols}) SELECT ${cols} FROM ${table}`);
  }
  db.run(`DROP TABLE ${table}`);
  db.run(`ALTER TABLE ${temp} RENAME TO ${table}`);
}

/** 创建所有表 */
export async function runMigrations(config: BackendConfig): Promise<void> {
  const SQL: SqlJsApi = await initSqlJs()
  let db = openDatabase(SQL, config.dbPath);

  db.run('PRAGMA foreign_keys = ON');
  // 整改计划第 7 章（P1）：启动完整性校验 —— 迁移前先确认库未损坏
  db = verifyIntegrity(db, config.dbPath, SQL);

  // 整改计划第 7 章（P1）：迁移前 .bak 快照（迁移失败可从备份恢复）
  const bakPath = backupBeforeMigration(config.dbPath);

  // 整改计划第 7 章（P1）：所有迁移包在单事务中 —— 任一版本失败整体回滚，
  // 不留下"部分迁移"的中间状态（rebuildTable 的 DROP/INSERT/ALTER 同样受保护）。
  // 注意：SQLite 不允许在事务内修改 PRAGMA foreign_keys（no-op），
  // 因此 v13 表重建期间需要的 FK 关闭在 BEGIN 之前全局执行，迁移结束后恢复。
  const fkOnBefore = Number(db.exec('PRAGMA foreign_keys')[0].values[0][0]) === 1
  db.run('PRAGMA foreign_keys = OFF');
  try {
    db.run('BEGIN TRANSACTION');

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
    ? Number(versionResult[0].values[0][0])
    : 0

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

  // 版本 10: runs 表 — Aether 2.0 运行根实体
  if (currentVersion < 10) {
    db.run(`CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      conversation_id TEXT REFERENCES conversations(id),
      status TEXT NOT NULL DEFAULT 'created',
      mode TEXT NOT NULL DEFAULT 'normal',
      root_agent_id TEXT,
      started_at TEXT,
      completed_at TEXT,
      end_reason TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL
    )`);
    db.run(`INSERT INTO schema_version (version, applied_at) VALUES (10, ?)`, [new Date().toISOString()]);
  }

  // 版本 11: tasks 表 — Run 下的执行单元（支持父子层级）
  if (currentVersion < 11) {
    db.run(`CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id),
      parent_task_id TEXT,
      agent_id TEXT NOT NULL DEFAULT 'main',
      agent_type TEXT NOT NULL DEFAULT 'conversation',
      status TEXT NOT NULL DEFAULT 'pending',
      input TEXT,
      output TEXT,
      error TEXT,
      started_at TEXT,
      completed_at TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL
    )`);
    db.run(`INSERT INTO schema_version (version, applied_at) VALUES (11, ?)`, [new Date().toISOString()]);
  }

  // 版本 12: events 表 — Aether 2.0 Event Store + 关键索引
  if (currentVersion < 12) {
    db.run(`CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id),
      seq INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      event_version INTEGER NOT NULL DEFAULT 1,
      payload TEXT NOT NULL,
      packed TEXT,
      metadata TEXT,
      created_at TEXT NOT NULL
    )`);
    // 关键约束：UNIQUE(run_id, seq) — run 级序号分配器的并发安全保证
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_events_run_seq ON events(run_id, seq)`);
    // tasks 表常用查询索引
    db.run(`CREATE INDEX IF NOT EXISTS idx_tasks_run_id ON tasks(run_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id)`);
    db.run(`INSERT INTO schema_version (version, applied_at) VALUES (12, ?)`, [new Date().toISOString()]);
  }

  // 版本 13 (P0-21): 为所有 FK 添加 ON DELETE 行为 — 修复删除 Conversation / Provider
  // 时抛 "FOREIGN KEY constraint failed" 的问题。
  // 策略：子记录随父删除级联（ON DELETE CASCADE）；providers 被删时
  // conversations.provider_id 置 NULL（ON DELETE SET NULL，任务要求 —— 会话保留但不再绑定
  // provider，故该列从 NOT NULL 变为可空）。
  // SQLite 不支持直接修改 FK 约束，此处对全部 7 张含 FK 的表做重建（数据全量保留）。
  if (currentVersion < 13) {
    // 整改计划第 7 章：FK 开关已由 runMigrations 外层全局处理（BEGIN 前关闭，迁移后恢复），
    // 此处不再切换（SQLite 事务内 PRAGMA foreign_keys 为 no-op）。

    // conversations: provider_id 可空 + ON DELETE SET NULL
    rebuildTable(db, 'conversations', `CREATE TABLE conversations (
      id TEXT PRIMARY KEY, title TEXT NOT NULL DEFAULT '新对话',
      provider_id TEXT REFERENCES providers(id) ON DELETE SET NULL,
      model TEXT NOT NULL,
      generation_status TEXT NOT NULL DEFAULT 'idle',
      generation_state TEXT,
      token_total INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);

    // messages: conversation_id ON DELETE CASCADE
    // 整改计划第 4 章（P1）：新库直接带 seq 列（会话内稳定序号）
    rebuildTable(db, 'messages', `CREATE TABLE messages (
      id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL, content TEXT NOT NULL,
      tool_calls TEXT, tool_results TEXT, reasoning_content TEXT,
      seq INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL
    )`);

    // workflow_runs: workflow_id ON DELETE CASCADE
    rebuildTable(db, 'workflow_runs', `CREATE TABLE workflow_runs (
      id TEXT PRIMARY KEY, workflow_id TEXT NOT NULL REFERENCES workflows(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'pending', current_node_id TEXT,
      results TEXT DEFAULT '{}', error TEXT,
      started_at TEXT NOT NULL, completed_at TEXT
    )`);

    // activity_events: conversation_id ON DELETE CASCADE
    rebuildTable(db, 'activity_events', `CREATE TABLE activity_events (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      task_id TEXT NOT NULL,
      agent_id TEXT NOT NULL DEFAULT 'main',
      agent_type TEXT NOT NULL DEFAULT 'conversation',
      event_type TEXT NOT NULL,
      seq INTEGER NOT NULL,
      status TEXT, content TEXT, tool TEXT,
      parent_event_id TEXT, metadata TEXT,
      created_at TEXT NOT NULL
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_activity_events_conv_seq ON activity_events(conversation_id, seq)`);

    // runs: conversation_id（可空）ON DELETE CASCADE
    rebuildTable(db, 'runs', `CREATE TABLE runs (
      id TEXT PRIMARY KEY,
      conversation_id TEXT REFERENCES conversations(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'created',
      mode TEXT NOT NULL DEFAULT 'normal',
      root_agent_id TEXT,
      started_at TEXT, completed_at TEXT, end_reason TEXT,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      total_tokens INTEGER NOT NULL DEFAULT 0,
      error TEXT, metadata TEXT,
      created_at TEXT NOT NULL
    )`);

    // tasks: run_id ON DELETE CASCADE
    rebuildTable(db, 'tasks', `CREATE TABLE tasks (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      parent_task_id TEXT,
      agent_id TEXT NOT NULL DEFAULT 'main',
      agent_type TEXT NOT NULL DEFAULT 'conversation',
      status TEXT NOT NULL DEFAULT 'pending',
      input TEXT, output TEXT, error TEXT,
      started_at TEXT, completed_at TEXT,
      metadata TEXT, created_at TEXT NOT NULL
    )`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_tasks_run_id ON tasks(run_id)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id)`);

    // events: run_id ON DELETE CASCADE
    rebuildTable(db, 'events', `CREATE TABLE events (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      seq INTEGER NOT NULL,
      event_type TEXT NOT NULL,
      event_version INTEGER NOT NULL DEFAULT 1,
      payload TEXT NOT NULL,
      packed TEXT, metadata TEXT,
      created_at TEXT NOT NULL
    )`);
    db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_events_run_seq ON events(run_id, seq)`);

    db.run(`INSERT INTO schema_version (version, applied_at) VALUES (13, ?)`, [new Date().toISOString()]);
  }

  // 版本 14 (Wave0-MEM): memories 表新增列 — scope/importance/lastUsedAt/expiresAt
  // 使 memories 表成为运行时唯一事实源，兼容旧 JSON 数据迁移
  if (currentVersion < 14) {
    const memCols = db.exec('PRAGMA table_info(memories)');
    const hasScope = memCols.length > 0
      && memCols[0].values.some((row: unknown[]) => row[1] === 'scope');
    if (!hasScope) {
      db.run("ALTER TABLE memories ADD COLUMN scope TEXT NOT NULL DEFAULT 'user'");
      db.run("ALTER TABLE memories ADD COLUMN importance REAL NOT NULL DEFAULT 0.5");
      db.run("ALTER TABLE memories ADD COLUMN last_used_at TEXT");
      db.run("ALTER TABLE memories ADD COLUMN expires_at TEXT");
    }
    db.run(`INSERT INTO schema_version (version, applied_at) VALUES (14, ?)`, [new Date().toISOString()]);
  }

  // 版本 15 (整改计划第 4 章，P1): messages 表新增 seq 列 —
  // 会话内稳定序号，加载按 (created_at, seq) 稳定排序（避免同毫秒消息顺序不稳定）
  if (currentVersion < 15) {
    const msgCols = db.exec('PRAGMA table_info(messages)');
    const hasSeq = msgCols.length > 0
      && msgCols[0].values.some((row: unknown[]) => row[1] === 'seq');
    if (!hasSeq) {
      db.run("ALTER TABLE messages ADD COLUMN seq INTEGER NOT NULL DEFAULT 0");
    }
    db.run(`INSERT INTO schema_version (version, applied_at) VALUES (15, ?)`, [new Date().toISOString()]);
  }

  // 版本 16 (§27/P0-10 持久化): agent_configs 表新增 system_prompt 列 —
  // Prompt Registry 持久层（Backend restart 后自定义 Prompt 不丢失）
  if (currentVersion < 16) {
    const cfgCols = db.exec('PRAGMA table_info(agent_configs)');
    const hasSp = cfgCols.length > 0
      && cfgCols[0].values.some((row: unknown[]) => row[1] === 'system_prompt');
    if (!hasSp) {
      db.run("ALTER TABLE agent_configs ADD COLUMN system_prompt TEXT");
    }
    db.run(`INSERT INTO schema_version (version, applied_at) VALUES (16, ?)`, [new Date().toISOString()]);
  }

  // 版本 17 (W5): Run retry 关系与 lease 字段，Task attempt 字段。
  // SQLite ADD COLUMN 对已有行写入默认值；last_updated_at 用 created_at 回填，
  // 让旧运行在首次恢复检查时按真实历史时间计算 lease，而不是被立即误标。
  if (currentVersion < 17) {
    if (!hasColumn(db, 'runs', 'parent_run_id')) {
      db.run('ALTER TABLE runs ADD COLUMN parent_run_id TEXT')
    }
    if (!hasColumn(db, 'runs', 'retry_of_run_id')) {
      db.run('ALTER TABLE runs ADD COLUMN retry_of_run_id TEXT')
    }
    if (!hasColumn(db, 'runs', 'attempt')) {
      db.run('ALTER TABLE runs ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1')
    }
    if (!hasColumn(db, 'runs', 'retry_type')) {
      db.run('ALTER TABLE runs ADD COLUMN retry_type TEXT')
    }
    if (!hasColumn(db, 'runs', 'end_reason')) {
      db.run('ALTER TABLE runs ADD COLUMN end_reason TEXT')
    }
    if (!hasColumn(db, 'runs', 'last_updated_at')) {
      db.run('ALTER TABLE runs ADD COLUMN last_updated_at TEXT')
    }
    db.run('UPDATE runs SET last_updated_at = created_at WHERE last_updated_at IS NULL')

    if (!hasColumn(db, 'tasks', 'attempt')) {
      db.run('ALTER TABLE tasks ADD COLUMN attempt INTEGER NOT NULL DEFAULT 1')
    }

    db.run(`INSERT INTO schema_version (version, applied_at) VALUES (17, ?)`, [new Date().toISOString()])
  }

  // 整改计划第 7 章（P1）：所有迁移成功 → 提交单事务
  db.run('COMMIT');
  // 恢复迁移前的 FK 开关（SQLite 事务内不可修改，故在此恢复）
  db.run(`PRAGMA foreign_keys = ${fkOnBefore ? 'ON' : 'OFF'}`);

  // 保存到文件（原子写，防止强杀损坏主库）
  const data = db.export();
  const buffer = Buffer.from(data);
  atomicWrite(config.dbPath, buffer);

  db.close();
  } catch (e: unknown) {
    // 整改计划第 7 章（P1）：迁移失败 → 回滚整个事务，并从 .bak 恢复（若有）
    try { db.run('ROLLBACK'); } catch (error: unknown) { // no-excuse-ok: catch
      /* ignore - intentional */
    }
    if (bakPath) {
      try { renameSync(bakPath, config.dbPath); } catch (error: unknown) { // no-excuse-ok: catch
      /* ignore - intentional */
    }
    }
    try { db.close(); } catch (error: unknown) { // no-excuse-ok: catch
      /* ignore - intentional */
    }
    throw e;
  }
}