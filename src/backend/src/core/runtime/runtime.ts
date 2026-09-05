/**
 * Runtime — Abstract base class for runtime implementations.
 *
 * Provides lifecycle management (start/stop), event emission, and listener registration.
 * Transport-agnostic: no Fastify, no SSE, no React, no zod-for-runtime deps.
 * Pure TypeScript only.
 */

import { RuntimeError } from '../errors/index.js';

/**
 * Event payload emitted by the runtime.
 */
export interface RuntimeEvent {
  /** Event type identifier */
  type: string;
  /** Optional event payload */
  payload?: unknown;
  /** Timestamp when event was emitted (ms since epoch) */
  timestamp: number;
  /** Optional runtime name that emitted the event */
  runtimeName?: string;
}

/**
 * Listener function for runtime events.
 */
export type RuntimeEventListener = (event: RuntimeEvent) => void;

/**
 * Abstract base class for runtime implementations.
 *
 * Enforces lifecycle: created -> starting -> running -> stopping -> stopped
 * Cannot start twice, cannot stop before start.
 * Subclasses implement onStart/onStop for custom behavior.
 */
export abstract class Runtime {
  /** Optional name for identification in logs/events */
  public readonly name?: string;

  #state: 'created' | 'starting' | 'running' | 'stopping' | 'stopped' = 'created';
  #listeners: Set<RuntimeEventListener> = new Set();

  constructor(name?: string) {
    this.name = name;
  }

  /**
   * Current lifecycle state.
   */
  get state(): 'created' | 'starting' | 'running' | 'stopping' | 'stopped' {
    return this.#state;
  }

  /**
   * Whether the runtime is currently running.
   */
  get isRunning(): boolean {
    return this.#state === 'running';
  }

  /**
   * Starts the runtime.
   *
   * Transitions: created -> starting -> running
   * Calls onStart() override after transitioning to starting.
   *
   * @throws {RuntimeError} If already started or currently starting/running
   */
  async start(): Promise<void> {
    if (this.#state === 'starting' || this.#state === 'running') {
      throw new RuntimeError('Runtime already started', {
        code: 'RUNTIME_ALREADY_STARTED',
        context: { name: this.name, state: this.#state },
        retryable: false,
      });
    }
    if (this.#state === 'stopping' || this.#state === 'stopped') {
      throw new RuntimeError('Cannot start a stopped runtime', {
        code: 'RUNTIME_CANNOT_RESTART',
        context: { name: this.name, state: this.#state },
        retryable: false,
      });
    }

    this.#state = 'starting';
    this.emit({ type: 'runtime:starting', timestamp: Date.now(), runtimeName: this.name });

    try {
      await this.onStart();
      this.#state = 'running';
      this.emit({ type: 'runtime:started', timestamp: Date.now(), runtimeName: this.name });
    } catch (error) {
      this.#state = 'stopped';
      this.emit({ type: 'runtime:start-failed', timestamp: Date.now(), runtimeName: this.name, payload: error });
      throw error;
    }
  }

  /**
   * Stops the runtime.
   *
   * Transitions: running -> stopping -> stopped
   * Calls onStop() override after transitioning to stopping.
   *
   * @throws {RuntimeError} If not running
   */
  async stop(): Promise<void> {
    if (this.#state !== 'running') {
      throw new RuntimeError('Runtime not running', {
        code: 'RUNTIME_NOT_RUNNING',
        context: { name: this.name, state: this.#state },
        retryable: false,
      });
    }

    this.#state = 'stopping';
    this.emit({ type: 'runtime:stopping', timestamp: Date.now(), runtimeName: this.name });

    try {
      await this.onStop();
      this.#state = 'stopped';
      this.emit({ type: 'runtime:stopped', timestamp: Date.now(), runtimeName: this.name });
    } catch (error) {
      this.#state = 'stopped';
      this.emit({ type: 'runtime:stop-failed', timestamp: Date.now(), runtimeName: this.name, payload: error });
      throw error;
    }
  }

  /**
   * Emits an event to all registered listeners.
   * Protected - intended for subclass use.
   */
  protected emit(event: Omit<RuntimeEvent, 'timestamp' | 'runtimeName'> & Partial<Pick<RuntimeEvent, 'timestamp' | 'runtimeName'>>): void {
    const fullEvent: RuntimeEvent = {
      ...event,
      timestamp: event.timestamp ?? Date.now(),
      runtimeName: event.runtimeName ?? this.name,
    };
    for (const listener of this.#listeners) {
      try {
        listener(fullEvent);
      } catch {
        // Listener errors are swallowed to not break emission
      }
    }
  }

  /**
   * Registers an event listener.
   * Returns an unsubscribe function to remove the listener.
   */
  onEvent(listener: RuntimeEventListener): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * Called when runtime is starting.
   * Override in subclasses to implement custom startup logic.
   */
  protected abstract onStart(): void | Promise<void>;

  /**
   * Called when runtime is stopping.
   * Override in subclasses to implement custom shutdown logic.
   */
  protected abstract onStop(): void | Promise<void>;
}