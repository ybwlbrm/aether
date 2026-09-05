/**
 * Aether 2.0 — Core Event Replay
 *
 * Deterministic event replay for AgentEvent streams.
 * Reads via the EventStore only; returns events ordered by seq ascending.
 * Supports both array-based replay and memory-constant streaming replay.
 * No Fastify, SSE, or network imports — pure in-process helpers.
 */

import type { AgentEvent } from '@pacc/shared';
import type { EventStore } from './event-store.js';

/** Options for replayFrom */
export interface EventReplayOptions {
  /** Maximum number of events to return (applied at the store read) */
  limit?: number;
  /** Only include events whose type is in this set */
  eventTypes?: AgentEvent['type'][];
}

/** Options for streaming replay */
export interface StreamingReplayOptions {
  /** Only include events whose type is in this set */
  eventTypes?: AgentEvent['type'][];
}

/** Sort events by seq ascending — defensive copy, store contract already guarantees order */
function sortBySeq(events: AgentEvent[]): AgentEvent[] {
  return [...events].sort((a, b) => a.seq - b.seq);
}

/**
 * Replay the full event stream for a run, ordered by seq ascending.
 * Returns [] for unknown or empty runs.
 */
export async function replay(runId: string, store: EventStore): Promise<AgentEvent[]> {
  const events = await store.list(runId);
  return sortBySeq(events);
}

/**
 * Replay events for a run with seq > the given seq, optionally filtered.
 *
 * The optional limit is applied at the store read and the eventTypes filter
 * runs on the returned slice, so the result is always <= limit events.
 */
export async function replayFrom(
  runId: string,
  seq: number,
  store: EventStore,
  opts: EventReplayOptions = {},
): Promise<AgentEvent[]> {
  const events = await store.listAfter(runId, seq, opts.limit);

  const allowed = new Set<AgentEvent['type']>(opts.eventTypes ?? []);
  const filtered = allowed.size === 0 ? events : events.filter((e) => allowed.has(e.type));

  return sortBySeq(filtered);
}

/**
 * Streaming replay — yields a run's events in seq order with constant memory.
 *
 * Pages through the store with listAfter() using a fixed page size and
 * advances the cursor by the highest seq seen on each page, so the whole
 * run never has to be buffered at once. Optional eventTypes filter is
 * applied per event as the stream advances.
 *
 * Suitable for driving SSE reconnection or feeding projectors without
 * holding the full run in memory.
 */
export async function* replayStream(
  runId: string,
  store: EventStore,
  opts: StreamingReplayOptions = {},
): AsyncGenerator<AgentEvent> {
  const allowed = new Set<AgentEvent['type']>(opts.eventTypes ?? []);
  const PAGE_SIZE = 500;
  let afterSeq = 0;

  for (;;) {
    const page = await store.listAfter(runId, afterSeq, PAGE_SIZE);
    if (page.length === 0) return;

    const sorted = sortBySeq(page);
    for (const event of sorted) {
      if (allowed.size === 0 || allowed.has(event.type)) {
        yield event;
      }
      if (event.seq > afterSeq) afterSeq = event.seq;
    }

    // Fewer than a full page means we've reached the end of the run
    if (page.length < PAGE_SIZE) return;
  }
}