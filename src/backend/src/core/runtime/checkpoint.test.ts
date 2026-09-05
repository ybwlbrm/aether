/**
 * Checkpoint Tests
 *
 * Tests for the core/runtime checkpoint module (P1-08).
 * Run with: npm run test -w src/backend (after build)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Import types from source for compile-time checking
import type { Checkpoint } from './checkpoint.js';
import type { RunStatus } from './run.js';
// Import runtime values from built dist
const { serializeCheckpoint, deserializeCheckpoint, createCheckpoint } = await import('./index.js');
const { RuntimeError } = await import('../errors/index.js');

describe('core/runtime/checkpoint', () => {
  describe('serializeCheckpoint / deserializeCheckpoint round-trip', () => {
    it('preserves all fields', () => {
      const original: Checkpoint = {
        runId: 'run-123',
        status: 'running',
        state: { step: 5, data: { key: 'value', count: 42 } },
        context: { taskId: 'task-456', agentId: 'agent-789' },
        timestamp: '2024-01-15T10:30:00.000Z',
        seq: 7,
      };

      const serialized = serializeCheckpoint(original);
      const deserialized = deserializeCheckpoint(serialized);

      assert.deepEqual(deserialized, original);
    });

    it('preserves all RunStatus values', () => {
      const statuses: RunStatus[] = [
        'created',
        'running',
        'waiting',
        'completed',
        'failed',
        'cancelled',
        'interrupted',
      ];

      for (const status of statuses) {
        const original: Checkpoint = {
          runId: 'run-1',
          status,
          state: {},
          context: {},
          timestamp: '2024-01-01T00:00:00.000Z',
          seq: 1,
        };

        const serialized = serializeCheckpoint(original);
        const deserialized = deserializeCheckpoint(serialized);
        assert.equal(deserialized.status, status);
      }
    });

    it('preserves complex nested state', () => {
      const original: Checkpoint = {
        runId: 'run-1',
        status: 'running',
        state: {
          messages: [
            { role: 'user', content: 'Hello' },
            { role: 'assistant', content: 'Hi!' },
          ],
          metadata: {
            tokens: { input: 100, output: 50 },
            model: 'gpt-4',
            nested: { deep: { value: true } },
          },
        },
        context: { taskId: 'task-1', agentId: 'agent-1' },
        timestamp: '2024-01-01T00:00:00.000Z',
        seq: 5,
      };

      const serialized = serializeCheckpoint(original);
      const deserialized = deserializeCheckpoint(serialized);

      assert.deepEqual(deserialized.state, original.state);
      assert.deepEqual(deserialized.context, original.context);
    });

    it('includes version envelope in serialized output', () => {
      const original: Checkpoint = {
        runId: 'run-1',
        status: 'running',
        state: { test: true },
        context: {},
        timestamp: '2024-01-01T00:00:00.000Z',
        seq: 1,
      };

      const serialized = serializeCheckpoint(original);
      const parsed = JSON.parse(serialized);

      assert.equal(parsed.v, 1);
      assert.ok(parsed.checkpoint);
      assert.equal(parsed.checkpoint.runId, 'run-1');
    });
  });

  describe('deserializeCheckpoint error handling', () => {
    it('throws RuntimeError INVALID_CHECKPOINT on garbage JSON', () => {
      assert.throws(
        () => deserializeCheckpoint('not valid json'),
        (err: Error) => {
          assert.ok(err instanceof RuntimeError);
          assert.equal(err.code, 'INVALID_CHECKPOINT');
          assert.equal(err.retryable, false);
          return true;
        },
        'Expected RuntimeError on garbage JSON'
      );
    });

    it('throws RuntimeError INVALID_CHECKPOINT on empty string', () => {
      assert.throws(
        () => deserializeCheckpoint(''),
        (err: Error) => {
          assert.ok(err instanceof RuntimeError);
          assert.equal(err.code, 'INVALID_CHECKPOINT');
          return true;
        },
        'Expected RuntimeError on empty string'
      );
    });

    it('throws RuntimeError INVALID_CHECKPOINT on missing status', () => {
      const badCheckpoint = {
        v: 1,
        checkpoint: {
          runId: 'run-1',
          // status missing
          state: {},
          context: {},
          timestamp: '2024-01-01T00:00:00.000Z',
          seq: 1,
        },
      };

      assert.throws(
        () => deserializeCheckpoint(JSON.stringify(badCheckpoint)),
        (err: Error) => {
          assert.ok(err instanceof RuntimeError);
          assert.equal(err.code, 'INVALID_CHECKPOINT');
          return true;
        },
        'Expected RuntimeError on missing status'
      );
    });

    it('throws RuntimeError INVALID_CHECKPOINT on invalid status value', () => {
      const badCheckpoint = {
        v: 1,
        checkpoint: {
          runId: 'run-1',
          status: 'invalid-status',
          state: {},
          context: {},
          timestamp: '2024-01-01T00:00:00.000Z',
          seq: 1,
        },
      };

      assert.throws(
        () => deserializeCheckpoint(JSON.stringify(badCheckpoint)),
        (err: Error) => {
          assert.ok(err instanceof RuntimeError);
          assert.equal(err.code, 'INVALID_CHECKPOINT');
          assert.ok(err.context);
          assert.equal(err.context?.status, 'invalid-status');
          return true;
        },
        'Expected RuntimeError on invalid status'
      );
    });

    it('throws RuntimeError INVALID_CHECKPOINT on missing runId', () => {
      const badCheckpoint = {
        v: 1,
        checkpoint: {
          // runId missing
          status: 'running',
          state: {},
          context: {},
          timestamp: '2024-01-01T00:00:00.000Z',
          seq: 1,
        },
      };

      assert.throws(
        () => deserializeCheckpoint(JSON.stringify(badCheckpoint)),
        (err: Error) => {
          assert.ok(err instanceof RuntimeError);
          assert.equal(err.code, 'INVALID_CHECKPOINT');
          return true;
        },
        'Expected RuntimeError on missing runId'
      );
    });

    it('throws RuntimeError INVALID_CHECKPOINT on empty runId', () => {
      const badCheckpoint = {
        v: 1,
        checkpoint: {
          runId: '',
          status: 'running',
          state: {},
          context: {},
          timestamp: '2024-01-01T00:00:00.000Z',
          seq: 1,
        },
      };

      assert.throws(
        () => deserializeCheckpoint(JSON.stringify(badCheckpoint)),
        (err: Error) => {
          assert.ok(err instanceof RuntimeError);
          assert.equal(err.code, 'INVALID_CHECKPOINT');
          return true;
        },
        'Expected RuntimeError on empty runId'
      );
    });

    it('throws RuntimeError INVALID_CHECKPOINT on missing state', () => {
      const badCheckpoint = {
        v: 1,
        checkpoint: {
          runId: 'run-1',
          status: 'running',
          // state missing
          context: {},
          timestamp: '2024-01-01T00:00:00.000Z',
          seq: 1,
        },
      };

      assert.throws(
        () => deserializeCheckpoint(JSON.stringify(badCheckpoint)),
        (err: Error) => {
          assert.ok(err instanceof RuntimeError);
          assert.equal(err.code, 'INVALID_CHECKPOINT');
          return true;
        },
        'Expected RuntimeError on missing state'
      );
    });

    it('throws RuntimeError INVALID_CHECKPOINT on array state', () => {
      const badCheckpoint = {
        v: 1,
        checkpoint: {
          runId: 'run-1',
          status: 'running',
          state: [], // Array instead of object
          context: {},
          timestamp: '2024-01-01T00:00:00.000Z',
          seq: 1,
        },
      };

      assert.throws(
        () => deserializeCheckpoint(JSON.stringify(badCheckpoint)),
        (err: Error) => {
          assert.ok(err instanceof RuntimeError);
          assert.equal(err.code, 'INVALID_CHECKPOINT');
          return true;
        },
        'Expected RuntimeError on array state'
      );
    });

    it('throws RuntimeError INVALID_CHECKPOINT on missing context', () => {
      const badCheckpoint = {
        v: 1,
        checkpoint: {
          runId: 'run-1',
          status: 'running',
          state: {},
          // context missing
          timestamp: '2024-01-01T00:00:00.000Z',
          seq: 1,
        },
      };

      assert.throws(
        () => deserializeCheckpoint(JSON.stringify(badCheckpoint)),
        (err: Error) => {
          assert.ok(err instanceof RuntimeError);
          assert.equal(err.code, 'INVALID_CHECKPOINT');
          return true;
        },
        'Expected RuntimeError on missing context'
      );
    });

    it('throws RuntimeError INVALID_CHECKPOINT on missing timestamp', () => {
      const badCheckpoint = {
        v: 1,
        checkpoint: {
          runId: 'run-1',
          status: 'running',
          state: {},
          context: {},
          // timestamp missing
          seq: 1,
        },
      };

      assert.throws(
        () => deserializeCheckpoint(JSON.stringify(badCheckpoint)),
        (err: Error) => {
          assert.ok(err instanceof RuntimeError);
          assert.equal(err.code, 'INVALID_CHECKPOINT');
          return true;
        },
        'Expected RuntimeError on missing timestamp'
      );
    });

    it('throws RuntimeError INVALID_CHECKPOINT on invalid timestamp format', () => {
      const badCheckpoint = {
        v: 1,
        checkpoint: {
          runId: 'run-1',
          status: 'running',
          state: {},
          context: {},
          timestamp: 'not-a-valid-timestamp',
          seq: 1,
        },
      };

      assert.throws(
        () => deserializeCheckpoint(JSON.stringify(badCheckpoint)),
        (err: Error) => {
          assert.ok(err instanceof RuntimeError);
          assert.equal(err.code, 'INVALID_CHECKPOINT');
          assert.ok(err.context);
          assert.equal(err.context?.timestamp, 'not-a-valid-timestamp');
          return true;
        },
        'Expected RuntimeError on invalid timestamp'
      );
    });

    it('throws RuntimeError INVALID_CHECKPOINT on missing seq', () => {
      const badCheckpoint = {
        v: 1,
        checkpoint: {
          runId: 'run-1',
          status: 'running',
          state: {},
          context: {},
          timestamp: '2024-01-01T00:00:00.000Z',
          // seq missing
        },
      };

      assert.throws(
        () => deserializeCheckpoint(JSON.stringify(badCheckpoint)),
        (err: Error) => {
          assert.ok(err instanceof RuntimeError);
          assert.equal(err.code, 'INVALID_CHECKPOINT');
          return true;
        },
        'Expected RuntimeError on missing seq'
      );
    });

    it('throws RuntimeError INVALID_CHECKPOINT on non-integer seq', () => {
      const badCheckpoint = {
        v: 1,
        checkpoint: {
          runId: 'run-1',
          status: 'running',
          state: {},
          context: {},
          timestamp: '2024-01-01T00:00:00.000Z',
          seq: 1.5, // Not integer
        },
      };

      assert.throws(
        () => deserializeCheckpoint(JSON.stringify(badCheckpoint)),
        (err: Error) => {
          assert.ok(err instanceof RuntimeError);
          assert.equal(err.code, 'INVALID_CHECKPOINT');
          assert.ok(err.context);
          assert.equal(err.context?.seq, 1.5);
          return true;
        },
        'Expected RuntimeError on non-integer seq'
      );
    });

    it('throws RuntimeError INVALID_CHECKPOINT on negative seq', () => {
      const badCheckpoint = {
        v: 1,
        checkpoint: {
          runId: 'run-1',
          status: 'running',
          state: {},
          context: {},
          timestamp: '2024-01-01T00:00:00.000Z',
          seq: -1,
        },
      };

      assert.throws(
        () => deserializeCheckpoint(JSON.stringify(badCheckpoint)),
        (err: Error) => {
          assert.ok(err instanceof RuntimeError);
          assert.equal(err.code, 'INVALID_CHECKPOINT');
          assert.ok(err.context);
          assert.equal(err.context?.seq, -1);
          return true;
        },
        'Expected RuntimeError on negative seq'
      );
    });

    it('throws RuntimeError INVALID_CHECKPOINT on unsupported version', () => {
      const badCheckpoint = {
        v: 2, // Unsupported version
        checkpoint: {
          runId: 'run-1',
          status: 'running',
          state: {},
          context: {},
          timestamp: '2024-01-01T00:00:00.000Z',
          seq: 1,
        },
      };

      assert.throws(
        () => deserializeCheckpoint(JSON.stringify(badCheckpoint)),
        (err: Error) => {
          assert.ok(err instanceof RuntimeError);
          assert.equal(err.code, 'INVALID_CHECKPOINT');
          assert.ok(err.context);
          assert.equal(err.context?.version, 2);
          return true;
        },
        'Expected RuntimeError on unsupported version'
      );
    });

    it('throws RuntimeError INVALID_CHECKPOINT on missing checkpoint object', () => {
      const badCheckpoint = {
        v: 1,
        // checkpoint missing
      };

      assert.throws(
        () => deserializeCheckpoint(JSON.stringify(badCheckpoint)),
        (err: Error) => {
          assert.ok(err instanceof RuntimeError);
          assert.equal(err.code, 'INVALID_CHECKPOINT');
          return true;
        },
        'Expected RuntimeError on missing checkpoint object'
      );
    });
  });

  describe('createCheckpoint factory', () => {
    it('sets timestamp to current ISO string', () => {
      const before = new Date().toISOString();
      const cp = createCheckpoint('run-1', 'running', { step: 1 }, { taskId: 'task-1' }, 1);
      const after = new Date().toISOString();

      assert.ok(cp.timestamp >= before);
      assert.ok(cp.timestamp <= after);
    });

    it('respects seq argument', () => {
      const cp1 = createCheckpoint('run-1', 'running', {}, {}, 5);
      const cp2 = createCheckpoint('run-1', 'running', {}, {}, 10);

      assert.equal(cp1.seq, 5);
      assert.equal(cp2.seq, 10);
    });

    it('sets all provided fields', () => {
      const cp = createCheckpoint(
        'run-123',
        'waiting',
        { step: 3, data: 'test' },
        { taskId: 'task-456', agentId: 'agent-789' },
        42
      );

      assert.equal(cp.runId, 'run-123');
      assert.equal(cp.status, 'waiting');
      assert.deepEqual(cp.state, { step: 3, data: 'test' });
      assert.deepEqual(cp.context, { taskId: 'task-456', agentId: 'agent-789' });
      assert.equal(cp.seq, 42);
      assert.ok(cp.timestamp);
    });

    it('context is optional and defaults to empty object', () => {
      const cp = createCheckpoint('run-1', 'running', { step: 1 }, undefined, 1);

      assert.deepEqual(cp.context, {});
    });

    it('created checkpoint can be serialized and deserialized', () => {
      const cp = createCheckpoint('run-1', 'completed', { result: 'done' }, { agentId: 'agent-1' }, 10);
      const serialized = serializeCheckpoint(cp);
      const deserialized = deserializeCheckpoint(serialized);

      assert.deepEqual(deserialized, cp);
    });
  });
});