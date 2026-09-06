/**
 * Legacy Memory Runtime Bridge — Aether 2.0 Phase 7 migration seam
 *
 * Adapts the LEGACY JSON-file memory store (lib/dal/memory.ts → memory.json,
 * MemoryItem shape) into the NEW core MemoryStore interface so the core
 * MemoryRuntime / MemoryRetriever can read and write the existing data
 * without a destructive migration (Adapter pattern, §2.1 不推倒重来).
 *
 * The legacy MemoryItem {id, content, active, createdAt, updatedAt, category}
 * maps onto core MemoryEntry {id, type, content, scope, createdAt, updatedAt,
 * confidence, importance}. Legacy rows default scope='user', type=category.
 *
 * PURELY FOR MIGRATION/IMPORT/EXPORT/BACKUP — NOT FOR RUNTIME USE (Wave0-MEM).
 *
 * Pure TypeScript — no Fastify/SSE/React imports.
 */

import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { DATA_DIR } from './dal/utils.js';
import { atomicRead, atomicWrite, withFileLock } from './dal/utils.js';
import type { MemoryStore, MemoryEntry, MemoryQuery, MemoryScope } from '../core/memory/index.js';

/** Legacy memory item shape stored in memory.json */
interface LegacyMemoryItem {
  id: string;
  content: string;
  active?: boolean;
  createdAt?: string;
  updatedAt?: string;
  category?: string;
  /** Scope added by the bridge — legacy rows without it default to 'user' */
  scope?: string;
}

const MEMORY_PATH = path.join(DATA_DIR, 'memory.json');

/** Map a core MemoryEntry into the legacy storage shape (preserves extra fields) */
function toLegacyItem(entry: MemoryEntry): LegacyMemoryItem {
  const item: LegacyMemoryItem = {
    id: entry.id,
    content: entry.content,
    active: true,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
    category: entry.type !== 'user' && entry.type !== 'general' ? entry.type : 'manual',
    scope: entry.scope ?? 'user',
  };
  return item;
}

/** Map a legacy item into a core MemoryEntry with defaults */
function toCoreEntry(item: LegacyMemoryItem): MemoryEntry {
  const now = new Date().toISOString();
  return {
    id: item.id,
    type: item.category ?? 'general',
    content: item.content,
    scope: (item.scope as MemoryScope) ?? 'user',
    confidence: 1,
    importance: 0.5,
    createdAt: item.createdAt ?? now,
    updatedAt: item.updatedAt ?? now,
  };
}

/**
 * MemoryStore implementation backed by the legacy memory.json file.
 * Reads and writes through the same atomic file helpers as the old DAL,
 * so existing data is preserved and the legacy API keeps working.
 *
 * @deprecated Use SqliteMemoryStore from memory-runtime-bridge.ts for runtime.
 * This is kept ONLY for migration/import/export/backup.
 */
export class JsonFileMemoryStore implements MemoryStore {
  private readonly filePath: string;

  constructor(filePath?: string) {
    this.filePath = filePath ?? MEMORY_PATH;
  }

  async put(entry: MemoryEntry): Promise<MemoryEntry> {
    return withFileLock(this.filePath, async () => {
      const items = await atomicRead<LegacyMemoryItem[]>(this.filePath, []);
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

      const idx = items.findIndex((m) => m.id === normalized.id);
      const legacy = toLegacyItem(normalized);
      if (idx >= 0) {
        items[idx] = legacy;
      } else {
        items.push(legacy);
      }
      await atomicWrite(this.filePath, items);
      return normalized;
    });
  }

  async get(id: string): Promise<MemoryEntry | undefined> {
    const items = await atomicRead<LegacyMemoryItem[]>(this.filePath, []);
    const item = items.find((m) => m.id === id);
    return item ? toCoreEntry(item) : undefined;
  }

  async query(q: MemoryQuery): Promise<MemoryEntry[]> {
    const items = await atomicRead<LegacyMemoryItem[]>(this.filePath, []);
    const limit = q.limit ?? 50;
    const offset = q.offset ?? 0;

    const matches = items
      .map(toCoreEntry)
      .filter((entry) => {
        if (q.scope !== undefined && entry.scope !== q.scope) return false;
        if (q.type !== undefined && entry.type !== q.type) return false;
        if (q.contentContains !== undefined) {
          if (!entry.content.toLowerCase().includes(q.contentContains.toLowerCase())) return false;
        }
        if (q.importanceMin !== undefined && (entry.importance ?? 0.5) < q.importanceMin) return false;
        return true;
      })
      .sort((a, b) => {
        const at = a.createdAt ? new Date(a.createdAt).getTime() : 0;
        const bt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
        return bt - at;
      });

    return matches.slice(offset, offset + limit);
  }

  async delete(id: string): Promise<boolean> {
    return withFileLock(this.filePath, async () => {
      const items = await atomicRead<LegacyMemoryItem[]>(this.filePath, []);
      const filtered = items.filter((m) => m.id !== id);
      if (filtered.length === items.length) return false;
      await atomicWrite(this.filePath, filtered);
      return true;
    });
  }
}

/** Convenience: adapt the legacy DAL functions behind the core MemoryRuntime interface */
export function buildFileMemoryStore(): MemoryStore {
  return new JsonFileMemoryStore();
}