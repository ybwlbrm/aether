/**
 * ArtifactRuntime Tests
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { ArtifactRuntime, ArtifactCreatedEvent } from './artifact-runtime.js';
import { InMemoryArtifactStore } from './artifact-store.js';
import { RuntimeError } from '../errors/index.js';
import type { CreateArtifactInput, ArtifactRecord, ArtifactListFilter } from './artifact-store.js';

describe('ArtifactRuntime', () => {
  let store: InMemoryArtifactStore;
  let runtime: ArtifactRuntime;

  beforeEach(() => {
    store = new InMemoryArtifactStore();
    runtime = new ArtifactRuntime(store, 'test-runtime');
  });

  afterEach(async () => {
    if (runtime.isRunning) {
      await runtime.stop();
    }
  });

  const createInput = (overrides: Partial<CreateArtifactInput> = {}): CreateArtifactInput => ({
    name: 'test-artifact.txt',
    mimeType: 'text/plain',
    size: 100,
    ...overrides,
  });

  test('createArtifact succeeds and returns record with uuid id', async () => {
    await runtime.start();

    const input = createInput({ name: 'create-test.txt', runId: 'run-1' });
    const artifact = await runtime.createArtifact(input);

    assert.ok(artifact.id, 'artifact should have id');
    assert.match(artifact.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, 'id should be UUID v4');
    assert.ok(artifact.createdAt, 'artifact should have createdAt');
    assert.equal(artifact.name, 'create-test.txt');
    assert.equal(artifact.runId, 'run-1');
    assert.equal(artifact.mimeType, 'text/plain');
    assert.equal(artifact.size, 100);
  });

  test('createArtifact emits artifact.created event captured via onEvent', async () => {
    await runtime.start();

    const events: ArtifactCreatedEvent[] = [];
    const unsubscribe = runtime.onEvent((event) => {
      if (event.type === 'artifact.created') {
        events.push(event as ArtifactCreatedEvent);
      }
    });

    const input = createInput({ name: 'event-test.txt' });
    const artifact = await runtime.createArtifact(input);

    assert.equal(events.length, 1, 'should emit exactly one artifact.created event');
    const emittedEvent = events[0];
    assert.equal(emittedEvent.type, 'artifact.created');
    assert.ok(emittedEvent.payload, 'event should have payload');
    assert.equal(emittedEvent.payload.id, artifact.id, 'event payload should match created artifact');
    assert.equal(emittedEvent.payload.name, 'event-test.txt');
    assert.ok(emittedEvent.timestamp, 'event should have timestamp');
    assert.equal(emittedEvent.runtimeName, 'test-runtime', 'event should have runtime name');

    unsubscribe();
  });

  test('createArtifact throws RuntimeError before start', async () => {
    const input = createInput({ name: 'no-start.txt' });

    await assert.rejects(
      runtime.createArtifact(input),
      (error: Error) => {
        assert.ok(error instanceof RuntimeError, 'should throw RuntimeError');
        assert.equal((error as RuntimeError).code, 'RUNTIME_NOT_RUNNING');
        return true;
      },
      'createArtifact should throw RuntimeError when not running'
    );
  });

  test('createArtifact throws RuntimeError after stop', async () => {
    await runtime.start();
    await runtime.stop();

    const input = createInput({ name: 'after-stop.txt' });

    await assert.rejects(
      runtime.createArtifact(input),
      (error: Error) => {
        assert.ok(error instanceof RuntimeError, 'should throw RuntimeError');
        assert.equal((error as RuntimeError).code, 'RUNTIME_NOT_RUNNING');
        return true;
      },
      'createArtifact should throw RuntimeError after stop'
    );
  });

  test('getArtifact returns the record', async () => {
    await runtime.start();

    const input = createInput({ name: 'get-test.txt', runId: 'run-1' });
    const created = await runtime.createArtifact(input);

    const retrieved = await runtime.getArtifact(created.id);
    assert.deepEqual(retrieved, created, 'getArtifact should return the created artifact');
  });

  test('getArtifact returns undefined for missing id', async () => {
    await runtime.start();

    const retrieved = await runtime.getArtifact('non-existent-id');
    assert.equal(retrieved, undefined, 'getArtifact should return undefined for missing id');
  });

  test('listArtifacts with filter works', async () => {
    await runtime.start();

    await runtime.createArtifact(createInput({ name: 'a.txt', runId: 'run-1', agentId: 'agent-1' }));
    await runtime.createArtifact(createInput({ name: 'b.txt', runId: 'run-1', agentId: 'agent-2' }));
    await runtime.createArtifact(createInput({ name: 'c.txt', runId: 'run-2', agentId: 'agent-1' }));

    const run1Results = await runtime.listArtifacts({ runId: 'run-1' });
    assert.equal(run1Results.length, 2, 'should find 2 artifacts for run-1');
    assert.ok(run1Results.every((a) => a.runId === 'run-1'));

    const agent1Results = await runtime.listArtifacts({ agentId: 'agent-1' });
    assert.equal(agent1Results.length, 2, 'should find 2 artifacts for agent-1');
    assert.ok(agent1Results.every((a) => a.agentId === 'agent-1'));

    const combinedResults = await runtime.listArtifacts({ runId: 'run-1', agentId: 'agent-1' });
    assert.equal(combinedResults.length, 1, 'should find 1 artifact matching both filters');
    assert.equal(combinedResults[0].runId, 'run-1');
    assert.equal(combinedResults[0].agentId, 'agent-1');
  });

  test('listArtifacts ordering: createdAt descending', async () => {
    await runtime.start();

    const first = await runtime.createArtifact(createInput({ name: 'first.txt' }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await runtime.createArtifact(createInput({ name: 'second.txt' }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const third = await runtime.createArtifact(createInput({ name: 'third.txt' }));

    const all = await runtime.listArtifacts();
    assert.equal(all.length, 3);
    assert.equal(all[0].id, third.id, 'newest should be first');
    assert.equal(all[1].id, second.id, 'middle should be second');
    assert.equal(all[2].id, first.id, 'oldest should be last');
  });

  test('start() required before createArtifact (Runtime lifecycle enforcement)', async () => {
    // Runtime starts in 'created' state
    assert.equal(runtime.state, 'created');
    assert.equal(runtime.isRunning, false);

    const input = createInput({ name: 'lifecycle-test.txt' });

    // Should throw before start
    await assert.rejects(
      runtime.createArtifact(input),
      (error: Error) => {
        assert.ok(error instanceof RuntimeError);
        assert.equal((error as RuntimeError).code, 'RUNTIME_NOT_RUNNING');
        return true;
      }
    );

    // Start the runtime
    await runtime.start();
    assert.equal(runtime.state, 'running');
    assert.equal(runtime.isRunning, true);

    // Should succeed after start
    const artifact = await runtime.createArtifact(input);
    assert.ok(artifact.id);

    // Stop the runtime
    await runtime.stop();
    assert.equal(runtime.state, 'stopped');
    assert.equal(runtime.isRunning, false);

    // Should throw after stop
    await assert.rejects(
      runtime.createArtifact(input),
      (error: Error) => {
        assert.ok(error instanceof RuntimeError);
        assert.equal((error as RuntimeError).code, 'RUNTIME_NOT_RUNNING');
        return true;
      }
    );
  });

  test('stop() works and transitions state correctly', async () => {
    assert.equal(runtime.state, 'created');

    await runtime.start();
    assert.equal(runtime.state, 'running');

    await runtime.stop();
    assert.equal(runtime.state, 'stopped');

    // Cannot stop again
    await assert.rejects(
      runtime.stop(),
      (error: Error) => {
        assert.ok(error instanceof RuntimeError);
        assert.equal((error as RuntimeError).code, 'RUNTIME_NOT_RUNNING');
        return true;
      }
    );
  });

  test('getArtifact and listArtifacts work without start (read-only ops)', async () => {
    // Pre-populate store directly
    const artifact = await store.put(createInput({ name: 'prepopulated.txt', runId: 'run-1' }));

    // These should work without runtime being started
    const retrieved = await runtime.getArtifact(artifact.id);
    assert.deepEqual(retrieved, artifact);

    const listed = await runtime.listArtifacts({ runId: 'run-1' });
    assert.equal(listed.length, 1);
    assert.equal(listed[0].id, artifact.id);
  });

  test('runtime emits lifecycle events', async () => {
    const events: string[] = [];
    runtime.onEvent((event) => {
      events.push(event.type);
    });

    await runtime.start();
    assert.ok(events.includes('runtime:starting'), 'should emit runtime:starting');
    assert.ok(events.includes('runtime:started'), 'should emit runtime:started');

    await runtime.stop();
    assert.ok(events.includes('runtime:stopping'), 'should emit runtime:stopping');
    assert.ok(events.includes('runtime:stopped'), 'should emit runtime:stopped');
  });
});