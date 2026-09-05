/**
 * MemoryRuntimeBridge tests (Phase 7 — legacy memory.json → core MemoryStore)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JsonFileMemoryStore } from './memory-runtime-bridge.js';
import { MemoryRetriever } from '../core/memory/index.js';

let dir: string;
let filePath: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), 'pacc-mem-bridge-'));
  filePath = join(dir, 'memory.json');
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('lib/memory-runtime-bridge (JsonFileMemoryStore)', () => {
  it('put + get round-trip preserves fields with defaults', async () => {
    const store = new JsonFileMemoryStore(filePath);
    const saved = await store.put({ id: 'm1', type: 'preference', content: 'user likes dark mode', scope: 'user' });

    assert.equal(saved.id, 'm1');
    assert.ok(saved.createdAt, 'createdAt set');
    assert.ok(saved.updatedAt, 'updatedAt set');
    assert.equal(saved.confidence, 1);

    const got = await store.get('m1');
    assert.ok(got);
    assert.equal(got!.content, 'user likes dark mode');
    assert.equal(got!.type, 'preference');
  });

  it('put preserves an explicit id (id is required by the core MemoryEntry type)', async () => {
    const store = new JsonFileMemoryStore(filePath);
    const saved = await store.put({ id: 'explicit-1', type: 'misc', content: 'explicit id', scope: 'project' });
    assert.equal(saved.id, 'explicit-1');
  });

  it('get missing returns undefined', async () => {
    const store = new JsonFileMemoryStore(filePath);
    const got = await store.get('does-not-exist');
    assert.equal(got, undefined);
  });

  it('query filters by type and contentContains with ordering', async () => {
    const store = new JsonFileMemoryStore(filePath);
    await store.put({ id: 'q1', type: 'fact', content: 'aether is local-first', scope: 'user' });
    await store.put({ id: 'q2', type: 'preference', content: 'likes keyboard shortcuts', scope: 'user' });
    await store.put({ id: 'q3', type: 'fact', content: 'aether uses sql.js', scope: 'user' });

    const facts = await store.query({ type: 'fact' });
    assert.equal(facts.length, 2);

    const aether = await store.query({ contentContains: 'aether' });
    assert.equal(aether.length, 2);

    const scoped = await store.query({ scope: 'project' });
    assert.ok(scoped.length >= 1, 'project-scoped memory found');
  });

  it('delete returns true for existing, false for missing', async () => {
    const store = new JsonFileMemoryStore(filePath);
    await store.put({ id: 'del-1', type: 'fact', content: 'to delete', scope: 'user' });

    assert.equal(await store.delete('del-1'), true);
    assert.equal(await store.delete('del-1'), false);
    assert.equal(await store.get('del-1'), undefined);
  });

  it('reads legacy memory.json rows written by the old DAL shape', () => {
    // Simulate a memory.json written by the legacy DAL (MemoryItem shape)
    const legacyRows = [
      { id: 'legacy-1', content: 'old memory item', active: true, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z', category: 'manual' },
    ];
    writeFileSync(filePath, JSON.stringify(legacyRows));

    const store = new JsonFileMemoryStore(filePath);
    return store.get('legacy-1').then((entry) => {
      assert.ok(entry, 'legacy row readable');
      assert.equal(entry!.content, 'old memory item');
      assert.equal(entry!.type, 'manual');
      assert.equal(entry!.scope, 'user');
    });
  });

  it('works with the core MemoryRetriever (keyword scoring)', async () => {
    const store = new JsonFileMemoryStore(filePath);
    await store.put({ id: 'r1', type: 'fact', content: 'deploy uses supabase sync', scope: 'user', importance: 0.9 });
    await store.put({ id: 'r2', type: 'fact', content: 'runtime uses sql.js wasm', scope: 'user', importance: 0.4 });

    const retriever = new MemoryRetriever(store, { topK: 5 });
    const results = await retriever.retrieve({ text: 'supabase deploy' });
    assert.ok(results.length > 0, 'retriever finds matching memory');
    assert.equal(results[0].entry.id, 'r1');
  });

  it('round-trips through the file (persistence across store instances)', async () => {
    const storeA = new JsonFileMemoryStore(filePath);
    await storeA.put({ id: 'persist-1', type: 'fact', content: 'persisted across instances', scope: 'user' });

    const storeB = new JsonFileMemoryStore(filePath);
    const entry = await storeB.get('persist-1');
    assert.ok(entry);
    assert.equal(entry!.content, 'persisted across instances');
  });
});