/**
 * Aether 2.0 — Core Chunk Packing (P3-07)
 *
 * Packs high-frequency delta events (message/reasoning/output deltas) into a
 * single physical row to cut row count, while preserving the logical event
 * stream: packed rows carry the original sub-events in metadata/packed JSON,
 * and unpacking on read restores the exact event sequence (eventId + seq).
 *
 * Guarantees (refactor plan §16):
 * - Real-time SSE unaffected (packing happens only at the storage layer)
 * - eventId/seq never lost — each packed sub-event keeps its own identity
 * - Replay can fully expand packed rows via unpack()
 * - Packing does not affect event ordering (last sub-event's seq = row seq)
 * - Flush happens before run completion and on close
 *
 * No Fastify/SSE imports — pure TypeScript helpers.
 */

import type { AgentEvent } from '@pacc/shared';
import type { EventStore } from './event-store.js';

/** Packable v2 event types — the same three high-frequency deltas as legacy */
export const PACKABLE_EVENT_TYPES = new Set<AgentEvent['type']>([
  'agent.reasoning.delta',
  'agent.message.delta',
  'agent.output.delta',
]);

/** Pack threshold: max 96 sub-events or 24KB content per physical row */
export const PACK_MAX_CHUNKS = 96;
export const PACK_MAX_BYTES = 24 * 1024;

/** A single packed sub-event (identity + content preserved) */
export interface PackedChunk {
  eventId: string;
  seq: number;
  type: AgentEvent['type'];
  content?: string;
  timestamp: string;
}

/** Whether an event type should be aggregated into packs */
export function isPackable(type: AgentEvent['type'], persist: boolean): boolean {
  return persist && PACKABLE_EVENT_TYPES.has(type);
}

/** Accumulate a chunk into the pending buffer keyed by runId */
export function queuePack(
  pending: Map<string, PackedChunk[]>,
  runId: string,
  event: AgentEvent,
): void {
  let chunks = pending.get(runId);
  if (!chunks) {
    chunks = [];
    pending.set(runId, chunks);
  }
  chunks.push({
    eventId: event.eventId,
    seq: event.seq,
    type: event.type,
    content: (event.payload as { content?: string } | undefined)?.content ?? '',
    timestamp: event.timestamp,
  });
}

/** Check whether a buffer reached the pack threshold */
export function shouldFlushPack(chunks: PackedChunk[]): boolean {
  const bytes = chunks.reduce((sum, c) => sum + (c.content?.length ?? 0), 0);
  return chunks.length >= PACK_MAX_CHUNKS || bytes >= PACK_MAX_BYTES;
}

/**
 * Build the JSON stored in the events.packed column for a packed row.
 * The physical row keeps the LAST sub-event's seq/eventType; the packed
 * payload preserves all sub-events for expansion on read.
 */
export function buildPackedPayload(chunks: PackedChunk[]): string {
  return JSON.stringify(chunks);
}

/**
 * Expand a packed row back into the original logical events.
 * Returns [] when the row is not packed (payload not an array).
 */
export function unpackPackedPayload(
  packedJson: string | null | undefined,
  rowSeq: number,
): PackedChunk[] {
  if (!packedJson) return [];
  try {
    const parsed = JSON.parse(packedJson) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (c): c is PackedChunk =>
        c !== null &&
        typeof c === 'object' &&
        typeof (c as PackedChunk).eventId === 'string' &&
        typeof (c as PackedChunk).seq === 'number',
    );
  } catch {
    // Fallback: treat a non-array packed column as an empty pack
    void rowSeq;
    return [];
  }
}

/**
 * Choose a physical seq for a packed row: the LAST sub-event's seq keeps
 * ordering consistent with the logical stream.
 */
export function packedRowSeq(chunks: PackedChunk[]): number {
  return chunks[chunks.length - 1]?.seq ?? 0;
}

/**
 * Flush a run's pending pack buffer into the store as ONE physical row
 * (chunk packing, §16). When the store supports `appendPacked` (SQLite impl)
 * the sub-events are written with their identities preserved in the packed
 * JSON; otherwise the caller falls back to per-event appends so the logical
 * stream is never lost.
 *
 * Returns the number of sub-events flushed (0 when nothing pending).
 */
export async function flushPacks(
  store: EventStore,
  pending: Map<string, PackedChunk[]>,
  runId: string,
): Promise<number> {
  const chunks = pending.get(runId);
  if (!chunks || chunks.length === 0) return 0;
  pending.delete(runId);

  if (store.appendPacked) {
    await store.appendPacked(runId, chunks, chunks[chunks.length - 1].type);
    return chunks.length;
  }

  // Fallback: no packing support — append each sub-event individually
  for (const chunk of chunks) {
    await store.append({
      eventId: chunk.eventId,
      sessionId: runId,
      runId,
      timestamp: chunk.timestamp,
      seq: chunk.seq,
      type: chunk.type,
      version: 2,
      payload: { content: chunk.content ?? '' },
    } as AgentEvent);
  }
  return chunks.length;
}