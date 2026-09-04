import path from 'node:path';
import { DATA_DIR } from './utils.js';
import { atomicRead, atomicWrite, withFileLock } from './utils.js';
import { randomUUID } from 'node:crypto';
import type { MemoryItem } from './types.js';

const MEMORY_PATH = path.join(DATA_DIR, 'memory.json');

export async function getMemories(): Promise<MemoryItem[]> {
  return atomicRead(MEMORY_PATH, []);
}

export async function saveMemory(content: string, category: string = 'manual'): Promise<MemoryItem> {
  // P1-2: withFileLock
  return withFileLock(MEMORY_PATH, async () => {
    const memories = await getMemories();
    const now = new Date().toISOString();
    const item: MemoryItem = {
      id: randomUUID(),
      content,
      active: true,
      createdAt: now,
      updatedAt: now,
      category,
    };
    memories.push(item);
    await atomicWrite(MEMORY_PATH, memories);
    return item;
  });
}

export async function updateMemory(id: string, data: Partial<MemoryItem>): Promise<MemoryItem | null> {
  return withFileLock(MEMORY_PATH, async () => {
    const memories = await getMemories();
    const idx = memories.findIndex(m => m.id === id);
    if (idx === -1) return null;
    memories[idx] = { ...memories[idx], ...data, id, updatedAt: new Date().toISOString() };
    await atomicWrite(MEMORY_PATH, memories);
    return memories[idx];
  });
}

export async function deleteMemory(id: string): Promise<boolean> {
  return withFileLock(MEMORY_PATH, async () => {
    const memories = await getMemories();
    const filtered = memories.filter(m => m.id !== id);
    if (filtered.length === memories.length) return false;
    await atomicWrite(MEMORY_PATH, filtered);
    return true;
  });
}