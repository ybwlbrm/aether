/**
 * Aether 2.0 — Core Event Bus
 *
 * Transport-agnostic event bus for AgentEvent distribution.
 * No Fastify, SSE, or network imports — pure in-process pub/sub.
 */

import type { AgentEvent } from '@pacc/shared';

/**
 * EventBus interface — transport-agnostic pub/sub for AgentEvent.
 *
 * Implementations must:
 * - Deliver events to all subscribers in emission order
 * - Not propagate subscriber errors (catch and log/ignore)
 * - Support multiple independent runId namespaces
 */
export interface EventBus {
  /** Emit an event to all subscribers and store it for the runId */
  emit(event: AgentEvent): void;

  /** Subscribe to all events. Returns an unsubscribe function. */
  subscribe(listener: (event: AgentEvent) => void): () => void;

  /** List all stored events for a runId, sorted by seq ascending */
  listEvents(runId: string): AgentEvent[];

  /** List events for a runId with seq > afterSeq, optionally limited */
  listEventsAfter(runId: string, afterSeq: number, limit?: number): AgentEvent[];
}

/**
 * In-memory EventBus implementation.
 *
 * Storage: Map<runId, AgentEvent[]> — events kept sorted by seq.
 * Subscribers: Set of listener functions — notified on each emit.
 * Errors in subscribers are caught and ignored (non-propagating).
 */
export function createInMemoryEventBus(): EventBus {
  const storage = new Map<string, AgentEvent[]>();
  const subscribers = new Set<(event: AgentEvent) => void>();

  function emit(event: AgentEvent): void {
    // Store event
    const runEvents = storage.get(event.runId) ?? [];
    runEvents.push(event);
    // Keep sorted by seq (insertion should already be ordered, but defend)
    runEvents.sort((a, b) => a.seq - b.seq);
    storage.set(event.runId, runEvents);

    // Notify subscribers (catch errors to prevent propagation)
    for (const listener of subscribers) {
      try {
        listener(event);
      } catch {
        // Subscriber errors must not propagate — per interface contract
      }
    }
  }

  function subscribe(listener: (event: AgentEvent) => void): () => void {
    subscribers.add(listener);
    return () => {
      subscribers.delete(listener);
    };
  }

  function listEvents(runId: string): AgentEvent[] {
    const events = storage.get(runId);
    if (!events) return [];
    // Return a copy to prevent external mutation
    return [...events];
  }

  function listEventsAfter(runId: string, afterSeq: number, limit?: number): AgentEvent[] {
    const events = storage.get(runId);
    if (!events) return [];

    const filtered = events.filter((e) => e.seq > afterSeq);
    if (limit !== undefined && limit > 0) {
      return filtered.slice(0, limit);
    }
    return filtered;
  }

  return {
    emit,
    subscribe,
    listEvents,
    listEventsAfter,
  };
}