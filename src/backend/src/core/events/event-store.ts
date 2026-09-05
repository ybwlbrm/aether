/**
 * Aether 2.0 — Core Event Store
 *
 * Transport-agnostic event persistence interface for AgentEvent.
 * In-memory implementation provided; SQLite-backed impl lands in Wave 5 (P3-02).
 */

import type { AgentEvent } from '@pacc/shared';
import type { PackedChunk } from './chunk-packer.js';

/** EventStoreEvent is an alias for AgentEvent — kept for semantic clarity in store context */
export type EventStoreEvent = AgentEvent;

/**
 * EventStore interface — async persistence for AgentEvent.
 *
 * All methods are async to accommodate future SQLite/DB implementations.
 * Implementations must maintain events sorted by seq per runId.
 */
export interface EventStore {
  /** Append a single event */
  append(event: AgentEvent): Promise<void>;

  /** Append multiple events in a single batch */
  appendBatch(events: AgentEvent[]): Promise<void>;

  /** List all events for a runId, sorted by seq ascending */
  list(runId: string): Promise<AgentEvent[]>;

  /** List events for a runId with seq > afterSeq, optionally limited */
  listAfter(runId: string, seq: number, limit?: number): Promise<AgentEvent[]>;

  /** Get a single event by runId and eventId */
  get(runId: string, eventId: string): Promise<AgentEvent | undefined>;

  /** Count events for a runId */
  count(runId: string): Promise<number>;

  /** Get the latest event (max seq) for a runId */
  latest(runId: string): Promise<AgentEvent | undefined>;

  /**
   * Append a packed row — multiple sub-events collapsed into one physical
   * row (chunk packing, §16). Implementations that support packing store the
   * sub-events in the row's `packed` JSON and expand them on read. This is
   * OPTIONAL: stores without packing (e.g. the in-memory one) leave it
   * unimplemented and callers fall back to per-event appends.
   */
  appendPacked?(runId: string, chunks: PackedChunk[], eventType: AgentEvent['type']): Promise<void>;
}

/**
 * In-memory EventStore implementation.
 *
 * Storage: Map<runId, AgentEvent[]> — events kept sorted by seq.
 * All operations are async for interface consistency with future DB impls.
 */
export class InMemoryEventStore implements EventStore {
  private readonly storage = new Map<string, AgentEvent[]>();

  private getRunEvents(runId: string): AgentEvent[] {
    return this.storage.get(runId) ?? [];
  }

  private setRunEvents(runId: string, events: AgentEvent[]): void {
    // Keep sorted by seq
    const sorted = [...events].sort((a, b) => a.seq - b.seq);
    this.storage.set(runId, sorted);
  }

  async append(event: AgentEvent): Promise<void> {
    const events = this.getRunEvents(event.runId);
    events.push(event);
    this.setRunEvents(event.runId, events);
  }

  async appendBatch(events: AgentEvent[]): Promise<void> {
    if (events.length === 0) return;

    // Group by runId for efficiency
    const byRunId = new Map<string, AgentEvent[]>();
    for (const event of events) {
      const runEvents = byRunId.get(event.runId) ?? [];
      runEvents.push(event);
      byRunId.set(event.runId, runEvents);
    }

    // Merge with existing storage per runId
    for (const [runId, newEvents] of byRunId) {
      const existing = this.getRunEvents(runId);
      const merged = [...existing, ...newEvents];
      this.setRunEvents(runId, merged);
    }
  }

  async list(runId: string): Promise<AgentEvent[]> {
    const events = this.getRunEvents(runId);
    // Return a copy to prevent external mutation
    return [...events];
  }

  async listAfter(runId: string, seq: number, limit?: number): Promise<AgentEvent[]> {
    const events = this.getRunEvents(runId);
    const filtered = events.filter((e) => e.seq > seq);
    if (limit !== undefined && limit > 0) {
      return filtered.slice(0, limit);
    }
    return filtered;
  }

  async get(runId: string, eventId: string): Promise<AgentEvent | undefined> {
    const events = this.getRunEvents(runId);
    return events.find((e) => e.eventId === eventId);
  }

  async count(runId: string): Promise<number> {
    const events = this.getRunEvents(runId);
    return events.length;
  }

  async latest(runId: string): Promise<AgentEvent | undefined> {
    const events = this.getRunEvents(runId);
    if (events.length === 0) return undefined;
    // Events are kept sorted by seq, so last is max seq
    return events[events.length - 1];
  }
}