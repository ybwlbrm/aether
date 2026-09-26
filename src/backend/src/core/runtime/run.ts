/**
 * Run State Machine — Aether 2.0 Run lifecycle management.
 *
 * Pure in-memory state machine for Run entity with strict transition validation.
 * Transport-agnostic: no Fastify, no SSE, no React, no zod-for-runtime deps.
 * Pure TypeScript only.
 */

import { RUN_STATUSES, RUN_TERMINAL_STATUSES, type RunStatus } from '@pacc/shared'
import { RuntimeError } from '../errors/index.js'

/**
 * Run 状态集合 / 类型（AEX-P0-002）。
 * 权威定义在 @pacc/shared，此处仅 re-export 保持既有 import 路径兼容。
 */
export { RUN_STATUSES, type RunStatus }

/**
 * Run mode enum matching the runs table.
 */
export type RunMode = 'normal' | 'super' | 'workflow' | 'background'

/**
 * RunEntity interface matching the runs table shape.
 */
export interface RunEntity {
  id: string
  conversationId?: string
  status: RunStatus
  mode: RunMode
  rootAgentId?: string
  startedAt?: string
  completedAt?: string
  endReason?: string
  inputTokens: number
  outputTokens: number
  totalTokens: number
  parentRunId?: string | null
  retryOfRunId?: string | null
  attempt?: number
  retryType?: string | null
  lastUpdatedAt?: string
  error?: string
  metadata?: Record<string, unknown>
  createdAt: string
}

/** RunStateMachine transition metadata. */
export interface RunTransitionOptions {
  endReason?: string
  error?: string
  tokenUsage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
  }
}

/**
 * Valid run state transitions.
 * Key = current state, Value = allowed next states.
 */
const VALID_RUN_TRANSITIONS: Record<RunStatus, readonly RunStatus[]> = {
  created: ['running'],
  running: [
    'waiting',
    'retry_waiting',
    'verifying',
    'completed',
    'failed',
    'cancelled',
    'interrupted',
    'budget_exceeded',
  ],
  waiting: [
    'running',
    'retry_waiting',
    'verifying',
    'completed',
    'failed',
    'cancelled',
    'interrupted',
    'budget_exceeded',
  ],
  retry_waiting: ['retrying', 'failed', 'cancelled', 'interrupted', 'budget_exceeded'],
  retrying: ['running', 'waiting', 'failed', 'cancelled', 'interrupted', 'budget_exceeded'],
  verifying: ['running', 'completed', 'failed', 'cancelled', 'interrupted', 'budget_exceeded'],
  completed: [],
  failed: [],
  cancelled: [],
  interrupted: [],
  budget_exceeded: [],
}

/** RUN-001: 校验状态转移是否合法（任何模块改 run 状态前必须先过此函数） */
export function isValidRunTransition(from: RunStatus, to: RunStatus): boolean {
  return VALID_RUN_TRANSITIONS[from].includes(to)
}

/** Terminal run states are absorbing. */
export const TERMINAL_RUN_STATUSES = RUN_TERMINAL_STATUSES

export function isTerminalRunStatus(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.some((terminalStatus) => terminalStatus === status)
}

/**
 * RunStateMachine — Pure in-memory state machine for Run lifecycle.
 *
 * Enforces valid transitions, tracks timestamps, and accumulates token usage.
 * All invalid transitions throw RuntimeError with code 'INVALID_RUN_TRANSITION'.
 */
export class RunStateMachine {
  #status: RunStatus = 'created'
  #startedAt?: string
  #completedAt?: string
  #endReason?: string
  #error?: string
  #lastUpdatedAt?: string
  #inputTokens = 0
  #outputTokens = 0
  #totalTokens = 0

  /** Current run status. */
  get status(): RunStatus {
    return this.#status
  }

  /** Whether the run is in a terminal state. */
  get isTerminal(): boolean {
    return isTerminalRunStatus(this.#status)
  }

  /** Whether the run has started (reached running state at least once). */
  get hasStarted(): boolean {
    return this.#startedAt !== undefined
  }

  /** Timestamp when run first entered running state (ISO 8601). */
  get startedAt(): string | undefined {
    return this.#startedAt
  }

  /** Timestamp when run reached a terminal state (ISO 8601). */
  get completedAt(): string | undefined {
    return this.#completedAt
  }

  /** Reason for run termination. */
  get endReason(): string | undefined {
    return this.#endReason
  }

  /** Error carried by the latest transition. */
  get error(): string | undefined {
    return this.#error
  }

  /** Timestamp of the latest state transition. */
  get lastUpdatedAt(): string | undefined {
    return this.#lastUpdatedAt
  }

  get inputTokens(): number {
    return this.#inputTokens
  }

  get outputTokens(): number {
    return this.#outputTokens
  }

  get totalTokens(): number {
    return this.#totalTokens
  }

  /**
   * Attempts to transition to a new status.
   *
   * @param next - The status to transition to
   * @param opts - Optional transition metadata
   * @returns The new status after transition
   * @throws {RuntimeError} If transition is invalid (code: 'INVALID_RUN_TRANSITION')
   */
  transition(next: RunStatus, opts?: RunTransitionOptions): RunStatus {
    const allowed = VALID_RUN_TRANSITIONS[this.#status]
    if (!allowed.includes(next)) {
      throw new RuntimeError(`Invalid run transition: ${this.#status} -> ${next}`, {
        code: 'INVALID_RUN_TRANSITION',
        context: { currentState: this.#status, attemptedState: next },
        retryable: false,
      })
    }

    const now = new Date().toISOString()
    if (this.#status !== 'running' && next === 'running' && this.#startedAt === undefined) {
      this.#startedAt = now
    }
    if (isTerminalRunStatus(next)) {
      this.#completedAt = now
    }
    if (opts?.endReason !== undefined) {
      this.#endReason = opts.endReason
    }
    if (opts?.error !== undefined) {
      this.#error = opts.error
    }
    if (opts?.tokenUsage) {
      this.#inputTokens += opts.tokenUsage.inputTokens
      this.#outputTokens += opts.tokenUsage.outputTokens
      this.#totalTokens += opts.tokenUsage.totalTokens
    }

    this.#status = next
    this.#lastUpdatedAt = now
    return this.#status
  }

  /** Assert that the current status matches the expected status. */
  assertStatus(expected: RunStatus): void {
    if (this.#status !== expected) {
      throw new RuntimeError(`Run status mismatch: expected ${expected}, got ${this.#status}`, {
        code: 'INVALID_RUN_TRANSITION',
        context: { expected, actual: this.#status },
        retryable: false,
      })
    }
  }

  /** Create a RunEntity snapshot from current state. */
  toEntity(base: {
    id: string
    conversationId?: string
    mode: RunMode
    rootAgentId?: string
    parentRunId?: string | null
    retryOfRunId?: string | null
    attempt?: number
    retryType?: string | null
    metadata?: Record<string, unknown>
    createdAt: string
    lastUpdatedAt?: string
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
      lastUpdatedAt: this.#lastUpdatedAt ?? base.lastUpdatedAt ?? base.createdAt,
      error: this.#error,
    }
  }

  /** Reset the state machine to its initial state. */
  reset(): void {
    this.#status = 'created'
    this.#startedAt = undefined
    this.#completedAt = undefined
    this.#endReason = undefined
    this.#error = undefined
    this.#lastUpdatedAt = undefined
    this.#inputTokens = 0
    this.#outputTokens = 0
    this.#totalTokens = 0
  }
}
