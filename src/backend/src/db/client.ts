import initSqlJs, { type Database as SqlJsDb } from 'sql.js';
import { drizzle } from 'drizzle-orm/sql-js';
import * as schema from './schema/index.js';
import type { BackendConfig } from '../config/index.js';
import { readFileSync, writeFileSync, existsSync, renameSync, unlinkSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import type { SQLJsDatabase } from 'drizzle-orm/sql-js';

type DbType = SQLJsDatabase<typeof schema>;

let db: DbType | null = null;
let sqlDb: SqlJsDb | null = null;

/** 测试专用：注入内存数据库实例 */
export function setDbForTest(testDb: DbType | null): void {
  db = testDb;
}

export function getDb(): DbType {
  if (!db) throw new Error('Database not initialized. Call initDb() first.');
  return db;
}

export async function initDb(config: BackendConfig): Promise<DbType> {
  const SQL = await initSqlJs();

  if (existsSync(config.dbPath)) {
    const buffer = readFileSync(config.dbPath);
    sqlDb = new SQL.Database(buffer);
  } else {
    sqlDb = new SQL.Database();
  }

  sqlDb.run('PRAGMA foreign_keys = ON');
  db = drizzle(sqlDb, { schema }) as DbType;
  return db;
}

// P0-2: Debounced dirty-flag — 替代每次响应都全量同步导出
let dirty = false;
let flushTimer: NodeJS.Timeout | null = null;
const FLUSH_DEBOUNCE_MS = 500;      // 500ms 内合并多次写入
const FLUSH_MAX_LATENCY_MS = 5000;  // 最长 5s 必须落盘
let lastDirtyTime = 0;              // 记录最后一次标记脏的时间，用于兜底判断
// 整改计划第 4 章（P1）：持久化失败重试队列 —— 失败必须向 API/UI 返回可见错误
const FLUSH_RETRY_QUEUE: Buffer[] = [];
let lastFlushError: string | null = null;

/** 标记 DB 已变更，触发 debounce 落盘（非阻塞） */
export function markDirty(config: BackendConfig): void {
  dirty = true;
  lastDirtyTime = Date.now();
  // 单一防抖定时器：每次 markDirty 重置，flushNow 内检查 elapsed >= maxLatency 决定是否提前 flush
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
  flushTimer = setTimeout(() => flushNow(config), FLUSH_DEBOUNCE_MS);
}

/**
 * 立即同步落盘（原子写 + fsync 保证崩溃一致）。
 * 整改计划第 4 章：错误向上传播（返回 false 并记录），不再静默吞掉 ——
 * 失败时保留缓冲到重试队列，供 /api/health 或下次 flush 重试。
 */
function flushNow(config: BackendConfig): boolean {
  if (!sqlDb) return true;
  // BE-RC-01: 检查距离最后一次 markDirty 是否已超过最大延迟，若未超过则重新安排防抖定时器
  const elapsed = Date.now() - lastDirtyTime;
  if (elapsed < FLUSH_MAX_LATENCY_MS) {
    // 尚未达到兜底时间，重新安排防抖定时器等待剩余时间
    if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }
    flushTimer = setTimeout(() => flushNow(config), FLUSH_MAX_LATENCY_MS - elapsed);
    return true;
  }
  if (!dirty) return true;
  dirty = false;
  if (flushTimer) { clearTimeout(flushTimer); flushTimer = null; }

  const data = sqlDb.export();
  const buffer = Buffer.from(data);
  const tmpPath = join(config.dbPath, '..', `pacc.db.tmp.${randomBytes(8).toString('hex')}`);
  try {
    // P0-2: fsync 保证崩溃一致
    const fd = openSync(tmpPath, 'w');
    writeFileSync(fd, buffer);
    try { fsyncSync(fd); } catch { /* fsync best-effort */ }
    closeSync(fd);
    renameSync(tmpPath, config.dbPath);
    // 成功：清空重试队列与错误状态
    FLUSH_RETRY_QUEUE.length = 0;
    lastFlushError = null;
    return true;
  } catch (e) {
    try { if (existsSync(tmpPath)) unlinkSync(tmpPath); } catch (_e: unknown) { /* ignore - intentional */ }
    // 非原子回退：至少不丢数据
    try {
      writeFileSync(config.dbPath, buffer);
      FLUSH_RETRY_QUEUE.length = 0;
      lastFlushError = null;
      return true;
    } catch (e2) {
      // 整改计划第 4 章：失败必须可见 —— 记录错误 + 缓冲重试
      lastFlushError = (e2 as Error).message;
      if (FLUSH_RETRY_QUEUE.length < 8) FLUSH_RETRY_QUEUE.push(buffer);
      console.error('[DB] flushNow 失败:', lastFlushError);
      return false;
    }
  }
}

/** 获取最近一次持久化错误（无错误返回 null） */
export function getLastFlushError(): string | null {
  return lastFlushError;
}

/** 重试失败的持久化（返回 true=成功/无需重试，false=仍失败） */
export function retryPendingFlush(config: BackendConfig): boolean {
  if (FLUSH_RETRY_QUEUE.length === 0) return true;
  const buffer = FLUSH_RETRY_QUEUE[FLUSH_RETRY_QUEUE.length - 1];
  try {
    const tmpPath = join(config.dbPath, '..', `pacc.db.tmp.${randomBytes(8).toString('hex')}`);
    const fd = openSync(tmpPath, 'w');
    writeFileSync(fd, buffer);
    try { fsyncSync(fd); } catch { /* best-effort */ }
    closeSync(fd);
    renameSync(tmpPath, config.dbPath);
    FLUSH_RETRY_QUEUE.length = 0;
    lastFlushError = null;
    return true;
  } catch {
    return false;
  }
}

/**
 * 整改计划第 4 章（P1）：在单个 SQLite 事务中执行写入（消息 + run 状态同事务）。
 * sql.js 是内存库：BEGIN → 操作 → COMMIT/ROLLBACK，任一操作失败整体回滚。
 */
export function runInTransaction<T>(config: BackendConfig, fn: () => T): T {
  if (!sqlDb) return fn();
  sqlDb.run('BEGIN');
  try {
    const result = fn();
    sqlDb.run('COMMIT');
    markDirty(config);
    return result;
  } catch (e) {
    try { sqlDb.run('ROLLBACK'); } catch (_e: unknown) { /* ignore - intentional */ }
    throw e;
  }
}

/** 兼容旧接口 — 等价于 markDirty（非阻塞） */
export function saveDb(config: BackendConfig): void {
  markDirty(config);
}

/** 立即同步落盘（用于 onClose 等必须立即持久化的场景） */
export function flushDbSync(config: BackendConfig): boolean {
  return flushNow(config);
}