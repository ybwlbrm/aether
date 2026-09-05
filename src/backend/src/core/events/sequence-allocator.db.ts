/**
 * Aether 2.0 — DB-backed Run-Level Sequence Allocator (P3-03)
 *
 * Allocates monotonically increasing per-run sequence numbers by ATOMICALLY
 * INSERTING a claim row into the events table:
 *
 *   INSERT INTO events (id, run_id, seq, ...)
 *   VALUES (?, ?, COALESCE((SELECT MAX(seq) FROM events WHERE run_id = ?), 0) + 1, ...)
 *
 * The UNIQUE(run_id, seq) index (migration v12) guarantees that only one
 * concurrent allocator can claim a given seq; on constraint violation the
 * allocator re-reads MAX(seq) and retries with a fresh value.
 *
 * The claim row uses a reserved event_type marker so the storage layer
 * (SqliteEventStore) can later replace it with the real event payload under
 * the same (run_id, seq) without violating uniqueness.
 *
 * sql.js executes statements synchronously on a single thread, so in-process
 * calls are naturally serialized; the interface stays async to match the
 * EventStore contract and the future multi-worker path.
 */

import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import type { SQLJsDatabase } from 'drizzle-orm/sql-js';
import * as schema from '../../db/schema/index.js';
import { RuntimeError } from '../errors/index.js';

/** Reserved event_type marker for allocator claim rows */
export const SEQ_CLAIM_EVENT_TYPE = '__seq_claim';

/**
 * Options for DbSequenceAllocator.
 */
export interface DbSequenceAllocatorOptions {
  /** First allocated sequence number for a fresh run (default: 1) */
  startAt?: number;
}

/**
 * Run-level sequence allocator backed by the events table.
 *
 * allocate() atomically claims the next seq by inserting a claim row;
 * UNIQUE(run_id, seq) arbitration plus retry makes it race-safe.
 */
export class DbSequenceAllocator {
  private readonly db: SQLJsDatabase<typeof schema>;
  private readonly startAt: number;

  constructor(db: SQLJsDatabase<typeof schema>, opts: DbSequenceAllocatorOptions = {}) {
    this.db = db;
    this.startAt = opts.startAt ?? 1;
  }

  /**
   * Atomically allocate the next sequence number for a run.
   *
   * @throws RuntimeError with code INVALID_RUN_ID for an empty/blank runId
   */
  async allocate(runId: string): Promise<number> {
    if (runId.trim().length === 0) {
      throw new RuntimeError('Invalid run ID', { code: 'INVALID_RUN_ID' });
    }

    for (;;) {
      const row = this.db
        .select({ maxSeq: sql<number>`COALESCE(MAX(${schema.events.seq}), 0)` })
        .from(schema.events)
        .where(eq(schema.events.runId, runId))
        .get();
      const maxSeq = row?.maxSeq ?? 0;
      const next = Math.max(this.startAt, maxSeq + 1);

      try {
        this.db.insert(schema.events).values({
          id: randomUUID(),
          runId,
          seq: next,
          eventType: SEQ_CLAIM_EVENT_TYPE,
          eventVersion: 1,
          payload: '{}',
          createdAt: new Date().toISOString(),
        }).run();
        return next;
      } catch (error) {
        // UNIQUE(run_id, seq) violation → another allocator claimed this seq;
        // re-read MAX(seq) and retry. Any other error propagates.
        const message = error instanceof Error ? error.message : String(error);
        if (/UNIQUE/i.test(message)) continue;
        throw error;
      }
    }
  }

  /** Return the highest allocated sequence for a run (0 if never allocated) */
  async getCurrent(runId: string): Promise<number> {
    const row = this.db
      .select({ maxSeq: sql<number>`COALESCE(MAX(${schema.events.seq}), 0)` })
      .from(schema.events)
      .where(eq(schema.events.runId, runId))
      .get();
    return row?.maxSeq ?? 0;
  }

  /**
   * Reset sequence state for a run by deleting its stored events
   * (including claim rows). TESTING AID — do not call on production data.
   */
  async reset(runId: string): Promise<void> {
    this.db.delete(schema.events).where(eq(schema.events.runId, runId)).run();
  }
}