/**
 * Cancellation — AbortSignal-based cancellation primitives.
 *
 * Provides CancellationToken wrapper, CancellationError, and helpers
 * for timeout and promise cancellation.
 * Transport-agnostic: no Fastify, no SSE, no React, no zod-for-runtime deps.
 * Pure TypeScript only.
 */

import { RuntimeError } from '../errors/index.js';

/**
 * CancellationError — Thrown when an operation is cancelled.
 * Extends RuntimeError with code 'CANCELLED' and retryable=false.
 */
export class CancellationError extends RuntimeError {
  constructor(message = 'Operation cancelled', cause?: unknown) {
    super(message, {
      code: 'CANCELLED',
      cause,
      retryable: false,
    });
    this.name = 'CancellationError';
    Object.setPrototypeOf(this, CancellationError.prototype);
  }

  /**
   * Type guard to check if a value is a CancellationError.
   */
  static isCancellationError(value: unknown): value is CancellationError {
    return value instanceof CancellationError;
  }
}

/**
 * Type guard to check if an error is a CancellationError.
 * @param err - Error to check
 * @returns true if err is a CancellationError
 */
export function isCancellationError(err: unknown): err is CancellationError {
  return CancellationError.isCancellationError(err);
}

/**
 * CancellationToken — Wraps an AbortSignal for ergonomic cancellation handling.
 */
export class CancellationToken {
  #signal: AbortSignal;
  #controller?: AbortController;
  #callbacks: Set<() => void> = new Set();
  #aborted = false;

  /**
   * Creates a CancellationToken from an AbortSignal or AbortController.
   * If an AbortController is provided, its signal is used.
   * If an AbortSignal is provided, it's used directly.
   * If neither is provided, a new AbortController is created.
   */
  constructor(signalOrController?: AbortSignal | AbortController) {
    if (signalOrController instanceof AbortController) {
      this.#controller = signalOrController;
      this.#signal = signalOrController.signal;
    } else if (signalOrController instanceof AbortSignal) {
      this.#signal = signalOrController;
    } else {
      this.#controller = new AbortController();
      this.#signal = this.#controller.signal;
    }

    // Track abort state
    if (this.#signal.aborted) {
      this.#aborted = true;
    } else {
      this.#signal.addEventListener('abort', () => {
        this.#aborted = true;
        this.#fireCallbacks();
      }, { once: true });
    }
  }

  /**
   * The underlying AbortSignal.
   */
  get signal(): AbortSignal {
    return this.#signal;
  }

  /**
   * Whether the token has been cancelled (signal aborted).
   */
  get isCancelled(): boolean {
    return this.#aborted || this.#signal.aborted;
  }

  /**
   * Throws a CancellationError if the token is cancelled.
   * No-op if not cancelled.
   *
   * @throws {CancellationError} If cancelled
   */
  throwIfCancelled(): void {
    if (this.isCancelled) {
      throw new CancellationError('Operation cancelled', this.#signal.reason);
    }
  }

  /**
   * Registers a callback to be called when the token is cancelled.
   * If already cancelled, the callback is called immediately (synchronously).
   * Returns an unsubscribe function.
   *
   * @param callback - Function to call on cancellation
   * @returns Unsubscribe function
   */
  onCancelled(callback: () => void): () => void {
    if (this.isCancelled) {
      // Already cancelled - call immediately
      try {
        callback();
      } catch {
        // Swallow callback errors
      }
      return () => {}; // No-op unsubscribe
    }

    this.#callbacks.add(callback);

    return () => {
      this.#callbacks.delete(callback);
    };
  }

  /**
   * Aborts the token (if created with an AbortController).
   * No-op if created from an external signal.
   *
   * @param reason - Optional reason for aborting
   */
  abort(reason?: unknown): void {
    if (this.#controller) {
      this.#controller.abort(reason);
    }
  }

  #fireCallbacks(): void {
    for (const callback of this.#callbacks) {
      try {
        callback();
      } catch {
        // Swallow callback errors
      }
    }
    this.#callbacks.clear();
  }
}

/**
 * Creates an AbortSignal that aborts after the specified timeout.
 *
 * @param ms - Timeout in milliseconds
 * @returns AbortSignal that aborts after ms
 */
export function withTimeout(ms: number): AbortSignal {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => {
    controller.abort(new CancellationError(`Timeout after ${ms}ms`));
  }, ms);

  // Allow the timeout to not prevent process exit
  if (typeof timeoutId.unref === 'function') {
    timeoutId.unref();
  }

  // Clean up timeout if signal is aborted externally
  controller.signal.addEventListener('abort', () => {
    clearTimeout(timeoutId);
  }, { once: true });

  return controller.signal;
}

/**
 * Wraps a promise with cancellation support.
 *
 * If the token is cancelled before the promise resolves, the returned promise
 * rejects with a CancellationError. If the promise resolves first, the result
 * is returned normally.
 *
 * @param promise - Promise to wrap
 * @param token - CancellationToken to observe
 * @returns Promise that resolves with T or rejects with CancellationError
 */
export async function withCancellation<T>(
  promise: Promise<T>,
  token: CancellationToken
): Promise<T> {
  // If already cancelled, reject immediately
  if (token.isCancelled) {
    throw new CancellationError('Operation cancelled', token.signal.reason);
  }

  // Create a promise that rejects on cancellation
  const cancellationPromise = new Promise<never>((_, reject) => {
    const unsubscribe = token.onCancelled(() => {
      reject(new CancellationError('Operation cancelled', token.signal.reason));
    });

    // Clean up listener if promise settles
    promise.then(
      () => unsubscribe(),
      () => unsubscribe()
    );
  });

  return Promise.race([promise, cancellationPromise]);
}