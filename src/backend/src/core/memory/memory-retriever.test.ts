/**
 * MemoryRetriever tests — coverage:
 * - keyword scoring finds matching entries, topK=1 returns best
 * - scope filter applied
 * - no-match returns []
 * - hybrid ranking includes importance weighting
 * - minScore filters
 * - empty/blank query returns []
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MemoryRetriever } from './memory-retriever.js';
import { InMemoryMemoryStore } from './memory-store.js';
import type { MemoryEntry } from './memory-store.js';

function seed(entries: Array<Omit<MemoryEntry, 'id'|'createdAt'|'updatedAt'> & { id?: string }>): InMemoryMemoryStore {
  const store = new InMemoryMemoryStore();
  for (const e of entries) {
    const entry: MemoryEntry = {
      id: e.id ?? `m${Math.random().toString(36).slice(2)}`,
      type: e.type,
      content: e.content,
      scope: e.scope,
      importance: e.importance,
    };
    void store.put(entry);
  }
  return store;
}

describe('MemoryRetriever (keyword)', () => {
  it('finds entry whose content contains query terms and ranks it first', async () => {
    const store = seed([
      { type: 'fact', content: 'Aether is a personal AI command center', scope: 'project', importance: 0.8 },
      { type: 'fact', content: 'Windows DPAPI encrypts api keys', scope: 'project', importance: 0.9 },
    ]);
    const retriever = new MemoryRetriever(store, { topK: 1 });
    const results = await retriever.retrieve({ text: 'Aether command center' });
    assert.ok(results.length > 0);
    assert.ok(results[0].score > 0);
    assert.match(results[0].entry.content, /Aether/);
  });

  it('applies scope filter', async () => {
    const store = seed([
      { type: 'fact', content: 'scoped user memory about travel', scope: 'user', importance: 0.5 },
      { type: 'fact', content: 'scoped project memory about travel', scope: 'project', importance: 0.5 },
    ]);
    const retriever = new MemoryRetriever(store);
    const results = await retriever.retrieve({ text: 'travel', scope: 'user' });
    assert.equal(results.length, 1);
    assert.equal(results[0].entry.scope, 'user');
  });

  it('returns [] when nothing matches', async () => {
    const store = seed([
      { type: 'fact', content: 'rust async runtime internals', scope: 'project' },
    ]);
    const retriever = new MemoryRetriever(store);
    const results = await retriever.retrieve({ text: 'quantum entanglement' });
    assert.deepEqual(results, []);
  });

  it('returns [] for blank query', async () => {
    const store = seed([{ type: 'fact', content: 'anything at all', scope: 'project' }]);
    const retriever = new MemoryRetriever(store);
    assert.deepEqual(await retriever.retrieve({ text: '' }), []);
    assert.deepEqual(await retriever.retrieve({ text: '   ' }), []);
  });

  it('hybrid strategy ranks higher-importance entry above lower when both match', async () => {
    const store = seed([
      { type: 'fact', content: 'deploy pipeline uses supabase sync critical', scope: 'project', importance: 0.1 },
      { type: 'fact', content: 'deploy pipeline uses supabase sync critical', scope: 'project', importance: 0.9 },
    ]);
    const retriever = new MemoryRetriever(store, { strategy: 'hybrid', topK: 2 });
    const results = await retriever.retrieve({ text: 'deploy supabase' });
    assert.equal(results.length, 2);
    assert.ok(results[0].score > results[1].score);
    assert.equal(results[0].entry.importance, 0.9);
  });

  it('minScore filters low-confidence matches', async () => {
    const store = seed([
      { type: 'fact', content: 'rarely relevant note word', scope: 'project', importance: 0.1 },
      { type: 'fact', content: 'highly relevant word', scope: 'project', importance: 0.9 },
    ]);
    const retriever = new MemoryRetriever(store, { strategy: 'hybrid', topK: 5 });
    const results = await retriever.retrieve({ text: 'word', minScore: 0.5 });
    for (const r of results) {
      assert.ok(r.score >= 0.5, `score ${r.score} should satisfy minScore`);
    }
  });

  it('topK caps result count', async () => {
    const store = seed([
      { type: 'fact', content: 'alpha beta gamma commonword', scope: 'project', importance: 0.5 },
      { type: 'fact', content: 'delta epsilon commonword', scope: 'project', importance: 0.5 },
      { type: 'fact', content: 'zeta eta theta commonword', scope: 'project', importance: 0.5 },
    ]);
    const retriever = new MemoryRetriever(store, { topK: 2 });
    const results = await retriever.retrieve({ text: 'commonword' });
    assert.ok(results.length <= 2);
  });
});