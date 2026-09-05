/**
 * Usage Tracking
 *
 * Token usage aggregation and per-run tracking.
 * Pure TypeScript — no Fastify, no SSE, no React, no zod-for-runtime deps.
 */

import type { TokenUsage } from '@pacc/shared';

export type { TokenUsage };

/**
 * Per-call usage record with metadata.
 */
export interface UsageRecord {
  /** Provider identifier */
  providerId: string;
  /** Model identifier */
  model: string;
  /** Token usage for this call */
  usage: TokenUsage;
  /** ISO timestamp of the call */
  timestamp: string;
  /** Optional run ID for grouping */
  runId?: string;
}

/**
 * Aggregated usage totals.
 */
export interface UsageTotals {
  /** Total input/prompt tokens */
  inputTokens: number;
  /** Total output/completion tokens */
  outputTokens: number;
  /** Total tokens (input + output) */
  totalTokens: number;
}

/**
 * Usage tracker — accumulates token usage per run and globally.
 */
export class UsageTracker {
  private readonly records: UsageRecord[] = [];

  /**
   * Record token usage for a model call.
   *
   * @param providerId - Provider identifier
   * @param model - Model identifier
   * @param usage - Token usage from the call
   * @param runId - Optional run ID for grouping related calls
   */
  track(providerId: string, model: string, usage: TokenUsage, runId?: string): void {
    const record: UsageRecord = {
      providerId,
      model,
      usage: { ...usage },
      timestamp: new Date().toISOString(),
      runId,
    };
    this.records.push(record);
  }

  /**
   * Get aggregated totals for a specific run, or all runs if runId not provided.
   *
   * @param runId - Optional run ID to filter by
   * @returns Aggregated usage totals
   */
  getTotals(runId?: string): UsageTotals {
    const filtered = runId
      ? this.records.filter((r) => r.runId === runId)
      : this.records;

    return filtered.reduce(
      (acc, record) => {
        acc.inputTokens += record.usage.inputTokens ?? 0;
        acc.outputTokens += record.usage.outputTokens ?? 0;
        acc.totalTokens += record.usage.totalTokens ?? (record.usage.inputTokens ?? 0) + (record.usage.outputTokens ?? 0);
        return acc;
      },
      { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
    );
  }

  /**
   * Reset all records, or only records for a specific run.
   *
   * @param runId - Optional run ID to reset; if omitted, clears all records
   */
  reset(runId?: string): void {
    if (runId) {
      const keep = this.records.filter((r) => r.runId !== runId);
      this.records.length = 0;
      this.records.push(...keep);
    } else {
      this.records.length = 0;
    }
  }

  /**
   * Get all per-call usage records, optionally filtered by runId.
   *
   * @param runId - Optional run ID to filter by
   * @returns Array of usage records (copy)
   */
  getPerCall(runId?: string): UsageRecord[] {
    const filtered = runId
      ? this.records.filter((r) => r.runId === runId)
      : this.records;
    return [...filtered];
  }
}

/**
 * Pure helper: aggregate multiple TokenUsage objects into a single total.
 *
 * @param usages - Array of TokenUsage to aggregate
 * @returns Aggregated TokenUsage
 */
export function aggregateUsage(usages: TokenUsage[]): TokenUsage {
  return usages.reduce(
    (acc, usage) => {
      acc.inputTokens += usage.inputTokens ?? 0;
      acc.outputTokens += usage.outputTokens ?? 0;
      acc.totalTokens = (acc.totalTokens ?? 0) + (usage.totalTokens ?? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0));
      if (usage.reasoningTokens != null) {
        acc.reasoningTokens = (acc.reasoningTokens ?? 0) + usage.reasoningTokens;
      }
      return acc;
    },
    { inputTokens: 0, outputTokens: 0, totalTokens: 0 }
  );
}