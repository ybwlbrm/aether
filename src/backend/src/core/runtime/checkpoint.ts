/**
 * Checkpoint — Aether 2.0 Run/Task state serialization.
 *
 * Provides versioned checkpoint serialization/deserialization for run state persistence.
 * Transport-agnostic: no Fastify, no SSE, no React, no zod-for-runtime deps.
 * Pure TypeScript only.
 */

import { RuntimeError } from '../errors/index.js';
import type { RunStatus } from './run.js';

/**
 * Checkpoint interface for run state persistence.
 */
export interface Checkpoint {
  /** Run identifier */
  runId: string;
  /** Current run status */
  status: RunStatus;
  /** Arbitrary state snapshot */
  state: Record<string, unknown>;
  /** Execution context */
  context: {
    /** Current task identifier (if any) */
    taskId?: string;
    /** Current agent identifier (if any) */
    agentId?: string;
  };
  /** ISO 8601 timestamp when checkpoint was created */
  timestamp: string;
  /** Monotonically increasing sequence number within the run */
  seq: number;
}

/**
 * Versioned checkpoint envelope for serialization.
 */
interface CheckpointEnvelope {
  /** Envelope version (current = 1) */
  v: 1;
  /** The checkpoint data */
  checkpoint: Checkpoint;
}

/**
 * Serializes a checkpoint to a versioned JSON string.
 *
 * @param cp - Checkpoint to serialize
 * @returns JSON string with version envelope
 */
export function serializeCheckpoint(cp: Checkpoint): string {
  const envelope: CheckpointEnvelope = {
    v: 1,
    checkpoint: cp,
  };
  return JSON.stringify(envelope);
}

/**
 * Deserializes a checkpoint from a JSON string.
 * Validates envelope version and required fields.
 *
 * @param raw - JSON string to deserialize
 * @returns Parsed Checkpoint
 * @throws {RuntimeError} If JSON is invalid, version mismatch, or required fields missing (code: 'INVALID_CHECKPOINT')
 */
export function deserializeCheckpoint(raw: string): Checkpoint {
  let envelope: CheckpointEnvelope;

  try {
    envelope = JSON.parse(raw) as CheckpointEnvelope;
  } catch {
    throw new RuntimeError('Invalid checkpoint: malformed JSON', {
      code: 'INVALID_CHECKPOINT',
      retryable: false,
    });
  }

  // Validate envelope version
  if (envelope.v !== 1) {
    throw new RuntimeError(`Invalid checkpoint: unsupported version ${envelope.v}`, {
      code: 'INVALID_CHECKPOINT',
      context: { version: envelope.v },
      retryable: false,
    });
  }

  const cp = envelope.checkpoint;

  // Validate required fields
  if (!cp || typeof cp !== 'object') {
    throw new RuntimeError('Invalid checkpoint: missing checkpoint object', {
      code: 'INVALID_CHECKPOINT',
      retryable: false,
    });
  }

  if (typeof cp.runId !== 'string' || cp.runId.length === 0) {
    throw new RuntimeError('Invalid checkpoint: missing or empty runId', {
      code: 'INVALID_CHECKPOINT',
      retryable: false,
    });
  }

  const validStatuses: RunStatus[] = [
    'created',
    'running',
    'waiting',
    'completed',
    'failed',
    'cancelled',
    'interrupted',
  ];
  if (!validStatuses.includes(cp.status)) {
    throw new RuntimeError(`Invalid checkpoint: invalid status ${cp.status}`, {
      code: 'INVALID_CHECKPOINT',
      context: { status: cp.status },
      retryable: false,
    });
  }

  if (!cp.state || typeof cp.state !== 'object' || Array.isArray(cp.state)) {
    throw new RuntimeError('Invalid checkpoint: missing or invalid state', {
      code: 'INVALID_CHECKPOINT',
      retryable: false,
    });
  }

  if (!cp.context || typeof cp.context !== 'object' || Array.isArray(cp.context)) {
    throw new RuntimeError('Invalid checkpoint: missing or invalid context', {
      code: 'INVALID_CHECKPOINT',
      retryable: false,
    });
  }

  if (typeof cp.timestamp !== 'string' || cp.timestamp.length === 0) {
    throw new RuntimeError('Invalid checkpoint: missing or empty timestamp', {
      code: 'INVALID_CHECKPOINT',
      retryable: false,
    });
  }

  // Validate timestamp is valid ISO 8601
  const timestampDate = new Date(cp.timestamp);
  if (isNaN(timestampDate.getTime())) {
    throw new RuntimeError('Invalid checkpoint: invalid timestamp format', {
      code: 'INVALID_CHECKPOINT',
      context: { timestamp: cp.timestamp },
      retryable: false,
    });
  }

  if (typeof cp.seq !== 'number' || !Number.isInteger(cp.seq) || cp.seq < 0) {
    throw new RuntimeError('Invalid checkpoint: missing or invalid seq', {
      code: 'INVALID_CHECKPOINT',
      context: { seq: cp.seq },
      retryable: false,
    });
  }

  return cp;
}

/**
 * Creates a new checkpoint with auto-generated timestamp.
 * Sequence number must be provided by caller (incremented externally).
 *
 * @param runId - Run identifier
 * @param status - Current run status
 * @param state - Arbitrary state snapshot
 * @param context - Optional execution context (taskId, agentId)
 * @param seq - Sequence number (caller-managed, monotonically increasing)
 * @returns New Checkpoint instance
 */
export function createCheckpoint(
  runId: string,
  status: RunStatus,
  state: Record<string, unknown>,
  context: { taskId?: string; agentId?: string } = {},
  seq: number
): Checkpoint {
  return {
    runId,
    status,
    state,
    context,
    timestamp: new Date().toISOString(),
    seq,
  };
}