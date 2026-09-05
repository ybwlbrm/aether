/**
 * Lifecycle — State machine and hooks for runtime lifecycle management.
 *
 * Provides a strict state machine for lifecycle transitions and a helper
 * to wrap objects with lifecycle hooks.
 * Transport-agnostic: no Fastify, no SSE, no React, no zod-for-runtime deps.
 * Pure TypeScript only.
 */

import { RuntimeError } from '../errors/index.js';

/**
 * Lifecycle states in order of progression.
 */
export type LifecycleState =
  | 'created'
  | 'starting'
  | 'running'
  | 'stopping'
  | 'stopped'
  | 'failed';

/**
 * Valid state transitions.
 * Key = current state, Value = allowed next states.
 */
const VALID_TRANSITIONS: Record<LifecycleState, LifecycleState[]> = {
  created: ['starting', 'failed'],
  starting: ['running', 'failed'],
  running: ['stopping', 'failed'],
  stopping: ['stopped', 'failed'],
  stopped: ['failed'],
  failed: [],
};

/**
 * Lifecycle hooks for custom behavior at transition points.
 */
export interface LifecycleHooks {
  /** Called when transitioning from created to starting */
  onStart?: () => void | Promise<void>;
  /** Called when transitioning from running to stopping */
  onStop?: () => void | Promise<void>;
  /** Called when entering failed state */
  onError?: (error: unknown) => void | Promise<void>;
}

/**
 * LifecycleManager — Enforces valid lifecycle state transitions.
 *
 * Uses a strict state machine. Invalid transitions throw RuntimeError.
 * Hooks are called at appropriate transition points.
 */
export class LifecycleManager {
  #state: LifecycleState = 'created';
  #hooks: LifecycleHooks;

  constructor(hooks: LifecycleHooks = {}) {
    this.#hooks = hooks;
  }

  /**
   * Current lifecycle state.
   */
  get state(): LifecycleState {
    return this.#state;
  }

  /**
   * Whether the lifecycle is in a terminal state (stopped or failed).
   */
  get isTerminal(): boolean {
    return this.#state === 'stopped' || this.#state === 'failed';
  }

  /**
   * Whether the lifecycle is currently running.
   */
  get isRunning(): boolean {
    return this.#state === 'running';
  }

  /**
   * Attempts to transition to a new state.
   * Calls appropriate hooks and validates transition.
   *
   * @param nextState - The state to transition to
   * @throws {RuntimeError} If transition is invalid
   */
  async transition(nextState: LifecycleState): Promise<void> {
    const allowed = VALID_TRANSITIONS[this.#state];
    if (!allowed.includes(nextState)) {
      throw new RuntimeError(`Invalid lifecycle transition: ${this.#state} -> ${nextState}`, {
        code: 'INVALID_LIFECYCLE_TRANSITION',
        context: { currentState: this.#state, attemptedState: nextState },
        retryable: false,
      });
    }

    const previousState = this.#state;
    this.#state = nextState;

    // Call hooks based on transition
    try {
      if (previousState === 'created' && nextState === 'starting') {
        await this.#hooks.onStart?.();
      } else if (previousState === 'running' && nextState === 'stopping') {
        await this.#hooks.onStop?.();
      } else if (nextState === 'failed') {
        // onError is called with the error that caused the failure
        // The error should be passed by the caller via transitionToFailed
      }
    } catch (error) {
      // If hook throws, transition to failed
      this.#state = 'failed';
      await this.#hooks.onError?.(error);
      throw error;
    }
  }

  /**
   * Transitions to starting state (from created).
   * @throws {RuntimeError} If not in created state
   */
  async start(): Promise<void> {
    await this.transition('starting');
    await this.transition('running');
  }

  /**
   * Transitions to stopping state (from running).
   * @throws {RuntimeError} If not in running state
   */
  async stop(): Promise<void> {
    await this.transition('stopping');
    await this.transition('stopped');
  }

  /**
   * Transitions to failed state from any state.
   * Calls onError hook with the provided error.
   */
  async fail(error: unknown): Promise<void> {
    const previousState = this.#state;
    this.#state = 'failed';
    await this.#hooks.onError?.(error);
  }

  /**
   * Resets the lifecycle to created state.
   * Only allowed from stopped or failed states.
   * @throws {RuntimeError} If not in a terminal state
   */
  reset(): void {
    if (this.#state !== 'stopped' && this.#state !== 'failed') {
      throw new RuntimeError('Cannot reset lifecycle from non-terminal state', {
        code: 'LIFECYCLE_CANNOT_RESET',
        context: { currentState: this.#state },
        retryable: false,
      });
    }
    this.#state = 'created';
  }
}

/**
 * Wraps a target object with lifecycle management.
 *
 * The returned object has the same properties as target, plus:
 * - lifecycle: LifecycleManager instance
 * - start(): Promise<void> - delegates to lifecycle.start()
 * - stop(): Promise<void> - delegates to lifecycle.stop()
 *
 * @param target - Object to wrap with lifecycle
 * @param hooks - Optional lifecycle hooks
 * @returns Target wrapped with lifecycle methods
 */
export function withLifecycle<T extends object>(
  target: T,
  hooks: LifecycleHooks = {}
): T & {
  lifecycle: LifecycleManager;
  start: () => Promise<void>;
  stop: () => Promise<void>;
} {
  const lifecycle = new LifecycleManager(hooks);

  const wrapped = {
    ...target,
    lifecycle,
    start: async () => {
      await lifecycle.start();
    },
    stop: async () => {
      await lifecycle.stop();
    },
  };

  return wrapped;
}