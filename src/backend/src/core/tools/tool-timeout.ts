/**
 * ToolTimeoutManager — Timeout management for tool execution.
 *
 * Transport-agnostic: no Fastify, no SSE, no React, no zod-for-runtime deps.
 * Pure TypeScript only.
 */

import { ToolError } from '../errors/index.js';
import { CancellationError, isCancellationError } from '../runtime/index.js';

/**
 * Options for executeWithTimeout.
 */
export interface ExecuteWithTimeoutOptions<T> {
  /** Function to execute */
  fn: () => Promise<T>;
  /** Timeout in milliseconds (overrides default) */
  timeoutMs?: number;
  /** Optional external abort signal */
  signal?: AbortSignal;
  /** Tool name for error reporting */
  toolName: string;
}

/**
 * ToolTimeoutManager — Manages execution timeouts for tools.
 */
export class ToolTimeoutManager {
  #defaultTimeoutMs: number;
  #lastTimeoutMs: number = 0;

  /**
   * Creates a new ToolTimeoutManager.
   *
   * @param defaultTimeoutMs - Default timeout in milliseconds (default: 30000)
   */
  constructor(defaultTimeoutMs: number = 30000) {
    this.#defaultTimeoutMs = defaultTimeoutMs;
  }

  /**
   * Executes a function with a timeout.
   *
   * @param options - Execution options
   * @returns Promise resolving with the function result
   * @throws {ToolError} If timeout occurs (code: 'TOOL_TIMEOUT', retryable: true)
   * @throws {CancellationError} If external signal aborts
   */
  async executeWithTimeout<T>(options: ExecuteWithTimeoutOptions<T>): Promise<T> {
    const { fn, timeoutMs, signal, toolName } = options;
    const effectiveTimeoutMs = timeoutMs ?? this.#defaultTimeoutMs;
    this.#lastTimeoutMs = effectiveTimeoutMs;

    // Create timeout signal
    const timeoutController = new AbortController();
    const timeoutId = setTimeout(() => {
      timeoutController.abort(new ToolError(`Tool '${toolName}' timed out after ${effectiveTimeoutMs}ms`, {
        toolName,
        code: 'TOOL_TIMEOUT',
        retryable: true,
      }));
    }, effectiveTimeoutMs);

    // Allow timeout to not prevent process exit
    if (typeof timeoutId.unref === 'function') {
      timeoutId.unref();
    }

    // Combine signals
    const combinedSignal = this.#combineSignals([timeoutController.signal, signal]);

    try {
      // Wrap the function to respect the combined signal
      const result = await this.#runWithSignal(fn, combinedSignal, toolName);
      return result;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Returns the last timeout value used (in milliseconds).
   */
  lastTimeoutMs(): number {
    return this.#lastTimeoutMs;
  }

  /**
   * Combines multiple AbortSignals into a single signal.
   */
  #combineSignals(signals: (AbortSignal | undefined)[]): AbortSignal {
    const validSignals = signals.filter((s): s is AbortSignal => s !== undefined);

    if (validSignals.length === 0) {
      // Return a never-aborting signal
      const controller = new AbortController();
      // Never abort
      return controller.signal;
    }

    if (validSignals.length === 1) {
      return validSignals[0];
    }

    const controller = new AbortController();

    const abortHandler = (reason?: unknown) => {
      controller.abort(reason);
    };

    for (const signal of validSignals) {
      if (signal.aborted) {
        controller.abort(signal.reason);
        return controller.signal;
      }
      signal.addEventListener('abort', abortHandler, { once: true });
    }

    // Clean up listeners when combined signal aborts
    controller.signal.addEventListener('abort', () => {
      for (const signal of validSignals) {
        signal.removeEventListener('abort', abortHandler);
      }
    }, { once: true });

    return controller.signal;
  }

  /**
   * Runs a function with abort signal support.
   */
  async #runWithSignal<T>(
    fn: () => Promise<T>,
    signal: AbortSignal,
    toolName: string
  ): Promise<T> {
    // If already aborted, throw immediately
    if (signal.aborted) {
      throw this.#reasonToError(signal.reason);
    }

    // Create a promise that rejects on abort
    const abortPromise = new Promise<never>((_, reject) => {
      const handler = () => {
        reject(this.#reasonToError(signal.reason));
      };

      if (signal.aborted) {
        handler();
      } else {
        signal.addEventListener('abort', handler, { once: true });
      }
    });

    try {
      return await Promise.race([fn(), abortPromise]);
    } catch (error) {
      // Re-throw typed errors as-is (ToolError / CancellationError)
      if (error instanceof ToolError || isCancellationError(error)) {
        throw error;
      }
      // Wrap other errors
      throw error;
    }
  }

  /**
   * Maps an abort reason to the correct typed error:
   * - ToolError (timeout) → rethrown as-is
   * - CancellationError → rethrown as-is
   * - anything else (external abort) → CancellationError('Operation cancelled')
   */
  #reasonToError(reason: unknown): unknown {
    if (reason instanceof ToolError) {
      return reason;
    }
    if (isCancellationError(reason)) {
      return reason;
    }
    return new CancellationError('Operation cancelled', reason);
  }
}