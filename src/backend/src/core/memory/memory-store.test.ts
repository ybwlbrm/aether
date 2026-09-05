/**
 * Memory Store Module Tests (P1-37)
 *
 * Tests for the core/memory/memory-store module.
 * Run with: npm run test -w src/backend (after build)
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Import after build — tests run from dist/
// Types are imported with `import type` for compile-time only
import type { MemoryEntry, MemoryQuery, MemoryStore, InMemoryMemoryStore } from './memory-store.js';
const { InMemoryMemoryStore: InMemoryMemoryStoreClass } = await import('./memory-store.js');

describe('core/memory/memory-store', () => {
  let store: InMemoryMemoryStore;

  beforeEach(() => {
    store = new InMemoryMemoryStoreClass();
  });

  describe('InMemoryMemoryStore', () => {
    describe('put / get round-trip', () => {
      it('stores and retrieves an entry with all fields', async () => {
        const entry: MemoryEntry = {
          id: 'mem-1',
          type: 'fact',
          content: 'User prefers dark mode',
          source: 'user',
          confidence: 0.9,
          importance: 0.8,
          scope: 'user',
          createdAt: '2024-01-15T10:00:00.000Z',
          updatedAt: '2024-01-15T10:00:00.000Z',
        };

        const stored = await store.put(entry);
        const retrieved = await store.get('mem-1');

        assert.ok(retrieved);
        assert.equal(retrieved!.id, 'mem-1');
        assert.equal(retrieved!.type, 'fact');
        assert.equal(retrieved!.content, 'User prefers dark mode');
        assert.equal(retrieved!.source, 'user');
        assert.equal(retrieved!.confidence, 0.9);
        assert.equal(retrieved!.importance, 0.8);
        assert.equal(retrieved!.scope, 'user');
      });

      it('generates timestamps when not provided', async () => {
        const entry: MemoryEntry = {
          id: 'mem-2',
          type: 'preference',
          content: 'Auto-save enabled',
          scope: 'session',
        };

        const stored = await store.put(entry);

        assert.ok(stored.createdAt);
        assert.ok(stored.updatedAt);
        assert.ok(new Date(stored.createdAt).getTime() > 0);
        assert.ok(new Date(stored.updatedAt).getTime() > 0);
      });

      it('sets default confidence=1 and importance=0.5', async () => {
        const entry: MemoryEntry = {
          id: 'mem-3',
          type: 'fact',
          content: 'Default values test',
          scope: 'user',
        };

        const stored = await store.put(entry);

        assert.equal(stored.confidence, 1);
        assert.equal(stored.importance, 0.5);
      });

      it('upserts existing entry (updates updatedAt)', async () => {
        const original: MemoryEntry = {
          id: 'mem-4',
          type: 'fact',
          content: 'Original content',
          scope: 'user',
          createdAt: '2024-01-15T10:00:00.000Z',
          updatedAt: '2024-01-15T10:00:00.000Z',
        };

        await store.put(original);

        // Small delay to ensure timestamp difference
        await new Promise(r => setTimeout(r, 10));

        const updated: MemoryEntry = {
          ...original,
          content: 'Updated content',
        };

        const stored = await store.put(updated);
        const retrieved = await store.get('mem-4');

        assert.equal(retrieved!.content, 'Updated content');
        assert.ok(retrieved!.updatedAt && original.updatedAt && new Date(retrieved!.updatedAt).getTime() > new Date(original.updatedAt).getTime());
        assert.equal(retrieved!.createdAt, original.createdAt); // createdAt unchanged
      });
    });

    describe('get missing returns undefined', () => {
      it('returns undefined for non-existent ID', async () => {
        const result = await store.get('non-existent');
        assert.equal(result, undefined);
      });
    });

    describe('query by scope', () => {
      beforeEach(async () => {
        await store.put({ id: '1', type: 'fact', content: 'User fact', scope: 'user' });
        await store.put({ id: '2', type: 'fact', content: 'Agent fact', scope: 'agent' });
        await store.put({ id: '3', type: 'fact', content: 'Session fact', scope: 'session' });
        await store.put({ id: '4', type: 'fact', content: 'Project fact', scope: 'project' });
        await store.put({ id: '5', type: 'fact', content: 'Workspace fact', scope: 'workspace' });
      });

      it('filters by user scope', async () => {
        const results = await store.query({ scope: 'user' });
        assert.equal(results.length, 1);
        assert.equal(results[0].id, '1');
      });

      it('filters by agent scope', async () => {
        const results = await store.query({ scope: 'agent' });
        assert.equal(results.length, 1);
        assert.equal(results[0].id, '2');
      });

      it('filters by session scope', async () => {
        const results = await store.query({ scope: 'session' });
        assert.equal(results.length, 1);
        assert.equal(results[0].id, '3');
      });

      it('filters by project scope', async () => {
        const results = await store.query({ scope: 'project' });
        assert.equal(results.length, 1);
        assert.equal(results[0].id, '4');
      });

      it('filters by workspace scope', async () => {
        const results = await store.query({ scope: 'workspace' });
        assert.equal(results.length, 1);
        assert.equal(results[0].id, '5');
      });

      it('returns all when no scope filter', async () => {
        const results = await store.query({});
        assert.equal(results.length, 5);
      });
    });

    describe('query by contentContains', () => {
      beforeEach(async () => {
        await store.put({ id: '1', type: 'fact', content: 'User prefers dark mode', scope: 'user' });
        await store.put({ id: '2', type: 'fact', content: 'User likes TypeScript', scope: 'user' });
        await store.put({ id: '3', type: 'fact', content: 'Agent uses Python', scope: 'agent' });
      });

      it('matches case-insensitive substring', async () => {
        const results = await store.query({ contentContains: 'dark' });
        assert.equal(results.length, 1);
        assert.equal(results[0].id, '1');
      });

      it('matches uppercase query', async () => {
        const results = await store.query({ contentContains: 'TYPESCRIPT' });
        assert.equal(results.length, 1);
        assert.equal(results[0].id, '2');
      });

      it('matches partial word', async () => {
        const results = await store.query({ contentContains: 'pref' });
        assert.equal(results.length, 1);
        assert.equal(results[0].id, '1');
      });

      it('returns empty when no match', async () => {
        const results = await store.query({ contentContains: 'nonexistent' });
        assert.equal(results.length, 0);
      });

      it('combines with scope filter', async () => {
        const results = await store.query({ scope: 'user', contentContains: 'TypeScript' });
        assert.equal(results.length, 1);
        assert.equal(results[0].id, '2');
      });
    });

    describe('query by importanceMin', () => {
      beforeEach(async () => {
        await store.put({ id: '1', type: 'fact', content: 'Low importance', scope: 'user', importance: 0.2 });
        await store.put({ id: '2', type: 'fact', content: 'Medium importance', scope: 'user', importance: 0.5 });
        await store.put({ id: '3', type: 'fact', content: 'High importance', scope: 'user', importance: 0.9 });
      });

      it('filters by minimum importance', async () => {
        const results = await store.query({ importanceMin: 0.6 });
        assert.equal(results.length, 1);
        assert.equal(results[0].id, '3');
      });

      it('includes entries at threshold', async () => {
        const results = await store.query({ importanceMin: 0.5 });
        assert.equal(results.length, 2);
        assert.ok(results.some((r: MemoryEntry) => r.id === '2'));
        assert.ok(results.some((r: MemoryEntry) => r.id === '3'));
      });

      it('returns all when importanceMin is 0', async () => {
        const results = await store.query({ importanceMin: 0 });
        assert.equal(results.length, 3);
      });

      it('returns none when importanceMin > all', async () => {
        const results = await store.query({ importanceMin: 1.0 });
        assert.equal(results.length, 0);
      });
    });

    describe('query by type', () => {
      beforeEach(async () => {
        await store.put({ id: '1', type: 'fact', content: 'Fact 1', scope: 'user' });
        await store.put({ id: '2', type: 'preference', content: 'Pref 1', scope: 'user' });
        await store.put({ id: '3', type: 'fact', content: 'Fact 2', scope: 'user' });
        await store.put({ id: '4', type: 'conversation', content: 'Conv 1', scope: 'session' });
      });

      it('filters by exact type match', async () => {
        const results = await store.query({ type: 'fact' });
        assert.equal(results.length, 2);
        assert.ok(results.every((r: MemoryEntry) => r.type === 'fact'));
      });

      it('returns empty for non-existent type', async () => {
        const results = await store.query({ type: 'nonexistent' });
        assert.equal(results.length, 0);
      });
    });

    describe('delete', () => {
      it('returns true and removes entry', async () => {
        await store.put({ id: 'del-1', type: 'fact', content: 'To delete', scope: 'user' });

        const deleted = await store.delete('del-1');
        const retrieved = await store.get('del-1');

        assert.equal(deleted, true);
        assert.equal(retrieved, undefined);
      });

      it('returns false for non-existent ID', async () => {
        const deleted = await store.delete('non-existent');
        assert.equal(deleted, false);
      });

      it('returns false on second delete of same ID', async () => {
        await store.put({ id: 'del-2', type: 'fact', content: 'To delete', scope: 'user' });

        const first = await store.delete('del-2');
        const second = await store.delete('del-2');

        assert.equal(first, true);
        assert.equal(second, false);
      });
    });

    describe('limit and offset pagination', () => {
      beforeEach(async () => {
        // Create 10 entries with sequential timestamps
        for (let i = 1; i <= 10; i++) {
          await store.put({
            id: `mem-${i}`,
            type: 'fact',
            content: `Memory ${i}`,
            scope: 'user',
            createdAt: `2024-01-${String(i).padStart(2, '0')}T10:00:00.000Z`,
          });
        }
      });

      it('limits results', async () => {
        const results = await store.query({ limit: 3 });
        assert.equal(results.length, 3);
      });

      it('offsets results', async () => {
        const results = await store.query({ limit: 3, offset: 3 });
        assert.equal(results.length, 3);
        assert.equal(results[0].id, 'mem-7'); // Newest first: 10,9,8,7,6,5,4,3,2,1
      });

      it('returns empty when offset exceeds count', async () => {
        const results = await store.query({ limit: 5, offset: 10 });
        assert.equal(results.length, 0);
      });

      it('combines limit, offset, and filters', async () => {
        // Add some with different scope
        await store.put({ id: 'agent-1', type: 'fact', content: 'Agent memory', scope: 'agent' });

        const results = await store.query({ scope: 'user', limit: 2, offset: 1 });
        assert.equal(results.length, 2);
        assert.ok(results.every((r: MemoryEntry) => r.scope === 'user'));
      });
    });

    describe('ordering', () => {
      it('orders by createdAt descending (newest first)', async () => {
        await store.put({ id: 'old', type: 'fact', content: 'Old', scope: 'user', createdAt: '2024-01-01T10:00:00.000Z' });
        await store.put({ id: 'new', type: 'fact', content: 'New', scope: 'user', createdAt: '2024-12-31T10:00:00.000Z' });
        await store.put({ id: 'mid', type: 'fact', content: 'Mid', scope: 'user', createdAt: '2024-06-15T10:00:00.000Z' });

        const results = await store.query({});

        assert.equal(results[0].id, 'new');
        assert.equal(results[1].id, 'mid');
        assert.equal(results[2].id, 'old');
      });
    });

    describe('MemoryStore interface compliance', () => {
      it('InMemoryMemoryStore implements MemoryStore', () => {
        // TypeScript compile-time check — if this compiles, the interface is satisfied
        const _check: MemoryStore = store;
        assert.ok(_check);
      });
    });
  });
});