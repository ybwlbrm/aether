/**
 * Memory Runtime Bridge — Aether 2.0 Phase 7 migration seam
 *
 * Provides a SQLite-backed MemoryStore implementation (SqliteMemoryStore)
 * that uses the `memories` table as the single source of truth (Wave0-MEM).
 * The legacy JSON file (memory.json) is no longer used at runtime — it is
 * only for migration/import/export/backup purposes.
 *
 * Pure TypeScript — no Fastify/SSE/React imports.
 */

import { getDb } from '../db/client.js';
import { memories } from '../db/schema/index.js';
import { eq, desc, like, or } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { MemoryStore, MemoryEntry, MemoryQuery, MemoryScope } from '../core/memory/index.js';

type DbMemoryType = 'short_term' | 'project' | 'long_term';
type DbMemoryScope = 'user' | 'agent' | 'session' | 'project' | 'workspace';

/** Map a core MemoryEntry into the DB storage shape */
function toDbRow(entry: MemoryEntry): typeof memories.$inferInsert {
  const now = new Date().toISOString();
  return {
    id: entry.id ?? randomUUID(),
    type: entry.type as DbMemoryType,
    key: entry.content.slice(0, 100),
    content: entry.content,
    tags: '[]',
    scope: (entry.scope ?? 'user') as DbMemoryScope,
    importance: entry.importance ?? 0.5,
    lastUsedAt: entry.lastUsedAt ?? null,
    createdAt: entry.createdAt ?? now,
    updatedAt: now,
  };
}

/** Map a DB row into a core MemoryEntry */
function toCoreEntry(row: typeof memories.$inferSelect): MemoryEntry {
  return {
    id: row.id,
    type: row.type,
    content: row.content,
    scope: row.scope as MemoryScope,
    confidence: 1,
    importance: row.importance ?? 0.5,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lastUsedAt: row.lastUsedAt ?? undefined,
  };
}

/**
 * MemoryStore implementation backed by the SQLite `memories` table.
 * Reads and writes through drizzle ORM.
 */
export class SqliteMemoryStore implements MemoryStore {
  async put(entry: MemoryEntry): Promise<MemoryEntry> {
    const db = getDb();
    const now = new Date().toISOString();
    const normalized: MemoryEntry = {
      ...entry,
      id: entry.id ?? randomUUID(),
      createdAt: entry.createdAt ?? now,
      updatedAt: now,
      scope: entry.scope ?? 'user',
      confidence: entry.confidence ?? 1,
      importance: entry.importance ?? 0.5,
    };

    const existing = db.select().from(memories).where(eq(memories.id, normalized.id)).get();
    const row = toDbRow(normalized);
    if (existing) {
      db.update(memories).set(row).where(eq(memories.id, normalized.id)).run();
    } else {
      db.insert(memories).values(row).run();
    }
    return normalized;
  }

  async get(id: string): Promise<MemoryEntry | undefined> {
    const db = getDb();
    const row = db.select().from(memories).where(eq(memories.id, id)).get();
    return row ? toCoreEntry(row) : undefined;
  }

  async query(q: MemoryQuery): Promise<MemoryEntry[]> {
    const db = getDb();
    const limit = q.limit ?? 50;
    const offset = q.offset ?? 0;

    // Build conditions array first
    const conditions: any[] = [];
    if (q.scope !== undefined) {
      conditions.push(eq(memories.scope, q.scope));
    }
    if (q.type !== undefined) {
      conditions.push(eq(memories.type, q.type as DbMemoryType));
    }
    if (q.contentContains !== undefined) {
      const pattern = `%${q.contentContains}%`;
      conditions.push(or(like(memories.content, pattern), like(memories.key, pattern)));
    }

    // Use a single query with conditional where
    const rows = db.select()
      .from(memories)
      .where(conditions.length > 0 ? or(...conditions) : undefined)
      .orderBy(desc(memories.createdAt))
      .limit(limit)
      .offset(offset)
      .all();

    let matches = rows.map(toCoreEntry);

    if (q.importanceMin !== undefined) {
      matches = matches.filter((entry) => (entry.importance ?? 0.5) >= q.importanceMin!);
    }

    return matches;
  }

  async delete(id: string): Promise<boolean> {
    const db = getDb();
    const existing = db.select().from(memories).where(eq(memories.id, id)).get();
    if (!existing) return false;
    db.delete(memories).where(eq(memories.id, id)).run();
    return true;
  }
}

/** Convenience: build the SQLite-backed MemoryStore */
export function buildSqliteMemoryStore(): MemoryStore {
  return new SqliteMemoryStore();
}

/** @deprecated Legacy JSON file store — kept for migration/import/export/backup only */
export { JsonFileMemoryStore, buildFileMemoryStore } from './memory-runtime-bridge.legacy.js';