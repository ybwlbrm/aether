/**
 * InMemoryArtifactStore Tests
 */

import { test, describe, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryArtifactStore } from './artifact-store.js';
import type { CreateArtifactInput, ArtifactRecord, ArtifactListFilter } from './artifact-store.js';

describe('InMemoryArtifactStore', () => {
  let store: InMemoryArtifactStore;

  beforeEach(() => {
    store = new InMemoryArtifactStore();
  });

  afterEach(() => {
    // No cleanup needed for in-memory store
  });

  const createInput = (overrides: Partial<CreateArtifactInput> = {}): CreateArtifactInput => ({
    name: 'test-artifact.txt',
    mimeType: 'text/plain',
    size: 100,
    ...overrides,
  });

  test('put/get round-trip: id and createdAt auto-filled', async () => {
    const input = createInput({ name: 'roundtrip.txt', runId: 'run-1', agentId: 'agent-1' });
    const record = await store.put(input);

    assert.ok(record.id, 'id should be generated');
    assert.match(record.id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i, 'id should be UUID v4');
    assert.ok(record.createdAt, 'createdAt should be generated');
    assert.ok(record.createdAt <= Date.now(), 'createdAt should be recent');
    assert.ok(record.createdAt > Date.now() - 1000, 'createdAt should be very recent');

    const retrieved = await store.get(record.id);
    assert.deepEqual(retrieved, record, 'retrieved record should match stored record');
  });

  test('get missing returns undefined', async () => {
    const result = await store.get('non-existent-id');
    assert.equal(result, undefined, 'get missing should return undefined');
  });

  test('delete returns true then false', async () => {
    const input = createInput({ name: 'delete-test.txt' });
    const record = await store.put(input);

    const firstDelete = await store.delete(record.id);
    assert.equal(firstDelete, true, 'first delete should return true');

    const secondDelete = await store.delete(record.id);
    assert.equal(secondDelete, false, 'second delete should return false');

    const retrieved = await store.get(record.id);
    assert.equal(retrieved, undefined, 'deleted artifact should not be retrievable');
  });

  test('list by runId filter', async () => {
    await store.put(createInput({ name: 'a.txt', runId: 'run-1' }));
    await store.put(createInput({ name: 'b.txt', runId: 'run-1' }));
    await store.put(createInput({ name: 'c.txt', runId: 'run-2' }));

    const run1Results = await store.list({ runId: 'run-1' });
    assert.equal(run1Results.length, 2, 'should find 2 artifacts for run-1');
    assert.ok(run1Results.every((a) => a.runId === 'run-1'), 'all results should have runId run-1');

    const run2Results = await store.list({ runId: 'run-2' });
    assert.equal(run2Results.length, 1, 'should find 1 artifact for run-2');
    assert.equal(run2Results[0].runId, 'run-2');
  });

  test('list by agentId filter', async () => {
    await store.put(createInput({ name: 'a.txt', agentId: 'agent-1' }));
    await store.put(createInput({ name: 'b.txt', agentId: 'agent-1' }));
    await store.put(createInput({ name: 'c.txt', agentId: 'agent-2' }));

    const agent1Results = await store.list({ agentId: 'agent-1' });
    assert.equal(agent1Results.length, 2, 'should find 2 artifacts for agent-1');
    assert.ok(agent1Results.every((a) => a.agentId === 'agent-1'), 'all results should have agentId agent-1');

    const agent2Results = await store.list({ agentId: 'agent-2' });
    assert.equal(agent2Results.length, 1, 'should find 1 artifact for agent-2');
    assert.equal(agent2Results[0].agentId, 'agent-2');
  });

  test('list ordering: createdAt descending (newest first)', async () => {
    const first = await store.put(createInput({ name: 'first.txt' }));
    // Small delay to ensure different timestamps
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await store.put(createInput({ name: 'second.txt' }));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const third = await store.put(createInput({ name: 'third.txt' }));

    const all = await store.list();
    assert.equal(all.length, 3);
    assert.equal(all[0].id, third.id, 'newest should be first');
    assert.equal(all[1].id, second.id, 'middle should be second');
    assert.equal(all[2].id, first.id, 'oldest should be last');
    assert.ok(all[0].createdAt >= all[1].createdAt, 'createdAt should be descending');
    assert.ok(all[1].createdAt >= all[2].createdAt, 'createdAt should be descending');
  });

  test('metadata preserved through put/get', async () => {
    const metadata = { customField: 'value', nested: { key: 123 }, array: [1, 2, 3] };
    const input = createInput({ name: 'meta.txt', metadata });
    const record = await store.put(input);

    assert.deepEqual(record.metadata, metadata, 'metadata should be preserved on put');

    const retrieved = await store.get(record.id);
    assert.deepEqual(retrieved?.metadata, metadata, 'metadata should be preserved on get');
  });

  test('list with combined filters', async () => {
    await store.put(createInput({ name: 'a.txt', runId: 'run-1', agentId: 'agent-1' }));
    await store.put(createInput({ name: 'b.txt', runId: 'run-1', agentId: 'agent-2' }));
    await store.put(createInput({ name: 'c.txt', runId: 'run-2', agentId: 'agent-1' }));

    const results = await store.list({ runId: 'run-1', agentId: 'agent-1' });
    assert.equal(results.length, 1, 'should find 1 artifact matching both filters');
    assert.equal(results[0].runId, 'run-1');
    assert.equal(results[0].agentId, 'agent-1');
  });

  test('list empty store returns empty array', async () => {
    const results = await store.list();
    assert.deepEqual(results, [], 'empty store should return empty array');
  });

  test('list with non-matching filter returns empty array', async () => {
    await store.put(createInput({ name: 'a.txt', runId: 'run-1' }));
    const results = await store.list({ runId: 'non-existent' });
    assert.deepEqual(results, [], 'non-matching filter should return empty array');
  });
});