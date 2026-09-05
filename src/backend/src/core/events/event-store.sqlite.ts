/**
 * Aether 2.0 — SQLite-backed Event Store (P3-02, Wave 5)
 *
 * Persists v2 AgentEvent discriminated-union events into the `events` table
 * (see src/backend/src/db/schema/index.ts). The `payload` column stores the
 * full JSON-serialized AgentEvent; the `event_type` / `event_version` columns
 * mirror the discriminant (`type`) and protocol version for indexed access.
 *
 * Key invariants:
 * - `UNIQUE(run_id, seq)` (idx_events_run_seq) makes appends idempotent: a
 *   duplicate (runId, seq) is swallowed with a warning — the run-level sequence
 *   allocator handles retries at a higher layer.
 * - `runId` isolation: every read is scoped by `eq(events.runId, runId)`.
 * - Ordering is by `seq` ascending (list) / descending (latest).
 */

import { eq, and, gt, asc, desc, sql } from 'drizzle-orm';
import type { SQLJsDatabase } from 'drizzle-orm/sql-js';
import type { AgentEvent } from '@pacc/shared';
import type { EventStore } from './event-store.js';
import { events } from '../../db/schema/index.js';
import * as schema from '../../db/schema/index.js';
import { unpackPackedPayload, type PackedChunk } from './chunk-packer.js';

/** Row shape inferred from the drizzle `events` table definition */
type EventRow = typeof events.$inferSelect;

/** Detect a UNIQUE(run_id, seq) constraint violation raised by sql.js */
function isUniqueViolation(err: unknown): boolean {
  return err instanceof Error && /UNIQUE constraint failed/i.test(err.message);
}

/** Reserved event_type marker for allocator claim rows (see sequence-allocator.db.ts) */
const SEQ_CLAIM_EVENT_TYPE = '__seq_claim';

/** Serialize a v2 AgentEvent into the `payload` TEXT column (full envelope) */
function serializePayload(event: AgentEvent): string {
  return JSON.stringify(event);
}

/**
 * Insert or replace an event row, honoring allocator claim rows:
 * - If a row with (runId, seq) already exists and is a claim row, UPDATE it
 *   with the real event payload (the allocator pre-claimed this seq).
 * - Otherwise INSERT (a fresh seq, or an explicit user-supplied seq).
 * Returns true when the row was persisted.
 */
function upsertEvent(
  db: SQLJsDatabase<typeof schema>,
  event: AgentEvent,
): boolean {
  const existing = db
    .select({ eventType: events.eventType })
    .from(events)
    .where(and(eq(events.runId, event.runId), eq(events.seq, event.seq)))
    .get();

  if (existing && existing.eventType === SEQ_CLAIM_EVENT_TYPE) {
    // Replace the claim row with the real event — same (runId, seq), no UNIQUE violation
    db.update(events)
      .set({
        id: event.eventId,
        eventType: event.type,
        eventVersion: event.version,
        payload: serializePayload(event),
        packed: null,
        metadata: event.metadata !== undefined ? JSON.stringify(event.metadata) : null,
        createdAt: event.timestamp,
      })
      .where(and(eq(events.runId, event.runId), eq(events.seq, event.seq)))
      .run();
    return true;
  }

  if (existing) {
    // Duplicate (runId, seq) of a real event — idempotent append, skip
    console.warn(
      `[EventStore] append skipped — duplicate (runId, seq): run=${event.runId} seq=${event.seq}`,
    );
    return false;
  }

  db.insert(events)
    .values({
      id: event.eventId,
      runId: event.runId,
      seq: event.seq,
      eventType: event.type,
      eventVersion: event.version,
      payload: serializePayload(event),
      packed: null,
      metadata: event.metadata !== undefined ? JSON.stringify(event.metadata) : null,
      createdAt: event.timestamp,
    })
    .run();
  return true;
}

/**
 * SQLite-backed EventStore.
 *
 * Constructor takes the shared drizzle sql-js database handle plus an optional
 * `markDirty` callback (e.g. `() => markDirty(config)` from db/client.js) that
 * is invoked after every successful write so the debounced flush can persist.
 */
export class SqliteEventStore implements EventStore {
  constructor(
    private readonly db: SQLJsDatabase<typeof schema>,
    private readonly markDirty?: () => void,
  ) {}

  /** Append a single event. Duplicate (runId, seq) is idempotent (swallowed). */
  async append(event: AgentEvent): Promise<void> {
    const persisted = upsertEvent(this.db, event);
    if (persisted) this.markDirty?.();
  }

