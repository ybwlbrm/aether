/**
 * Usage Tracker Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { UsageTracker, aggregateUsage, type TokenUsage } from './usage.js';

describe('usage', () => {
  describe('UsageTracker', () => {
    describe('track', () => {
      it('records usage with provider, model, and timestamp', () => {
        const tracker = new UsageTracker();
        const usage: TokenUsage = { inputTokens: 100, outputTokens: 50, totalTokens: 150 };

        tracker.track('openai', 'gpt-4', usage);

        const records = tracker.getPerCall();
        assert.strictEqual(records.length, 1);
        assert.strictEqual(records[0].providerId, 'openai');
        assert.strictEqual(records[0].model, 'gpt-4');
        assert.deepStrictEqual(records[0].usage, usage);
        assert.ok(records[0].timestamp);
        assert.match(records[0].timestamp, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
      });

      it('associates usage with runId', () => {
        const tracker = new UsageTracker();
        const usage: TokenUsage = { inputTokens: 100, outputTokens: 50, totalTokens: 150 };

        tracker.track('openai', 'gpt-4', usage, 'run-123');

        const records = tracker.getPerCall('run-123');
        assert.strictEqual(records.length, 1);
        assert.strictEqual(records[0].runId, 'run-123');
      });

      it('does not include runId when not provided', () => {
        const tracker = new UsageTracker();
        const usage: TokenUsage = { inputTokens: 100, outputTokens: 50, totalTokens: 150 };

        tracker.track('openai', 'gpt-4', usage);

        const records = tracker.getPerCall();
        assert.strictEqual(records[0].runId, undefined);
      });

      it('copies usage object (not reference)', () => {
        const tracker = new UsageTracker();
        const usage: TokenUsage = { inputTokens: 100, outputTokens: 50, totalTokens: 150 };

        tracker.track('openai', 'gpt-4', usage);
        usage.inputTokens = 999; // Mutate original

        const records = tracker.getPerCall();
        assert.strictEqual(records[0].usage.inputTokens, 100);
      });
    });

    describe('getTotals', () => {
      it('returns zeros for empty tracker', () => {
        const tracker = new UsageTracker();

        const totals = tracker.getTotals();

        assert.deepStrictEqual(totals, { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
      });

      it('aggregates input and output tokens across calls', () => {
        const tracker = new UsageTracker();

        tracker.track('openai', 'gpt-4', { inputTokens: 100, outputTokens: 50, totalTokens: 150 });
        tracker.track('openai', 'gpt-4', { inputTokens: 200, outputTokens: 100, totalTokens: 300 });

        const totals = tracker.getTotals();

        assert.strictEqual(totals.inputTokens, 300);
        assert.strictEqual(totals.outputTokens, 150);
        assert.strictEqual(totals.totalTokens, 450);
      });

      it('filters by runId', () => {
        const tracker = new UsageTracker();

        tracker.track('openai', 'gpt-4', { inputTokens: 100, outputTokens: 50, totalTokens: 150 }, 'run-1');
        tracker.track('openai', 'gpt-4', { inputTokens: 200, outputTokens: 100, totalTokens: 300 }, 'run-2');

        const totalsRun1 = tracker.getTotals('run-1');
        const totalsRun2 = tracker.getTotals('run-2');

        assert.deepStrictEqual(totalsRun1, { inputTokens: 100, outputTokens: 50, totalTokens: 150 });
        assert.deepStrictEqual(totalsRun2, { inputTokens: 200, outputTokens: 100, totalTokens: 300 });
      });

      it('handles missing totalTokens (computes from input + output)', () => {
        const tracker = new UsageTracker();

        tracker.track('openai', 'gpt-4', { inputTokens: 100, outputTokens: 50 });

        const totals = tracker.getTotals();

        assert.strictEqual(totals.totalTokens, 150);
      });

      it('handles reasoningTokens in totals', () => {
        const tracker = new UsageTracker();

        tracker.track('openai', 'gpt-4', { inputTokens: 100, outputTokens: 50, totalTokens: 150, reasoningTokens: 20 });

        const totals = tracker.getTotals();

        // Note: getTotals doesn't track reasoningTokens separately, but totalTokens includes it
        assert.strictEqual(totals.totalTokens, 150);
      });
    });

    describe('reset', () => {
      it('clears all records when no runId provided', () => {
        const tracker = new UsageTracker();

        tracker.track('openai', 'gpt-4', { inputTokens: 100, outputTokens: 50, totalTokens: 150 });
        tracker.track('anthropic', 'claude-3', { inputTokens: 200, outputTokens: 100, totalTokens: 300 });

        tracker.reset();

        assert.strictEqual(tracker.getPerCall().length, 0);
        assert.deepStrictEqual(tracker.getTotals(), { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
      });

      it('clears only records for specific runId', () => {
        const tracker = new UsageTracker();

        tracker.track('openai', 'gpt-4', { inputTokens: 100, outputTokens: 50, totalTokens: 150 }, 'run-1');
        tracker.track('openai', 'gpt-4', { inputTokens: 200, outputTokens: 100, totalTokens: 300 }, 'run-2');

        tracker.reset('run-1');

        const remaining = tracker.getPerCall();
        assert.strictEqual(remaining.length, 1);
        assert.strictEqual(remaining[0].runId, 'run-2');
      });

      it('is no-op for non-existent runId', () => {
        const tracker = new UsageTracker();

        tracker.track('openai', 'gpt-4', { inputTokens: 100, outputTokens: 50, totalTokens: 150 }, 'run-1');
        tracker.reset('non-existent');

        assert.strictEqual(tracker.getPerCall().length, 1);
      });
    });

    describe('getPerCall', () => {
      it('returns copy of records (not reference)', () => {
        const tracker = new UsageTracker();
        tracker.track('openai', 'gpt-4', { inputTokens: 100, outputTokens: 50, totalTokens: 150 });

        const records1 = tracker.getPerCall();
        const records2 = tracker.getPerCall();

        assert.notStrictEqual(records1, records2);
        assert.deepStrictEqual(records1, records2);
      });

      it('filters by runId', () => {
        const tracker = new UsageTracker();

        tracker.track('openai', 'gpt-4', { inputTokens: 100, outputTokens: 50, totalTokens: 150 }, 'run-1');
        tracker.track('openai', 'gpt-4', { inputTokens: 200, outputTokens: 100, totalTokens: 300 }, 'run-2');

        const run1Records = tracker.getPerCall('run-1');
        assert.strictEqual(run1Records.length, 1);
        assert.strictEqual(run1Records[0].runId, 'run-1');
      });
    });
  });

  describe('aggregateUsage', () => {
    it('returns zeros for empty array', () => {
      const result = aggregateUsage([]);

      assert.deepStrictEqual(result, { inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    });

    it('sums inputTokens, outputTokens, and totalTokens', () => {
      const usages: TokenUsage[] = [
        { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
        { inputTokens: 200, outputTokens: 100, totalTokens: 300 },
        { inputTokens: 50, outputTokens: 25, totalTokens: 75 },
      ];

      const result = aggregateUsage(usages);

      assert.strictEqual(result.inputTokens, 350);
      assert.strictEqual(result.outputTokens, 175);
      assert.strictEqual(result.totalTokens, 525);
    });

    it('sums reasoningTokens when present', () => {
      const usages: TokenUsage[] = [
        { inputTokens: 100, outputTokens: 50, totalTokens: 150, reasoningTokens: 10 },
        { inputTokens: 200, outputTokens: 100, totalTokens: 300, reasoningTokens: 20 },
      ];

      const result = aggregateUsage(usages);

      assert.strictEqual(result.reasoningTokens, 30);
    });

    it('handles missing reasoningTokens (treats as 0)', () => {
      const usages: TokenUsage[] = [
        { inputTokens: 100, outputTokens: 50, totalTokens: 150, reasoningTokens: 10 },
        { inputTokens: 200, outputTokens: 100, totalTokens: 300 }, // no reasoningTokens
      ];

      const result = aggregateUsage(usages);

      assert.strictEqual(result.reasoningTokens, 10);
    });

    it('handles missing totalTokens (computes from input + output)', () => {
      const usages: TokenUsage[] = [
        { inputTokens: 100, outputTokens: 50 },
        { inputTokens: 200, outputTokens: 100 },
      ];

      const result = aggregateUsage(usages);

      assert.strictEqual(result.totalTokens, 450);
    });

    it('does not mutate input array', () => {
      const usages: TokenUsage[] = [
        { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      ];

      aggregateUsage(usages);

      assert.strictEqual(usages[0].inputTokens, 100);
    });
  });
});