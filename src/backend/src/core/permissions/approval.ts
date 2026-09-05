/**
 * Approval Manager — Core Permissions Approval Workflow (P1-35)
 *
 * In-memory approval request tracking and decision workflow.
 * Lifecycle: pending → approved | rejected | expired (terminal states).
 *
 * The DB-backed implementation lands in a later wave; this module is
 * transport-agnostic pure TypeScript with zero new dependencies.
 */

import { randomUUID } from 'node:crypto';
import type { Capability } from './capability.js';
import { RuntimeError } from '../errors/index.js';

/** Lifecycle status of an approval request (terminal: approved | rejected | expired) */
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired';

/** A request to approve (or reject) use of a capability */
export interface ApprovalRequest {
  id: string;
  capability: Capability;
  runId?: string;
  taskId?: string;
  agentId?: string;
  toolCallId?: string;
  reason: string;
  status: ApprovalStatus;
  createdAt: string;
  decidedAt?: string;
  decidedBy?: string;
  autoApprove: boolean;
}

/** Input shape for creating a request; id/status/createdAt/autoApprove are supplied by the manager */
export type ApprovalRequestInput = Omit<
  ApprovalRequest,
  'id' | 'status' | 'createdAt' | 'autoApprove'
> & {
  autoApprove?: boolean;
  /** Overridable for testability (e.g. for forging a stale createdAt). Defaults to now. */
  createdAt?: string;
};

/** A human (or policy) decision applied to a pending request */
export interface ApprovalDecision {
  decision: 'approved' | 'rejected';
  decidedBy?: string;
}

/**
 * In-memory approval manager.
 *
 * - `request()` creates a pending request (uuid + createdAt) and, when
 *   `autoApprove` is set, immediately approves it.
 * - `decide()` transitions a pending request to a terminal state.
 * - `expireOld()` marks stale pending requests as expired.
 */
export class ApprovalManager {
  private readonly requests = new Map<string, ApprovalRequest>();

  request(input: ApprovalRequestInput): ApprovalRequest {
    const createdAt = input.createdAt ?? new Date().toISOString();
    const request: ApprovalRequest = {
      id: randomUUID(),
      capability: input.capability,
      reason: input.reason,
      status: 'pending',
      createdAt,
      autoApprove: input.autoApprove ?? false,
    };
    if (input.runId !== undefined) request.runId = input.runId;
    if (input.taskId !== undefined) request.taskId = input.taskId;
    if (input.agentId !== undefined) request.agentId = input.agentId;
    if (input.toolCallId !== undefined) request.toolCallId = input.toolCallId;

    this.requests.set(request.id, request);
    if (request.autoApprove) {
      this.applyDecision(request, { decision: 'approved' });
    }
    return { ...request };
  }

  decide(id: string, decision: ApprovalDecision): ApprovalRequest {
    const request = this.requests.get(id);
    if (request === undefined) {
      throw new RuntimeError(`approval request not found: ${id}`, {
        code: 'APPROVAL_NOT_FOUND',
        retryable: false,
        context: { id },
      });
    }
    if (request.status !== 'pending') {
      throw new RuntimeError(`approval request already decided: ${id}`, {
        code: 'APPROVAL_ALREADY_DECIDED',
        retryable: false,
        context: { id, status: request.status },
      });
    }
    this.applyDecision(request, decision);
    return { ...request };
  }

  /** All requests currently awaiting a decision (copies; mutation-safe for callers) */
  listPending(): ApprovalRequest[] {
    const pending: ApprovalRequest[] = [];
    for (const request of this.requests.values()) {
      if (request.status === 'pending') pending.push({ ...request });
    }
    return pending;
  }

  get(id: string): ApprovalRequest | undefined {
    const request = this.requests.get(id);
    return request === undefined ? undefined : { ...request };
  }

  /**
   * Marks pending requests older than `olderThanMs` as expired.
   *
   * @param olderThanMs - Max age in milliseconds a pending request may be kept
   * @returns The number of requests expired by this call
   */
  expireOld(olderThanMs: number): number {
    const cutoff = Date.now() - olderThanMs;
    let expiredCount = 0;
    for (const request of this.requests.values()) {
      if (request.status !== 'pending') continue;
      if (Date.parse(request.createdAt) < cutoff) {
        request.status = 'expired';
        expiredCount += 1;
      }
    }
    return expiredCount;
  }

  countPending(): number {
    let count = 0;
    for (const request of this.requests.values()) {
      if (request.status === 'pending') count += 1;
    }
    return count;
  }

  private applyDecision(request: ApprovalRequest, decision: ApprovalDecision): void {
    if (decision.decidedBy !== undefined) request.decidedBy = decision.decidedBy;
    request.status = decision.decision;
    request.decidedAt = new Date().toISOString();
  }
}