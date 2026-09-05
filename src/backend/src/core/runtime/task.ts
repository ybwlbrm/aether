/**
 * Task State Machine — Aether 2.0 Task lifecycle management.
 *
 * Pure in-memory state machine for Task entity with strict transition validation.
 * Supports parent-child task linking for hierarchical execution.
 * Transport-agnostic: no Fastify, no SSE, no React, no zod-for-runtime deps.
 * Pure TypeScript only.
 */

import { RuntimeError } from '../errors/index.js';

/**
 * Task status enum matching the tasks table.
 * State machine: pending → running ⇄ waiting → completed | failed | cancelled
 */
export type TaskStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * TaskEntity interface matching the tasks table shape.
 */
export interface TaskEntity {
  id: string;
  runId: string;
  parentTaskId?: string;
  agentId: string;
  agentType: string;
  status: TaskStatus;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  error?: string;
  startedAt?: string;
  completedAt?: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

/**
 * Valid task state transitions.
 * Key = current state, Value = allowed next states.
 */
const VALID_TASK_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  pending: ['running'],
  running: ['waiting', 'completed', 'failed', 'cancelled'],
  waiting: ['running', 'completed', 'failed', 'cancelled'],
  completed: [],
  failed: [],
  cancelled: [],
};

/**
 * Terminal task states (absorbing).
 */
const TERMINAL_TASK_STATUSES: TaskStatus[] = ['completed', 'failed', 'cancelled'];

/**
 * TaskStateMachine — Pure in-memory state machine for Task lifecycle.
 *
 * Enforces valid transitions, tracks timestamps, and supports parent-child linking.
 * All invalid transitions throw RuntimeError with code 'INVALID_TASK_TRANSITION'.
 */
export class TaskStateMachine {
  #status: TaskStatus = 'pending';
  #startedAt?: string;
  #completedAt?: string;
  #error?: string;

  /**
   * Current task status.
   */
  get status(): TaskStatus {
    return this.#status;
  }

  /**
   * Whether the task is in a terminal state.
   */
  get isTerminal(): boolean {
    return TERMINAL_TASK_STATUSES.includes(this.#status);
  }

  /**
   * Whether the task has started (reached running state at least once).
   */
  get hasStarted(): boolean {
    return this.#startedAt !== undefined;
  }

  /**
   * Timestamp when task first entered running state (ISO 8601).
   */
  get startedAt(): string | undefined {
    return this.#startedAt;
  }

  /**
   * Timestamp when task reached a terminal state (ISO 8601).
   */
  get completedAt(): string | undefined {
    return this.#completedAt;
  }

  /**
   * Error message if task failed.
   */
  get error(): string | undefined {
    return this.#error;
  }

  /**
   * Attempts to transition to a new status.
   * Validates transition and updates timestamps.
   *
   * @param next - The status to transition to
   * @param error - Optional error message (required for failed transition)
   * @returns The new status after transition
   * @throws {RuntimeError} If transition is invalid (code: 'INVALID_TASK_TRANSITION')
   */
  transition(next: TaskStatus, error?: string): TaskStatus {
    const allowed = VALID_TASK_TRANSITIONS[this.#status];
    if (!allowed.includes(next)) {
      throw new RuntimeError(`Invalid task transition: ${this.#status} -> ${next}`, {
        code: 'INVALID_TASK_TRANSITION',
        context: { currentState: this.#status, attemptedState: next },
        retryable: false,
      });
    }

    // Set startedAt on first transition to running
    if (this.#status !== 'running' && next === 'running' && this.#startedAt === undefined) {
      this.#startedAt = new Date().toISOString();
    }

    // Handle terminal transitions
    if (TERMINAL_TASK_STATUSES.includes(next)) {
      this.#completedAt = new Date().toISOString();
      if (next === 'failed' && error) {
        this.#error = error;
      }
    }

    this.#status = next;
    return this.#status;
  }

  /**
   * Checks if a task can be started (is in pending state).
   *
   * @param state - Task status to check
   * @returns true if task can start (status === 'pending')
   */
  static canStart(state: TaskStatus): boolean {
    return state === 'pending';
  }

  /**
   * Creates a TaskEntity snapshot from current state.
   * Useful for persistence.
   *
   * @param base - Base entity fields (id, runId, parentTaskId, agentId, agentType, input, output, metadata, createdAt)
   * @returns Complete TaskEntity
   */
  toEntity(base: {
    id: string;
    runId: string;
    parentTaskId?: string;
    agentId: string;
    agentType: string;
    input?: Record<string, unknown>;
    output?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    createdAt: string;
  }): TaskEntity {
    return {
      ...base,
      status: this.#status,
      startedAt: this.#startedAt,
      completedAt: this.#completedAt,
      error: this.#error,
    };
  }

  /**
   * Resets the state machine to initial state.
   * Only for testing purposes.
   */
  reset(): void {
    this.#status = 'pending';
    this.#startedAt = undefined;
    this.#completedAt = undefined;
    this.#error = undefined;
  }
}

/**
 * Validates and establishes parent-child task relationship.
 * Ensures child.runId === parent.runId and child.parentTaskId === parent.id.
 *
 * @param parent - Parent task entity
 * @param child - Child task entity
 * @throws {RuntimeError} If runId mismatch or parentTaskId mismatch (code: 'INVALID_TASK_TRANSITION')
 */
export function setChild(
  parent: TaskEntity,
  child: TaskEntity
): void {
  if (child.runId !== parent.runId) {
    throw new RuntimeError('Child task runId must match parent runId', {
      code: 'INVALID_TASK_TRANSITION',
      context: { parentRunId: parent.runId, childRunId: child.runId },
      retryable: false,
    });
  }
  if (child.parentTaskId !== parent.id) {
    throw new RuntimeError('Child task parentTaskId must match parent id', {
      code: 'INVALID_TASK_TRANSITION',
      context: { parentId: parent.id, childParentTaskId: child.parentTaskId },
      retryable: false,
    });
  }
}

/**
 * Checks if a task can be started (is in pending state).
 * Standalone helper function.
 *
 * @param state - Task status to check
 * @returns true if task can start (status === 'pending')
 */
export function canStart(state: TaskStatus): boolean {
  return state === 'pending';
}