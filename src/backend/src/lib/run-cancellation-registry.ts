/**
 * RunCancellationRegistry — Aether 2.0 P0-01/P0-02
 *
 * Single source of truth for run-scoped cancellation.
 * Replaces conversation-scoped `activeRequests` Map with runId-keyed registry.
 *
 * Invariants:
 * - One AbortController per runId (run-scoped, not conversation-scoped)
 * - runId → conversationId mapping enables conversation-wide cancel (convenience)
 * - All operations are synchronous and idempotent
 */

export class RunCancellationRegistry {
  #byRun = new Map<string, AbortController>();
  #runToConv = new Map<string, string>();

  /**
   * Register a new run with its AbortController.
   * @param runId - Unique run identifier (UUID)
   * @param conversationId - Conversation this run belongs to
   * @param controller - AbortController for this run
   * @throws If runId already registered
   */
  register(runId: string, conversationId: string, controller: AbortController): void {
    if (this.#byRun.has(runId)) {
      throw new Error(`Run ${runId} already registered in cancellation registry`);
    }
    this.#byRun.set(runId, controller);
    this.#runToConv.set(runId, conversationId);
  }

  /**
   * Get the AbortController for a run.
   * @param runId - Run identifier
   * @returns AbortController or undefined if not found
   */
  get(runId: string): AbortController | undefined {
    return this.#byRun.get(runId);
  }

  /**
   * Cancel a specific run by aborting its controller.
   * @param runId - Run identifier
   * @returns true if run was found and aborted, false if not found
   */
  cancel(runId: string): boolean {
    const controller = this.#byRun.get(runId);
    if (!controller) return false;
    controller.abort();
    return true;
  }

  /**
   * Unregister a run (cleanup after completion/cancellation).
   * Does NOT abort the controller — use cancel() if you need to abort.
   * @param runId - Run identifier
   * @returns true if run was found and removed, false if not found
   */
  unregister(runId: string): boolean {
    const existed = this.#byRun.delete(runId);
    if (existed) this.#runToConv.delete(runId);
    return existed;
  }

  /**
   * Cancel all runs belonging to a conversation.
   * Convenience endpoint for `/api/conversations/:id/cancel`.
   * @param conversationId - Conversation identifier
   * @returns Array of runIds that were actually cancelled (aborted and unregistered) by this call
   */
  cancelConversation(conversationId: string): string[] {
    const cancelled: string[] = [];
    for (const [runId, convId] of this.#runToConv.entries()) {
      if (convId === conversationId) {
        const controller = this.#byRun.get(runId);
        if (controller && !controller.signal.aborted) {
          controller.abort();
          cancelled.push(runId);
        }
      }
    }
    // Unregister the cancelled runs
    for (const runId of cancelled) {
      this.#byRun.delete(runId);
      this.#runToConv.delete(runId);
    }
    return cancelled;
  }

  /**
   * Get all runIds belonging to a conversation.
   * @param conversationId - Conversation identifier
   * @returns Array of runIds (empty if none)
   */
  runIdsForConversation(conversationId: string): string[] {
    const result: string[] = [];
    for (const [runId, convId] of this.#runToConv.entries()) {
      if (convId === conversationId) result.push(runId);
    }
    return result;
  }

  /** Total number of registered runs */
  get size(): number {
    return this.#byRun.size;
  }

  /** Check if a run is registered */
  has(runId: string): boolean {
    return this.#byRun.has(runId);
  }

  /** Clear all entries (testing/debugging) */
  clear(): void {
    this.#byRun.clear();
    this.#runToConv.clear();
  }
}

/** Singleton instance for application-wide use */
export const runCancellationRegistry = new RunCancellationRegistry();