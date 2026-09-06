/**
 * RunCancellationRegistry tests (P0-01/P0-02)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { RunCancellationRegistry } from './run-cancellation-registry.js';

describe('lib/run-cancellation-registry', () => {
  let registry: RunCancellationRegistry;

  beforeEach(() => {
    registry = new RunCancellationRegistry();
  });

  afterEach(() => {
    registry.clear();
  });

  it('registers a run and retrieves its controller', () => {
    const controller = new AbortController();
    registry.register('run-1', 'conv-1', controller);

    assert.equal(registry.has('run-1'), true);
    assert.equal(registry.get('run-1'), controller);
    assert.equal(registry.size, 1);
  });

  it('throws when registering duplicate runId', () => {
    const controller1 = new AbortController();
    const controller2 = new AbortController();
    registry.register('run-1', 'conv-1', controller1);

    assert.throws(
      () => registry.register('run-1', 'conv-2', controller2),
      /already registered/
    );
  });

  it('cancels a run by aborting its controller', () => {
    const controller = new AbortController();
    registry.register('run-1', 'conv-1', controller);

    const result = registry.cancel('run-1');
    assert.equal(result, true);
    assert.equal(controller.signal.aborted, true);
  });

  it('returns false when cancelling non-existent run', () => {
    const result = registry.cancel('non-existent');
    assert.equal(result, false);
  });

  it('unregisters a run without aborting', () => {
    const controller = new AbortController();
    registry.register('run-1', 'conv-1', controller);

    const result = registry.unregister('run-1');
    assert.equal(result, true);
    assert.equal(controller.signal.aborted, false); // NOT aborted
    assert.equal(registry.has('run-1'), false);
    assert.equal(registry.size, 0);
  });

  it('returns false when unregistering non-existent run', () => {
    const result = registry.unregister('non-existent');
    assert.equal(result, false);
  });

  it('cancelConversation aborts all runs for a conversation', () => {
    const controller1 = new AbortController();
    const controller2 = new AbortController();
    const controller3 = new AbortController();

    registry.register('run-1', 'conv-1', controller1);
    registry.register('run-2', 'conv-1', controller2);
    registry.register('run-3', 'conv-2', controller3);

    const cancelled = registry.cancelConversation('conv-1');

    assert.deepEqual(cancelled.sort(), ['run-1', 'run-2']);
    assert.equal(controller1.signal.aborted, true);
    assert.equal(controller2.signal.aborted, true);
    assert.equal(controller3.signal.aborted, false); // Different conversation
    assert.equal(registry.size, 1); // run-3 still registered
  });

  it('cancelConversation returns empty array for conversation with no runs', () => {
    const cancelled = registry.cancelConversation('non-existent');
    assert.deepEqual(cancelled, []);
  });

  it('runIdsForConversation returns all runIds for a conversation', () => {
    registry.register('run-1', 'conv-1', new AbortController());
    registry.register('run-2', 'conv-1', new AbortController());
    registry.register('run-3', 'conv-2', new AbortController());

    const runIds = registry.runIdsForConversation('conv-1');
    assert.deepEqual(runIds.sort(), ['run-1', 'run-2']);
  });

  it('runIdsForConversation returns empty array for conversation with no runs', () => {
    const runIds = registry.runIdsForConversation('non-existent');
    assert.deepEqual(runIds, []);
  });

  it('concurrent runs in same conversation are isolated (cancel one does not affect other)', () => {
    const controllerA = new AbortController();
    const controllerB = new AbortController();

    registry.register('run-A', 'conv-1', controllerA);
    registry.register('run-B', 'conv-1', controllerB);

    // Cancel run-A only
    registry.cancel('run-A');

    assert.equal(controllerA.signal.aborted, true);
    assert.equal(controllerB.signal.aborted, false); // run-B unaffected
    assert.equal(registry.has('run-A'), true); // Still registered until unregister
    assert.equal(registry.has('run-B'), true);
  });

  it('unregister after cancel removes the run', () => {
    const controller = new AbortController();
    registry.register('run-1', 'conv-1', controller);

    registry.cancel('run-1');
    registry.unregister('run-1');

    assert.equal(registry.has('run-1'), false);
    assert.equal(registry.size, 0);
  });

  it('clear removes all entries', () => {
    registry.register('run-1', 'conv-1', new AbortController());
    registry.register('run-2', 'conv-2', new AbortController());

    registry.clear();

    assert.equal(registry.size, 0);
    assert.equal(registry.has('run-1'), false);
    assert.equal(registry.has('run-2'), false);
  });

  it('singleton instance is exported', async () => {
    // This test verifies the singleton export exists
    const { runCancellationRegistry } = await import('./run-cancellation-registry.js');
    assert.ok(runCancellationRegistry instanceof RunCancellationRegistry);
  });
});