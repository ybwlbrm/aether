/**
 * Artifact Runtime — Runtime for artifact management operations.
 *
 * Extends the base Runtime with artifact CRUD operations.
 * Emits 'artifact.created' events on artifact creation.
 * Pure TypeScript, no external dependencies.
 */

import { Runtime, type RuntimeEvent } from '../runtime/runtime.js';
import { RuntimeError } from '../errors/index.js';
import type { ArtifactRecord, CreateArtifactInput, ArtifactStore, ArtifactListFilter } from './artifact-store.js';

/**
 * Event emitted when an artifact is created.
 */
export interface ArtifactCreatedEvent extends RuntimeEvent {
  type: 'artifact.created';
  payload: ArtifactRecord;
}

/**
 * Artifact runtime extending base Runtime with artifact operations.
 */
export class ArtifactRuntime extends Runtime {
  #store: ArtifactStore;

  /**
   * Creates a new ArtifactRuntime.
   * @param store - Artifact store implementation
   * @param name - Optional runtime name
   */
  constructor(store: ArtifactStore, name?: string) {
    super(name);
    this.#store = store;
  }

  /**
   * Gets the underlying artifact store.
   */
  get store(): ArtifactStore {
    return this.#store;
  }

  /**
   * Creates a new artifact.
   * Requires runtime to be in running state.
   * @param input - Artifact creation input
   * @returns The created artifact record
   * @throws {RuntimeError} If runtime is not running
   */
  async createArtifact(input: CreateArtifactInput): Promise<ArtifactRecord> {
    if (!this.isRunning) {
      throw new RuntimeError('ArtifactRuntime not running', {
        code: 'RUNTIME_NOT_RUNNING',
        context: { name: this.name, state: this.state },
        retryable: false,
      });
    }

    const artifact = await this.#store.put(input);

    this.emit({
      type: 'artifact.created',
      payload: artifact,
    });

    return artifact;
  }

  /**
   * Retrieves an artifact by ID.
   * @param id - Artifact identifier
   * @returns The artifact record or undefined if not found
   */
  async getArtifact(id: string): Promise<ArtifactRecord | undefined> {
    return this.#store.get(id);
  }

  /**
   * Lists artifacts with optional filtering.
   * Results ordered by createdAt descending (newest first).
   * @param filter - Optional filter criteria
   * @returns Array of matching artifact records
   */
  async listArtifacts(filter?: ArtifactListFilter): Promise<ArtifactRecord[]> {
    return this.#store.list(filter);
  }

  /**
   * Called when runtime is starting.
   * No-op by default - override in subclasses if needed.
   */
  protected override onStart(): void | Promise<void> {
    // No initialization needed for artifact runtime
  }

  /**
   * Called when runtime is stopping.
   * No-op by default - override in subclasses if needed.
   */
  protected override onStop(): void | Promise<void> {
    // No cleanup needed for artifact runtime
  }
}