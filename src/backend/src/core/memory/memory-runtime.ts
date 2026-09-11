/**
 * Memory Runtime — High-Level Memory Operations Interface + 生产实现
 *
 * P1-18 收口：MemoryRuntime 不再只是 interface + InMemory stub ——
 * 新增 SqliteMemoryRuntime：MemoryRuntime → MemoryStore → SQLite 完整生产链路。
 *
 * - remember / recall / forget 全部经 MemoryStore（SqliteMemoryStore）持久化
 * - recall 自动跳过过期记忆（expiresAt 由 store 处理，P1-17）
 * - release() 显式释放资源
 *
 * 分层注意：本模块位于 core/，不得直接 import lib/。SQLite store 的绑定由
 * lib/memory-runtime-bridge.ts 通过 bindSqliteStoreProvider() 注入，
 * 或由调用方直接构造 SqliteMemoryRuntime(store) 显式传入。
 *
 * Transport-agnostic：无 Fastify/SSE/React 依赖。
 */

import type { MemoryEntry, MemoryQuery, MemoryStore } from './memory-store.js';

// ============================================================================
// MemoryRuntime Interface
// ============================================================================

/**
 * High-level memory operations for agents and tools.
 *
 * @interface
 * @example
 * ```ts
 * const runtime: MemoryRuntime = new SqliteMemoryRuntime(store);
 * await runtime.remember({ type: 'fact', content: 'User likes coffee', scope: 'user' });
 * const memories = await runtime.recall({ scope: 'user', contentContains: 'coffee' });
 * await runtime.forget(memories[0].id);
 * ```
 */
