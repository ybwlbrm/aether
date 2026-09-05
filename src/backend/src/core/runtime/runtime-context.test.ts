/**
 * RuntimeContext Tests
 *
 * Tests for the core/runtime runtime-context module (P1-03).
 * Run with: npm run test -w src/backend (after build)
 */

import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

// Import after build — tests run from dist/
const { createRuntimeContext } = await import('./index.js');
import type { RuntimeContext } from './runtime-context.js';

describe('core/runtime/runtime-context', () => {
  describe('createRuntimeContext', () => {
    it('sets runId, taskId, agentId', () => {
      const ctx = createRuntimeContext({
        runId: 'run-123',
        taskId: 'task-456',
        agentId: 'agent-789',
      });

      assert.equal(ctx.runId, 'run-123');
      assert.equal(ctx.taskId, 'task-456');
      assert.equal(ctx.agentId, 'agent-789');
    });

    it('signal is AbortSignal', () => {
      const ctx = createRuntimeContext({ runId: 'run-1' });
      assert.ok(ctx.signal instanceof AbortSignal);
      assert.equal(ctx.signal.aborted, false);
    });

    it('get/set round-trip', () => {
      const ctx = createRuntimeContext({ runId: 'run-1' });

      ctx.set('key1', 'value1');
      ctx.set('key2', 42);
      ctx.set('key3', { nested: true });

      assert.equal(ctx.get<string>('key1'), 'value1');
      assert.equal(ctx.get<number>('key2'), 42);
      assert.deepEqual(ctx.get<{ nested: boolean }>('key3'), { nested: true });
    });

    it('unknown key returns undefined', () => {
      const ctx = createRuntimeContext({ runId: 'run-1' });
      assert.equal(ctx.get('nonexistent'), undefined);
      assert.equal(ctx.get<string>('nonexistent'), undefined);
    });

    it('initialStore from Map works', () => {
      const initialStore = new Map<string, unknown>([
        ['fromMap', 'map-value'],
        ['count', 10],
      ]);

      const ctx = createRuntimeContext({
        runId: 'run-1',
        initialStore,
      });

      assert.equal(ctx.get('fromMap'), 'map-value');
      assert.equal(ctx.get('count'), 10);
    });

    it('initialStore from Record works', () => {
      const ctx = createRuntimeContext({
        runId: 'run-1',
        initialStore: { fromRecord: 'record-value', flag: true },
      });

      assert.equal(ctx.get('fromRecord'), 'record-value');
      assert.equal(ctx.get('flag'), true);
    });

    it('parentSignal abort propagates to context signal', () => {
      const parentController = new AbortController();
      const ctx = createRuntimeContext({
        runId: 'run-1',
        parentSignal: parentController.signal,
      });

      assert.equal(ctx.signal.aborted, false);

      parentController.abort('parent reason');

      assert.equal(ctx.signal.aborted, true);
      assert.equal(ctx.signal.reason, 'parent reason');
    });

    it('parentSignal already aborted propagates immediately', () => {
      const parentController = new AbortController();
      parentController.abort('already aborted');

      const ctx = createRuntimeContext({
        runId: 'run-1',
        parentSignal: parentController.signal,
      });

      assert.equal(ctx.signal.aborted, true);
      assert.equal(ctx.signal.reason, 'already aborted');
    });

    it('context has abort method', () => {
      const ctx = createRuntimeContext({ runId: 'run-1' });
      assert.equal(ctx.signal.aborted, false);

      // @ts-expect-error - abort is added via Object.defineProperty
      ctx.abort('manual abort');

      assert.equal(ctx.signal.aborted, true);
      assert.equal(ctx.signal.reason, 'manual abort');
    });

    it('taskId and agentId are optional', () => {
      const ctx = createRuntimeContext({ runId: 'run-1' });
      assert.equal(ctx.taskId, undefined);
      assert.equal(ctx.agentId, undefined);
    });

    it('store is a Map instance', () => {
      const ctx = createRuntimeContext({ runId: 'run-1' });
      assert.ok(ctx.store instanceof Map);
    });

    it('get returns typed value', () => {
      const ctx = createRuntimeContext({ runId: 'run-1' });
      ctx.set('typed', { a: 1, b: 'two' });

      const value = ctx.get<{ a: number; b: string }>('typed');
      assert.ok(value !== undefined);
      assert.equal(value?.a, 1);
      assert.equal(value?.b, 'two');
    });
  });
});