import { getDb } from '../../db/client.js';
import { memories } from '../../db/schema/index.js';
import { eq, desc } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import type { MemoryItem } from './types.js';

type MemoryType = 'short_term' | 'project' | 'long_term';
type MemoryScope = 'user' | 'agent' | 'session' | 'project' | 'workspace';

function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const t = JSON.parse(raw);
    return Array.isArray(t) ? t.filter((x: unknown) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function rowToMemoryItem(row: typeof memories.$inferSelect): MemoryItem {
  return {
    id: row.id,
    content: row.content,
    active: true,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    category: row.type,
  };
}

function normalizeType(category: string): MemoryType {
  return (['short_term', 'project', 'long_term'] as const).includes(category as MemoryType) ? category as MemoryType : 'short_term';
}

export async function getMemories(): Promise<MemoryItem[]> {
  const db = getDb();
  const rows = db.select().from(memories).orderBy(desc(memories.createdAt)).all();
  return rows.map(rowToMemoryItem);
}

export async function saveMemory(content: string, category: string = 'manual'): Promise<MemoryItem> {
  const db = getDb();
  const now = new Date().toISOString();
  const id = randomUUID();
  const type = normalizeType(category);
  db.insert(memories).values({
    id,
    type,
    key: content.slice(0, 100),
    content,
    tags: '[]',
    scope: 'user' as MemoryScope,
    importance: 0.5,
    createdAt: now,
    updatedAt: now,
  }).run();
  return { id, content, active: true, createdAt: now, updatedAt: now, category: type };
}

export async function updateMemory(id: string, data: Partial<MemoryItem>): Promise<MemoryItem | null> {
  const db = getDb();
  const existing = db.select().from(memories).where(eq(memories.id, id)).get();
  if (!existing) return null;
  const now = new Date().toISOString();
  const updateData: Partial<typeof memories.$inferInsert> = { updatedAt: now };
  if (data.content !== undefined) {
    updateData.content = data.content;
    updateData.key = data.content.slice(0, 100);
  }
  if (data.category !== undefined) {
    updateData.type = normalizeType(data.category);
  }
  db.update(memories).set(updateData).where(eq(memories.id, id)).run();
  const updated = db.select().from(memories).where(eq(memories.id, id)).get();
  return updated ? rowToMemoryItem(updated) : null;
}

export async function deleteMemory(id: string): Promise<boolean> {
  const db = getDb();
  const existing = db.select().from(memories).where(eq(memories.id, id)).get();
  if (!existing) return false;
  db.delete(memories).where(eq(memories.id, id)).run();
  return true;
}