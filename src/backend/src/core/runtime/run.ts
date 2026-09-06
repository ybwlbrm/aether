/**
 * Run State Machine — Aether 2.0 Run lifecycle management.
 *
 * Pure in-memory state machine for Run entity with strict transition validation.
 * Transport-agnostic: no Fastify, no SSE, no React, no zod-for-runtime deps.
 * Pure TypeScript only.
 */

import { RuntimeError } from '../errors/index.js';

/**
 * Run status enum matching the runs table.
 * State machine: created → running ⇄ waiting → completed | failed | cancelled | interrupted
 */
export type RunStatus =
  | 'created'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'interrupted';

/**
 * Run mode enum matching the runs table.
 */
export type RunMode = 'normal' | 'super' | 'workflow' | 'background';

/**
 * RunEntity interface matching the runs table shape.
 */
export interface RunEntity {
  id: string;
  conversationId?: string;
  status: RunStatus;
  mode: RunMode;
  rootAgentId?: string;
  startedAt?: string;
  completedAt?: string;
  endReason?: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  error?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

/**
 * Valid run state transitions.
 * Key = current state, Value = allowed next states.
 */
const VALID_RUN_TRANSITIONS: Record<RunStatus, RunStatus[]> = {
  created: ['running'],
  running: ['waiting', 'completed', 'failed', 'cancelled', 'interrupted'],
  waiting: ['running', 'completed', 'failed', 'cancelled', 'interrupted'],
  completed: [],
  failed: [],
  cancelled: [],
  interrupted: [],
};

/** RUN-001: 校验状态转移是否合法（任何模块改 run 状态前必须先过此函数） */
export function isValidRunTransition(from: RunStatus, to: RunStatus): boolean {
  return VALID_RUN_TRANSITIONS[from]?.includes(to) ?? false;
}

/**
 * Terminal run states (absorbing).
 */
const TERMINAL_RUN_STATUSES: RunStatus[] = ['completed', 'failed', 'cancelled', 'interrupted'];

/**
 * RunStateMachine — Pure in-memory state machine for Run lifecycle.
 *
 * Enforces valid transitions, tracks timestamps, and accumulates token usage.
 * All invalid transitions throw RuntimeError with code 'INVALID_RUN_TRANSITION'.
 */
export class RunStateMachine {
  #status: RunStatus = 'created';
  #startedAt?: string;
  #completedAt?: string;
  #endReason?: string;
  #inputTokens = 0;
  #outputTokens = 0;
  #totalTokens = 0;

  /**
   * Current run status.
   */
  get status(): RunStatus {
    return this.#status;
  }

  /**
   * Whether the run is in a terminal state.
   */
  get isTerminal(): boolean {
    return TERMINAL_RUN_STATUSES.includes(this.#status);
  }

  /**
   * Whether the run has started (reached running state at least once).
   */
  get hasStarted(): boolean {
    return this.#startedAt !== undefined;
  }

  /**
   * Timestamp when run first entered running state (ISO 8601).
   */
  get startedAt(): string | undefined {
    return this.#startedAt;
  }

  /**
   * Timestamp when run reached a terminal state (ISO 8601).
   */
  get completedAt(): string | undefined {
    return this.#completedAt;
  }

  /**
   * Reason for run termination (set on terminal transition).
   */
  get endReason(): string | undefined {
    return this.#endReason;
  }

  /**
   * Accumulated input tokens.
   */
  get inputTokens(): number {
    return this.#inputTokens;
  }

  /**
   * Accumulated output tokens.
   */
  get outputTokens(): number {
    return this.#outputTokens;
  }

  /**
   * Accumulated total tokens.
   */
  get totalTokens(): number {
    return this.#totalTokens;
  }

  /**
   * Attempts to transition to a new status.
   * Validates transition, updates timestamps, and accumulates token usage.
   *
   * @param next - The status to transition to
   * @param opts - Optional transition metadata
   * @returns The new status after transition
   * @throws {RuntimeError} If transition is invalid (code: 'INVALID_RUN_TRANSITION')
   */
  transition(
    next: RunStatus,
    opts?: {
      endReason?: string;
      error?: string;
      tokenUsage?: { inputTokens: number; outputTokens: number; totalTokens: number };
    }
  ): RunStatus {
    const allowed = VALID_RUN_TRANSITIONS[this.#status];
    if (!allowed.includes(next)) {
      throw new RuntimeError(`Invalid run transition: ${this.#status} -> ${next}`, {
        code: 'INVALID_RUN_TRANSITION',
        context: { currentState: this.#status, attemptedState: next },
        retryable: false,
      });
    }

    // Set startedAt on first transition to running
    if (this.#status !== 'running' && next === 'running' && this.#startedAt === undefined) {
      this.#startedAt = new Date().toISOString();
    }

    // Handle terminal transitions
    if (TERMINAL_RUN_STATUSES.includes(next)) {
      this.#completedAt = new Date().toISOString();
      if (opts?.endReason) {
        this.#endReason = opts.endReason;
      }
    }

    // Accumulate token usage if provided
    if (opts?.tokenUsage) {
      this.#inputTokens += opts.tokenUsage.inputTokens ?? 0;
      this.#outputTokens += opts.tokenUsage.outputTokens ?? 0;
      this.#totalTokens += opts.tokenUsage.totalTokens ?? 0;
    }

    this.#status = next;
    return this.#status;
  }

  /**
   * Asserts that the current status matches the expected status.
   * Throws RuntimeError if mismatch.
   *
   * @param expected - Expected status
   * @throws {RuntimeError} If current status !== expected (code: 'INVALID_RUN_TRANSITION')
   */
  assertStatus(expected: RunStatus): void {
    if (this.#status !== expected) {
      throw new RuntimeError(`Run status mismatch: expected ${expected}, got ${this.#status}`, {
        code: 'INVALID_RUN_TRANSITION',
        context: { expected, actual: this.#status },
        retryable: false,
      });
    }
  }

  /**
   * Creates a RunEntity snapshot from current state.
   * Useful for persistence.
   *
   * @param base - Base entity fields (id, conversationId, mode, rootAgentId, metadata, createdAt)
   * @returns Complete RunEntity
   */
  toEntity(base: {
    id: string;
    conversationId?: string;
    mode: RunMode;
    rootAgentId?: string;
    metadata?: Record<string, unknown>;
    createdAt: string;
  }): RunEntity {
    return {
      ...base,
      status: this.#status,
      startedAt: this.#startedAt,
      completedAt: this.#completedAt,
      endReason: this.#endReason,
      inputTokens: this.#inputTokens,
      outputTokens: this.#outputTokens,
      totalTokens: this.#totalTokens,
      error: this.#status === 'failed' ? this.#endReason : undefined,
    };
  }

  /**
   * Resets the state machine to initial state.
   * Only for testing purposes.
   */
  reset(): void {
    this.#status = 'created';
    this.#startedAt = undefined;
    this.#completedAt = undefined;
    this.#endReason = undefined;
    this.#inputTokens = 0;
    this.#outputTokens = 0;
    this.#totalTokens = 0;
  }
}