/**
 * Aether 2.0 — Core Event Projector
 *
 * Read-side projection over an AgentEvent stream. Projectors consume replayed
 * events in seq order; the registry manages projector lifecycle; `project()`
 * drives a full (or fromSeq) replay through every registered projector,
 * isolating projector errors so one failing projector cannot break others.
 *
 * No Fastify, SSE, or network imports — pure in-process read model.
 */

import type { AgentEvent } from '@pacc/shared';
import { RuntimeError } from '../errors/index.js';
import type { EventStore } from './event-store.js';

/** Read-side projection: consumes replayed events in seq order */
export interface Projector {
  /** Handle a single replayed event (called in seq ascending order) */
  handle(event: AgentEvent): void;
  /** Optional current projection state, useful for diagnostics/snapshots */
  getState?(): unknown;
}

/** Registry of named projectors with lifecycle management */
export class ProjectorRegistry {
  private readonly projectors = new Map<string, Projector>();

  /**
   * Register a projector under an id.
   * @throws RuntimeError with code PROJECTOR_EXISTS if id is already registered
   */
  register(id: string, projector: Projector): void {
    if (this.projectors.has(id)) {
      throw new RuntimeError('Projector already registered', { code: 'PROJECTOR_EXISTS' });
    }
    this.projectors.set(id, projector);
  }

  /** Remove a projector; returns true if it was registered */
  unregister(id: string): boolean {
    return this.projectors.delete(id);
  }

  /** Look up a projector by id (undefined if not registered) */
  get(id: string): Projector | undefined {
    return this.projectors.get(id);
  }

  /** List registered projector ids in registration order */
  list(): string[] {
    return [...this.projectors.keys()];
  }
}

/** Options for project() */
export interface ProjectOptions {
  /** Only replay events with seq > fromSeq */
  fromSeq?: number;
}

/**
 * Replay a run's events through every registered projector, in seq order.
 *
 * Errors thrown by a projector's handle() are caught and isolated per
 * projector: other projectors keep receiving every event, and the replay
 * itself never rejects due to a projector failure.
 */
export async function project(
  store: EventStore,
  runId: string,
  registry: ProjectorRegistry,
  opts: ProjectOptions = {},
): Promise<void> {
  const events =
    opts.fromSeq !== undefined
      ? await store.listAfter(runId, opts.fromSeq)
      : await store.list(runId);

  const projectors = registry
    .list()
    .map((id) => registry.get(id))
    .filter((p): p is Projector => p !== undefined);

  for (const event of events) {
    for (const projector of projectors) {
      try {
        projector.handle(event);
      } catch {
        // Projector errors are isolated — other projectors must keep replaying
      }
    }
  }
}