  /** Append multiple events sequentially (sql.js has no sync transaction helper). */
  async appendBatch(eventsToAppend: AgentEvent[]): Promise<void> {
    if (eventsToAppend.length === 0) return;
    for (const event of eventsToAppend) {
      const persisted = upsertEvent(this.db, event);
      if (persisted) this.markDirty?.();
    }
  }

  /**
   * Append a packed row — multiple delta sub-events collapsed into ONE
   * physical row (chunk packing §16). The physical row keeps the LAST
   * sub-event's seq/type; the `packed` column preserves every sub-event for
   * expansion on read (replay/afterSeq still see the full logical stream).
   */
  async appendPacked(
    runId: string,
    chunks: PackedChunk[],
    eventType: AgentEvent['type'],
  ): Promise<void> {
    const last = chunks[chunks.length - 1];
    this.db
      .insert(events)
      .values({
        id: `pack-${runId}-${last.eventId}`,
        runId,
        seq: last.seq,
        eventType,
        eventVersion: 2,
        payload: JSON.stringify({
          eventId: last.eventId,
          sessionId: runId,
          runId,
          timestamp: last.timestamp,
          seq: last.seq,
          type: eventType,
          version: 2,
          payload: { content: last.content ?? '' },
        } as AgentEvent),
        packed: JSON.stringify(chunks),
        createdAt: last.timestamp,
      })
      .run();
    this.markDirty?.();
  }

  /** List all events for a runId, ordered by seq ascending. */
  async list(runId: string): Promise<AgentEvent[]> {
    const rows = this.db
      .select()
      .from(events)
      .where(eq(events.runId, runId))
      .orderBy(asc(events.seq))
      .all();
    return this.#rowsToEvents(rows);
  }

  /** List events for a runId with seq > afterSeq, optionally limited. */
  async listAfter(runId: string, seq: number, limit?: number): Promise<AgentEvent[]> {
    const baseQuery = this.db
      .select()
      .from(events)
      .where(and(eq(events.runId, runId), gt(events.seq, seq)))
      .orderBy(asc(events.seq));

    if (limit !== undefined && limit > 0) {
      return this.#rowsToEvents(baseQuery.limit(limit).all());
    }
    return this.#rowsToEvents(baseQuery.all());
  }

  /** Get a single event by runId + eventId. */
  async get(runId: string, eventId: string): Promise<AgentEvent | undefined> {
    const row = this.db
      .select()
      .from(events)
      .where(and(eq(events.runId, runId), eq(events.id, eventId)))
      .get();
    if (!row) return undefined;
    return this.#rowToEvent(row);
  }

  /** Count events for a runId. */
  async count(runId: string): Promise<number> {
    const row = this.db
      .select({ count: sql<number>`count(*)` })
      .from(events)
      .where(eq(events.runId, runId))
      .get();
    return Number(row?.count ?? 0);
  }

  /** Get the latest event (max seq) for a runId. */
  async latest(runId: string): Promise<AgentEvent | undefined> {
    const row = this.db
      .select()
      .from(events)
      .where(eq(events.runId, runId))
      .orderBy(desc(events.seq))
      .limit(1)
      .get();
    if (!row) return undefined;
    return this.#rowToEvent(row);
  }

  /**
   * Map rows to events, expanding packed rows into their sub-events and
   * dropping rows whose payload JSON is corrupt (warn).
   */
  #rowsToEvents(rows: EventRow[]): AgentEvent[] {
    const result: AgentEvent[] = [];
    for (const row of rows) {
      // Packed row: expand into the original sub-event stream (§16 replay guarantee)
      if (row.packed) {
        const chunks = unpackPackedPayload(row.packed, row.seq);
        for (const chunk of chunks) {
          result.push({
            eventId: chunk.eventId,
            sessionId: row.runId,
            runId: row.runId,
            timestamp: chunk.timestamp,
            seq: chunk.seq,
            type: chunk.type,
            version: 2,
            payload: { content: chunk.content ?? '' },
          } as AgentEvent);
        }
        continue;
      }
      const event = this.#rowToEvent(row);
      if (event !== undefined) result.push(event);
    }
    return result;
  }

  /** Parse a single row's payload back into an AgentEvent, or skip on corrupt JSON. */
  #rowToEvent(row: EventRow): AgentEvent | undefined {
    try {
      return JSON.parse(row.payload) as AgentEvent;
    } catch (err) {
      console.warn(
        `[EventStore] skipping row with invalid payload JSON: id=${row.id} run=${row.runId} seq=${row.seq}`,
        (err as Error).message,
      );
      return undefined;
    }
  }
}
