/**
 * Artifact Store — Storage abstraction for artifacts.
 *
 * Provides interface and in-memory implementation for artifact persistence.
 * Pure TypeScript, no external dependencies.
 */

import { randomUUID } from 'node:crypto';

/**
 * Artifact record representing a stored artifact.
 */
export interface ArtifactRecord {
  /** Unique identifier (UUID v4) */
  id: string;
  /** Optional run identifier for grouping */
  runId?: string;
  /** Optional task identifier for grouping */
  taskId?: string;
  /** Optional agent identifier that created the artifact */
  agentId?: string;
  /** Human-readable name */
  name: string;
  /** MIME type of the artifact content */
  mimeType: string;
  /** Optional filesystem path (if stored on disk) */
  path?: string;
  /** Size in bytes */
  size: number;
  /** Optional content hash (e.g., SHA-256) */
  hash?: string;
  /** Creation timestamp (ms since epoch) */
  createdAt: number;
  /** Optional arbitrary metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Input for creating a new artifact (without auto-generated fields).
 */
export interface CreateArtifactInput {
  /** Optional run identifier for grouping */
  runId?: string;
  /** Optional task identifier for grouping */
  taskId?: string;
  /** Optional agent identifier that created the artifact */
  agentId?: string;
  /** Human-readable name */
  name: string;
  /** MIME type of the artifact content */
  mimeType: string;
  /** Optional filesystem path (if stored on disk) */
  path?: string;
  /** Size in bytes */
  size: number;
  /** Optional content hash (e.g., SHA-256) */
  hash?: string;
  /** Optional arbitrary metadata */
  metadata?: Record<string, unknown>;
}

/**
 * Filter options for listing artifacts.
 */
export interface ArtifactListFilter {
  /** Filter by run identifier */
  runId?: string;
  /** Filter by agent identifier */
  agentId?: string;
}

/**
 * Artifact store interface for persistence operations.
 */
export interface ArtifactStore {
  /**
   * Stores a new artifact.
   * @param input - Artifact data without id/createdAt (auto-generated)
   * @returns The stored artifact record with id and createdAt populated
   */
  put(input: CreateArtifactInput): Promise<ArtifactRecord>;

  /**
   * Retrieves an artifact by ID.
   * @param id - Artifact identifier
   * @returns The artifact record or undefined if not found
   */
  get(id: string): Promise<ArtifactRecord | undefined>;

  /**
   * Deletes an artifact by ID.
   * @param id - Artifact identifier
   * @returns true if deleted, false if not found
   */
  delete(id: string): Promise<boolean>;

  /**
   * Lists artifacts with optional filtering.
   * Results ordered by createdAt descending (newest first).
   * @param filter - Optional filter criteria
   * @returns Array of matching artifact records
   */
  list(filter?: ArtifactListFilter): Promise<ArtifactRecord[]>;
}

/**
 * In-memory implementation of ArtifactStore.
 * Uses a Map for storage. Suitable for testing and development.
 */
export class InMemoryArtifactStore implements ArtifactStore {
  #store: Map<string, ArtifactRecord> = new Map();

  async put(input: CreateArtifactInput): Promise<ArtifactRecord> {
    const id = randomUUID();
    const createdAt = Date.now();
    const record: ArtifactRecord = {
      ...input,
      id,
      createdAt,
    };
    this.#store.set(id, record);
    return record;
  }

  async get(id: string): Promise<ArtifactRecord | undefined> {
    return this.#store.get(id);
  }

  async delete(id: string): Promise<boolean> {
    return this.#store.delete(id);
  }

  async list(filter?: ArtifactListFilter): Promise<ArtifactRecord[]> {
    let results = Array.from(this.#store.values());

    if (filter?.runId) {
      results = results.filter((artifact) => artifact.runId === filter.runId);
    }
    if (filter?.agentId) {
      results = results.filter((artifact) => artifact.agentId === filter.agentId);
    }

    // Sort by createdAt descending (newest first)
    results.sort((a, b) => b.createdAt - a.createdAt);
    return results;
  }
}