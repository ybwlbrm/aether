/**
 * Memory Store — Core Memory Persistence Primitives
 *
 * Defines the memory entry schema, query interface, and store contract.
 * Provides an in-memory implementation for testing and development.
 *
 * MemoryEntry (P1-37):
 * - id: unique identifier
 * - type: semantic type (e.g., 'fact', 'preference', 'conversation', 'tool-result')
 * - content: the actual memory content
 * - source: optional origin (e.g., 'user', 'agent:planner', 'tool:filesystem')
 * - confidence: 0-1 confidence score
 * - importance: 0-1 importance weight for retention/decay
 * - scope: visibility scope (user|agent|session|project|workspace)
 * - createdAt/updatedAt: ISO 8601 timestamps
 * - lastUsedAt: optional last access timestamp
 * - decayScore: optional computed decay value for forgetting
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Memory visibility scope.
 * - user: user-specific memories
 * - agent: agent-specific memories
 * - session: ephemeral session memories
 * - project: project-scoped memories
 * - workspace: global workspace memories
 */
export type MemoryScope = 'user' | 'agent' | 'session' | 'project' | 'workspace';

/**
 * A single memory entry.
 */
export interface MemoryEntry {
  /** Unique identifier (UUID recommended) */
  id: string;
  /** Semantic type for categorization and retrieval */
  type: string;
  /** The actual memory content */
  content: string;
  /** Optional origin/source of this memory */
  source?: string;
  /** Confidence score 0-1 (default: 1) */
  confidence?: number;
  /** Importance weight 0-1 for retention priority (default: 0.5) */
  importance?: number;
  /** Visibility scope */
  scope: MemoryScope;
  /** Creation timestamp (ISO 8601) — set by store if omitted */
  createdAt?: string;
  /** Last update timestamp (ISO 8601) — set by store if omitted */
  updatedAt?: string;
  /** Last access timestamp (ISO 8601), set on recall */
  lastUsedAt?: string;
  /** Computed decay score for forgetting policies */
  decayScore?: number;
}

/**
 * Query parameters for memory retrieval.
 * All fields are optional — omit to match all.
 */
export interface MemoryQuery {
  /** Filter by scope */
  scope?: MemoryScope;
  /** Filter by exact type match */
  type?: string;
  /** Case-insensitive substring match on content */
  contentContains?: string;
  /** Minimum importance threshold (0-1) */
  importanceMin?: number;
  /** Maximum results to return (default: 50) */
  limit?: number;
  /** Offset for pagination (default: 0) */
  offset?: number;
}

/**
 * Memory store contract.
 * Implementations provide persistence (in-memory, SQLite, vector DB, etc.).
 */
export interface MemoryStore {
  /**
   * Stores a memory entry.
   * If entry.id exists, updates the entry (upsert semantics).
   * Returns the stored entry with timestamps normalized.
   */
  put(entry: MemoryEntry): Promise<MemoryEntry>;

  /**
   * Retrieves a memory entry by ID.
   * Returns undefined if not found.
   */
  get(id: string): Promise<MemoryEntry | undefined>;

  /**
   * Queries memories matching the criteria.
   * Results ordered by createdAt descending (newest first).
   * Supports pagination via limit/offset.
   */
  query(q: MemoryQuery): Promise<MemoryEntry[]>;

  /**
   * Deletes a memory entry by ID.
   * Returns true if deleted, false if not found.
   */
  delete(id: string): Promise<boolean>;
}

// ============================================================================
// In-Memory Implementation
// ============================================================================

/**
 * In-memory MemoryStore implementation using a Map.
 * Suitable for testing, development, and ephemeral sessions.
 * Not persistent across restarts.
 */
export class InMemoryMemoryStore implements MemoryStore {
  private readonly store = new Map<string, MemoryEntry>();

  /**
   * Normalizes and validates a memory entry, setting defaults.
   */
  private normalizeEntry(entry: MemoryEntry): MemoryEntry {
    const now = new Date().toISOString();
    return {
      ...entry,
      confidence: entry.confidence ?? 1,
      importance: entry.importance ?? 0.5,
      createdAt: entry.createdAt ?? now,
      updatedAt: now,
    } as MemoryEntry;
  }

  /**
   * Checks if an entry matches a query.
   */
  private matchesQuery(entry: MemoryEntry, query: MemoryQuery): boolean {
    if (query.scope && entry.scope !== query.scope) {
      return false;
    }
    if (query.type && entry.type !== query.type) {
      return false;
    }
    if (query.contentContains) {
      const needle = query.contentContains.toLowerCase();
      if (!entry.content.toLowerCase().includes(needle)) {
        return false;
      }
    }
    if (query.importanceMin != null && (entry.importance ?? 0.5) < query.importanceMin) {
      return false;
    }
    return true;
  }

  async put(entry: MemoryEntry): Promise<MemoryEntry> {
    const normalized = this.normalizeEntry(entry);
    this.store.set(normalized.id, normalized);
    return normalized;
  }

  async get(id: string): Promise<MemoryEntry | undefined> {
    return this.store.get(id);
  }

  async query(q: MemoryQuery): Promise<MemoryEntry[]> {
    const limit = q.limit ?? 50;
    const offset = q.offset ?? 0;

    // Filter and collect matching entries
    const matches: MemoryEntry[] = [];
    for (const entry of this.store.values()) {
      if (this.matchesQuery(entry, q)) {
        matches.push(entry);
      }
    }

    // Sort by createdAt descending (newest first)
    matches.sort((a, b) => {
      const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return bTime - aTime;
    });

    // Apply pagination
    return matches.slice(offset, offset + limit);
  }

  async delete(id: string): Promise<boolean> {
    return this.store.delete(id);
  }

  /**
   * Clears all entries (testing utility).
   */
  clear(): void {
    this.store.clear();
  }

  /**
   * Returns the number of stored entries (testing utility).
   */
  size(): number {
    return this.store.size;
  }
}