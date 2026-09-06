/**
 * Cancel Integration Tests (P0-01/P0-02)
 *
 * Tests concurrent run cancellation isolation within the same conversation.
 * Verifies that cancelling one run does not affect other runs in the same conversation.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../../db/migrate.js';
import { initDb, getDb } from '../../db/client.js';
import { makeTestConfig } from '../../tests/helpers/mock-provider.sse.js';
import type { BackendConfig } from '../../config/index.js';
import { runCancellationRegistry } from '../../lib/run-cancellation-registry.js';

let cfg: BackendConfig;
let dir: string;

describe('modules/runs/cancel-integration', () => {
  beforeEach(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pacc-cancel-int-'));
    cfg = makeTestConfig(dir);
    await runMigrations(cfg as never);
    await initDb(cfg as never);
    runCancellationRegistry.clear();
  });

  afterEach(() => {
    runCancellationRegistry.clear();
    rmSync(dir, { recursive: true, force: true });
  });

  it('two runs in same conversation: cancel one, other remains active', () => {
    const controllerA = new AbortController();
    const controllerB = new AbortController();

    // Register two runs for the same conversation
    runCancellationRegistry.register('run-A', 'conv-1', controllerA);
    runCancellationRegistry.register('run-B', 'conv-1', controllerB);

    // Verify both are registered
    assert.equal(runCancellationRegistry.size, 2);
    assert.equal(runCancellationRegistry.runIdsForConversation('conv-1').length, 2);

    // Cancel run-A only
    const cancelledA = runCancellationRegistry.cancel('run-A');
    assert.equal(cancelledA, true);
    assert.equal(controllerA.signal.aborted, true);

    // run-B should be unaffected
    assert.equal(controllerB.signal.aborted, false);
    assert.equal(runCancellationRegistry.has('run-B'), true);

    // runIdsForConversation should still include run-B (until unregistered)
    const remaining = runCancellationRegistry.runIdsForConversation('conv-1');
    assert.ok(remaining.includes('run-B'));
  });

  it('cancelConversation aborts all runs for that conversation only', () => {
    const controllerA = new AbortController();
    const controllerB = new AbortController();
    const controllerC = new AbortController();

    // Register runs across two conversations
    runCancellationRegistry.register('run-A', 'conv-1', controllerA);
    runCancellationRegistry.register('run-B', 'conv-1', controllerB);
    runCancellationRegistry.register('run-C', 'conv-2', controllerC);

    // Cancel all runs in conv-1
    const cancelled = runCancellationRegistry.cancelConversation('conv-1');

    assert.deepEqual(cancelled.sort(), ['run-A', 'run-B']);
    assert.equal(controllerA.signal.aborted, true);
    assert.equal(controllerB.signal.aborted, true);
    assert.equal(controllerC.signal.aborted, false); // conv-2 unaffected

    // Only conv-2 runs remain
    assert.equal(runCancellationRegistry.size, 1);
    assert.equal(runCancellationRegistry.has('run-C'), true);
  });

  it('cancel on already-terminal run is idempotent', () => {
    const controller = new AbortController();
    runCancellationRegistry.register('run-1', 'conv-1', controller);

    // First cancel
    assert.equal(runCancellationRegistry.cancel('run-1'), true);
    assert.equal(controller.signal.aborted, true);

    // Second cancel (should be idempotent - returns false since controller already aborted)
    // Note: cancel() returns false if run not found, but run is still registered until unregister
    // The controller.abort() is idempotent in DOM spec
    assert.equal(runCancellationRegistry.cancel('run-1'), true); // run still exists in registry
    assert.equal(controller.signal.aborted, true);
  });

  it('unregister removes run from registry but does not abort', () => {
    const controller = new AbortController();
    runCancellationRegistry.register('run-1', 'conv-1', controller);

    runCancellationRegistry.unregister('run-1');

    assert.equal(runCancellationRegistry.has('run-1'), false);
    assert.equal(controller.signal.aborted, false); // NOT aborted by unregister
    assert.equal(runCancellationRegistry.size, 0);
  });

  it('concurrent cancelConversation and individual cancel do not conflict', () => {
    const controllerA = new AbortController();
    const controllerB = new AbortController();
    const controllerC = new AbortController();

    runCancellationRegistry.register('run-A', 'conv-1', controllerA);
    runCancellationRegistry.register('run-B', 'conv-1', controllerB);
    runCancellationRegistry.register('run-C', 'conv-1', controllerC);

    // Cancel run-A individually
    runCancellationRegistry.cancel('run-A');
    assert.equal(controllerA.signal.aborted, true);

    // Then cancelConversation for conv-1 (should cancel B and C)
    const cancelled = runCancellationRegistry.cancelConversation('conv-1');
    assert.deepEqual(cancelled.sort(), ['run-B', 'run-C']); // run-A already cancelled, not in list
    assert.equal(controllerB.signal.aborted, true);
    assert.equal(controllerC.signal.aborted, true);
  });

  it('registry operations are synchronous and deterministic', () => {
    const controller = new AbortController();
    runCancellationRegistry.register('run-1', 'conv-1', controller);

    // All operations complete synchronously
    const hasBefore = runCancellationRegistry.has('run-1');
    const getResult = runCancellationRegistry.get('run-1');
    const sizeBefore = runCancellationRegistry.size;

    runCancellationRegistry.cancel('run-1');

    const aborted = controller.signal.aborted;
    const hasAfterCancel = runCancellationRegistry.has('run-1'); // Still registered until unregister

    runCancellationRegistry.unregister('run-1');

    const hasAfterUnregister = runCancellationRegistry.has('run-1');
    const sizeAfter = runCancellationRegistry.size;

    assert.equal(hasBefore, true);
    assert.equal(getResult, controller);
    assert.equal(sizeBefore, 1);
    assert.equal(aborted, true);
    assert.equal(hasAfterCancel, true); // cancel doesn't unregister
    assert.equal(hasAfterUnregister, false);
    assert.equal(sizeAfter, 0);
  });
});