export interface MemoryRuntime {
  /**
   * Stores a new memory entry.
   * Generates an ID if not provided, sets timestamps.
   *
   * @param entry - Memory entry to store (id optional, will be generated)
   * @returns The stored entry with generated ID and timestamps
   */
  remember(entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Promise<MemoryEntry>;

  /**
   * Retrieves memories matching the query.
   * Updates lastUsedAt on returned entries.
   *
   * @param query - Query parameters
   * @returns Matching memory entries (newest first)
   */
  recall(query: MemoryQuery): Promise<MemoryEntry[]>;

  /**
   * Deletes a memory by ID.
   *
   * @param id - Memory ID to delete
   * @returns true if deleted, false if not found
   */
  forget(id: string): Promise<boolean>;

  /**
   * P1-18: 释放 runtime 持有的资源（store 清理等）。
   * 幂等：可多次调用。
   */
  release(): void;
}

// ============================================================================
// ID 生成
// ============================================================================

/**
 * Generates a simple UUID v4.
 * In production, use a proper UUID library (e.g., `crypto.randomUUID()`).
 */
function generateId(): string {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// ============================================================================
// In-Memory Implementation（测试/开发/临时会话）
// ============================================================================

/**
 * In-memory MemoryRuntime implementation.
 *
 * Delegates all operations to an injected MemoryStore.
 * Suitable for testing, development, and ephemeral sessions.
 */
export class InMemoryMemoryRuntime implements MemoryRuntime {
  private readonly store: MemoryStore;
  private released = false;

  /**
   * Creates a new InMemoryMemoryRuntime.
   *
   * @param store - MemoryStore implementation to delegate to
   */
  constructor(store: MemoryStore) {
    this.store = store;
  }

  async remember(entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Promise<MemoryEntry> {
    const now = new Date().toISOString();
    const fullEntry: MemoryEntry = {
      ...entry,
      id: entry.id ?? generateId(),
      createdAt: now,
      updatedAt: now,
    };
    return this.store.put(fullEntry);
  }

  async recall(query: MemoryQuery): Promise<MemoryEntry[]> {
    if (this.released) return [];
    const results = await this.store.query(query);

    // Update lastUsedAt on recalled entries (fire-and-forget)
    const now = new Date().toISOString();
    for (const entry of results) {
      // We don't await to avoid N+1 latency; lastUsedAt is best-effort
      this.store.put({ ...entry, lastUsedAt: now, updatedAt: now }).catch(() => {
        // Ignore update failures — lastUsedAt is advisory
      });
    }

    return results;
  }

  async forget(id: string): Promise<boolean> {
    return this.store.delete(id);
  }

  release(): void {
    this.released = true;
  }
}

// ============================================================================
// SQLite Production Implementation（P1-18：MemoryRuntime → MemoryStore → SQLite）
// ============================================================================

/**
 * SQLite-backed production MemoryRuntime.
 * MemoryRuntime → MemoryStore → SQLite 完整链路（P1-18 收口）。
 *
 * store 依赖注入方式：
 * 1. 显式构造 SqliteMemoryRuntime(store) —— 测试/调用方自选 store
 * 2. 无 store 时使用 bindSqliteStoreProvider() 绑定的生产 store（lib 层启动时绑定）
 *
 * @example
 * ```ts
 * const runtime = createProductionMemoryRuntime();
 * await runtime.remember({ ... });
 * ```
 */
export class SqliteMemoryRuntime implements MemoryRuntime {
  private store: MemoryStore | null = null;
  private storePromise: Promise<MemoryStore> | null = null;
  private released = false;

  constructor(store?: MemoryStore) {
    if (store) {
      this.store = store;
      this.storePromise = Promise.resolve(store);
    }
  }

  /** 解析 store（显式注入优先；否则异步加载已绑定的生产 provider） */
  private async getStore(): Promise<MemoryStore> {
    if (this.store) return this.store;
    if (!this.storePromise) {
      if (!sqliteStoreProvider) {
        throw new Error('SqliteMemoryRuntime: 未绑定 SQLite store provider（调用 bindSqliteStoreProvider 或显式传入 store）');
      }
      this.storePromise = Promise.resolve(sqliteStoreProvider()).then(s => {
        this.store = s;
        return s;
      });
    }
    return this.storePromise;
  }

  async remember(entry: Omit<MemoryEntry, 'id' | 'createdAt' | 'updatedAt'> & { id?: string }): Promise<MemoryEntry> {
    const now = new Date().toISOString();
    const fullEntry: MemoryEntry = {
      ...entry,
      id: entry.id ?? generateId(),
      createdAt: now,
      updatedAt: now,
      expiresAt: entry.expiresAt, // P1-17: 支持过期时间
    };
    const store = await this.getStore();
    return store.put(fullEntry);
  }

  async recall(query: MemoryQuery): Promise<MemoryEntry[]> {
    if (this.released) return [];
    const store = await this.getStore();
    const results = await store.query(query);
    // P1-17: store 层已过滤过期记忆；此处 best-effort 更新 lastUsedAt
    const now = new Date().toISOString();
    for (const entry of results) {
      store.put({ ...entry, lastUsedAt: now, updatedAt: now }).catch(() => {
        // Ignore update failures — lastUsedAt is advisory
      });
    }
    return results;
  }

  async forget(id: string): Promise<boolean> {
    const store = await this.getStore();
    return store.delete(id);
  }

  release(): void {
    this.released = true;
  }
}

/** SQLite store provider（由 lib 层 bindSqliteStoreProvider() 注入） */
let sqliteStoreProvider: (() => MemoryStore) | null = null;

/**
 * 生产环境绑定 SQLite store 提供者（lib/memory-runtime-bridge 启动时调用；
 * 或测试中注入自定义 store）。
 */
export function bindSqliteStoreProvider(provider: () => MemoryStore): void {
  sqliteStoreProvider = provider;
}

/** 测试辅助：重置 SQLite store provider 绑定 */
export function resetSqliteMemoryRuntime(): void {
  sqliteStoreProvider = null;
}

/**
 * 便捷工厂：构建 SQLite 生产 MemoryRuntime（P1-18 生产入口）。
 * 默认使用 bindSqliteStoreProvider() 绑定的 store；
 * 也可显式传入 store 覆盖。
 */
export function createProductionMemoryRuntime(store?: MemoryStore): MemoryRuntime {
  return new SqliteMemoryRuntime(store);
}

/**
 * Type guard to check if a value implements MemoryRuntime.
 * Useful for runtime validation of injected dependencies.
 */
export function isMemoryRuntime(value: unknown): value is MemoryRuntime {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as Record<string, unknown>).remember === 'function' &&
    typeof (value as Record<string, unknown>).recall === 'function' &&
    typeof (value as Record<string, unknown>).forget === 'function'
  );
}