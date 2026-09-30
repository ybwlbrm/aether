/**
 * Artifact Runtime Bridge — Aether 2.0 Phase 8 migration seam
 *
 * Registers generated files (documents/media/exports produced by the legacy
 * modules) into the NEW core ArtifactStore so ArtifactRuntime can list,
 * retrieve and group them by run/task/agent — without moving or duplicating
 * the underlying files (Adapter pattern, §2.1 不推倒重来).
 *
 * The bridge computes size/hash from the on-disk file and writes an
 * ArtifactRecord into the store; the legacy modules keep writing their own
 * DB rows as before.
 *
 * Pure TypeScript — no Fastify/SSE/React imports.
 */

import { statSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import type {
  ArtifactStore,
  CreateArtifactInput,
  ArtifactRecord,
} from '../core/artifacts/index.js';

/**
 * Register a file on disk as an artifact in the core store.
 * Computes size + sha256 hash from the file; returns the stored record.
 *
 * @param store - Core ArtifactStore (InMemoryArtifactStore or a future DB store)
 * @param input - Artifact metadata (name/mimeType/path/runId/taskId/agentId)
 * @returns The registered ArtifactRecord
 */
export function registerFileArtifact(
  store: ArtifactStore,
  input: Omit<CreateArtifactInput, 'size'> & { path: string; size?: number },
): Promise<ArtifactRecord> {
  const size = input.size ?? statSync(input.path).size;
  const hash = sha256(input.path);
  return store.put({
    ...input,
    size,
    hash,
  });
}

/** Compute a sha256 hex digest of a file on disk */
export function sha256(filePath: string): string {
  const data = readFileSync(filePath);
  return createHash('sha256').update(data).digest('hex');
}

/**
 * Build a core ArtifactStore pre-populated from an array of existing file
 * records (e.g. documents/media DB rows that carry a path). Skips files
 * that no longer exist on disk.
 *
 * @param store - Target core store
 * @param entries - Existing records with at least name/mimeType/path
 * @returns Number of artifacts registered
 */
export async function registerExistingFiles(
  store: ArtifactStore,
  entries: Array<{
    name: string;
    mimeType: string;
    path: string;
    runId?: string;
    taskId?: string;
    agentId?: string;
  }>,
): Promise<number> {
  let count = 0;
  for (const entry of entries) {
    try {
      // statSync throws for missing files — skip those
      const size = statSync(entry.path).size;
      await registerFileArtifact(store, { ...entry, size });
      count += 1;
    } catch {
      // File missing or unreadable — skip silently
    }
  }
  return count;
}

/**
 * Convenience: build an ArtifactRuntime wired to a fresh in-memory store and
 * register existing generated files into it. Returns both for callers that
 * need the runtime and the store.
 */
export async function buildArtifactRuntimeWithFiles(
  files: Array<{ name: string; mimeType: string; path: string }>,
): Promise<{ runtime: import('../core/artifacts/index.js').ArtifactRuntime; store: ArtifactStore; count: number }> {
  const { ArtifactRuntime } = await import('../core/artifacts/index.js');
  const store: ArtifactStore = new (await import('../core/artifacts/index.js')).InMemoryArtifactStore();
  const count = await registerExistingFiles(store, files);
  const runtime = new ArtifactRuntime(store, 'artifact-runtime');
  return { runtime, store, count };
}