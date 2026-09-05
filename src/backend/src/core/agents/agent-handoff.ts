/**
 * Agent Handoff — Aether 2.0 Handoff Protocol (P1-25)
 *
 * Request/accept/reject lifecycle for transferring work between agents.
 * Requests are recorded in an in-memory log; the DB-backed version lands later.
 *
 * Transport-agnostic: no Fastify, no SSE, no React — pure TypeScript.
 */

import { randomUUID } from 'node:crypto';
import { RuntimeError } from '../errors/index.js';

/** Payload describing a handoff request between two agents */
export interface HandoffPayload {
  /** Agent initiating the handoff */
  fromAgentId: string;
  /** Agent receiving the handoff */
  toAgentId: string;
  /** Optional task being transferred */
  taskId?: string;
  /** Human-readable reason for the handoff */
  reason: string;
  /** Optional structured context to pass along */
  context?: Record<string, unknown>;
}

/** Status of a handoff request */
export type HandoffStatus = 'requested' | 'accepted' | 'rejected';

/** A recorded handoff: payload + lifecycle fields */
export type HandoffRecord = HandoffPayload & {
  id: string;
  status: HandoffStatus;
  createdAt: string;
  acceptedAt?: string;
  rejectReason?: string;
};

/**
 * Handoff protocol implementation (in-memory log).
 *
 * request() creates a 'requested' record; accept()/reject() transition it to
 * a terminal state. Unknown ids throw RuntimeError HANDOFF_NOT_FOUND.
 */
export class HandoffProtocol {
  private readonly records: HandoffRecord[] = [];

  /**
   * Records a new handoff request.
   *
   * @param payload - Handoff details (id/status/createdAt are auto-assigned)
   */
  request(payload: HandoffPayload): void {
    const record: HandoffRecord = {
      ...payload,
      id: randomUUID(),
      status: 'requested',
      createdAt: new Date().toISOString(),
    };
    this.records.push(record);
  }

  /**
   * Accepts a pending handoff request.
   *
   * @param payloadId - Handoff record id
   * @returns The updated record
   * @throws RuntimeError HANDOFF_NOT_FOUND if the id is unknown
   */
  accept(payloadId: string): HandoffRecord {
    const record = this.#find(payloadId);
    record.status = 'accepted';
    record.acceptedAt = new Date().toISOString();
    return { ...record };
  }

  /**
   * Rejects a pending handoff request.
   *
   * @param payloadId - Handoff record id
   * @param reason - Optional rejection reason
   * @throws RuntimeError HANDOFF_NOT_FOUND if the id is unknown
   */
  reject(payloadId: string, reason?: string): void {
    const record = this.#find(payloadId);
    record.status = 'rejected';
    if (reason !== undefined) record.rejectReason = reason;
  }

  /** Returns all handoff records in creation order (copies) */
  list(): HandoffRecord[] {
    return this.records.map((r) => ({ ...r }));
  }

  #find(payloadId: string): HandoffRecord {
    const record = this.records.find((r) => r.id === payloadId);
    if (record === undefined) {
      throw new RuntimeError(`handoff request not found: ${payloadId}`, {
        code: 'HANDOFF_NOT_FOUND',
        retryable: false,
        context: { payloadId },
      });
    }
    return record;
  }
}