/**
 * Memory Runtime — High-Level Memory Operations Interface
 *
 * Provides a runtime-agnostic interface for memory operations (remember, recall, forget).
 * This is the Wave 2 interface-only delivery. The full Runtime-base-backed implementation
 * will arrive in Wave 3 when src/backend/src/core/runtime/runtime.ts is stable.
 *
 * DESIGN NOTE:
 * - This module deliberately does NOT import from '../runtime/' to avoid cross-agent
 *   dependency on the concurrently-developed Runtime base class.
 * - The `InMemoryMemoryRuntime` stub delegates to an injected `MemoryStore` for
 *   immediate testability and development use.
 * - Wave 3 will introduce `RuntimeMemoryRuntime extends RuntimeBase implements MemoryRuntime`
 *   with persistence, vector search, and agent-scoped isolation.
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
 * const runtime: MemoryRuntime = new InMemoryMemoryRuntime(store);
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
}

// ============================================================================
// In-Memory Stub Implementation
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

/**
 * In-memory MemoryRuntime implementation.
 *
 * Delegates all operations to an injected MemoryStore.
 * Suitable for testing, development, and ephemeral sessions.
 *
 * @remarks
 * Wave 3 replacement: `RuntimeMemoryRuntime` will extend the Runtime base class
 * (from `../runtime/runtime.ts`) and provide:
 * - Persistent storage via configured MemoryStore backend
 * - Vector similarity search via embeddings
 * - Agent-scoped memory isolation
 * - Automatic decay/forgetting policies
 * - Cross-session memory consolidation
 */
export class InMemoryMemoryRuntime implements MemoryRuntime {
  private readonly store: MemoryStore;

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