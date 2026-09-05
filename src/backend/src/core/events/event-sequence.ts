/**
 * Aether 2.0 — Core Event Sequence Allocator
 *
 * Allocates monotonically increasing per-run sequence numbers.
 * Concurrency-safe by design: allocations are serialized through an internal
 * promise chain, so concurrent callers never observe or produce duplicate seq
 * values. This in-memory version owns no persistence — the atomic DB-backed
 * version arrives in Wave 5 (P3-03) with the real EventStore implementation.
 *
 * Pure TypeScript, no external deps.
 */

import { RuntimeError } from '../errors/index.js';

/** Options for SequenceAllocator */
export interface SequenceAllocatorOptions {
  /** First allocated sequence number for a fresh run (default: 1) */
  startAt?: number;
  /** Pre-seed per-run current sequence values (next allocate for a seeded run = seed + 1) */
  seed?: Map<string, number>;
}

/**
 * In-memory, race-safe per-run sequence allocator.
 *
 * @example
 * ```ts
 * const allocator = new SequenceAllocator();
 * const a = await allocator.allocate('run-1'); // 1
 * const b = await allocator.allocate('run-1'); // 2
 * ```
 */
export class SequenceAllocator {
  private readonly sequences: Map<string, number>;
  private readonly startAt: number;
  /** Serialization chain — each allocation is appended to this promise */
  private tail: Promise<number> = Promise.resolve(0);

  constructor(opts: SequenceAllocatorOptions = {}) {
    this.startAt = opts.startAt ?? 1;
    this.sequences = new Map(opts.seed);
  }

  /**
   * Atomically allocate the next sequence number for a run.
   *
   * Concurrent calls are serialized via the internal promise chain: every
   * allocation reads-and-increments inside its own chained task, so N
   * concurrent `allocate` calls always yield N distinct, gapless seq values.
   *
   * @throws RuntimeError with code INVALID_RUN_ID for an empty/blank runId
   */
  async allocate(runId: string): Promise<number> {
    if (runId.trim().length === 0) {
      throw new RuntimeError('Invalid run ID', { code: 'INVALID_RUN_ID' });
    }

    const next = this.tail.then(() => {
      const current = this.sequences.get(runId) ?? this.startAt - 1;
      const seq = current + 1;
      this.sequences.set(runId, seq);
      return seq;
    });
    // Keep the chain alive regardless of individual allocation outcomes
    this.tail = next.catch(() => 0);
    return next;
  }

  /** Return the highest allocated sequence for a run (0 if never allocated) */
  async getCurrent(runId: string): Promise<number> {
    return this.sequences.get(runId) ?? 0;
  }

  /** Clear the sequence state for a run — testing aid that resets the next seq to startAt */
  async reset(runId: string): Promise<void> {
    this.sequences.delete(runId);
  }
}