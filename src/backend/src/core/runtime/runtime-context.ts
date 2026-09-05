/**
 * RuntimeContext — Execution context for runtime operations.
 *
 * Provides a scoped context with abort signal, key-value store, and identity metadata.
 * Transport-agnostic: no Fastify, no SSE, no React, no zod-for-runtime deps.
 * Pure TypeScript only.
 */

/**
 * Runtime execution context interface.
 */
export interface RuntimeContext {
  /** Unique identifier for this runtime execution */
  runId: string;
  /** Optional task identifier */
  taskId?: string;
  /** Optional agent identifier */
  agentId?: string;
  /** AbortSignal for cancellation propagation */
  signal: AbortSignal;
  /** Internal key-value store for context data */
  store: Map<string, unknown>;
  /**
   * Retrieves a typed value from the store.
   * @returns The value if present and type matches, undefined otherwise
   */
  get<T>(key: string): T | undefined;
  /**
   * Sets a value in the store.
   */
  set(key: string, value: unknown): void;
}

/**
 * Options for creating a RuntimeContext.
 */
export interface CreateRuntimeContextOptions {
  /** Unique identifier for this runtime execution (required) */
  runId: string;
  /** Optional task identifier */
  taskId?: string;
  /** Optional agent identifier */
  agentId?: string;
  /** Optional parent AbortSignal to link for cancellation */
  parentSignal?: AbortSignal;
  /** Initial store values */
  initialStore?: Map<string, unknown> | Record<string, unknown>;
}

/**
 * Creates a new RuntimeContext with an AbortController-backed signal.
 *
 * The returned context's signal will abort when:
 * - The parent signal aborts (if provided)
 * - The context's abort() method is called
 *
 * @param options - Context creation options
 * @returns A RuntimeContext instance
 */
export function createRuntimeContext(options: CreateRuntimeContextOptions): RuntimeContext {
  const controller = new AbortController();
  const { signal } = controller;

  // Link to parent signal if provided
  if (options.parentSignal) {
    const parentSignal = options.parentSignal;
    if (parentSignal.aborted) {
      controller.abort(parentSignal.reason);
    } else {
      parentSignal.addEventListener('abort', () => {
        controller.abort(parentSignal.reason);
      }, { once: true });
    }
  }

  // Initialize store
  const store = new Map<string, unknown>();
  if (options.initialStore) {
    if (options.initialStore instanceof Map) {
      for (const [key, value] of options.initialStore) {
        store.set(key, value);
      }
    } else {
      for (const [key, value] of Object.entries(options.initialStore)) {
        store.set(key, value);
      }
    }
  }

  const context: RuntimeContext = {
    runId: options.runId,
    taskId: options.taskId,
    agentId: options.agentId,
    signal,
    store,
    get<T>(key: string): T | undefined {
      const value = store.get(key);
      return value as T | undefined;
    },
    set(key: string, value: unknown): void {
      store.set(key, value);
    },
  };

  // Attach abort method to context for convenience
  Object.defineProperty(context, 'abort', {
    value: (reason?: unknown) => controller.abort(reason),
    writable: false,
    enumerable: false,
    configurable: false,
  });

  return context;
}