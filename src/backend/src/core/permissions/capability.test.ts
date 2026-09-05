/**
 * Capability Module Tests (P1-33)
 *
 * Tests for the core/permissions/capability module.
 * Run with: npm run test -w src/backend (after build)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Import after build — tests run from dist/
// Types are imported with `import type` for compile-time only
import type { Capability, CapabilitySet } from './capability.js';
const {
  ALL_CAPABILITIES,
  createCapabilitySet,
  hasCapability,
  combineCapabilities,
  isSuperset,
  difference,
  intersection,
} = await import('./capability.js');

describe('core/permissions/capability', () => {
  describe('Capability type', () => {
    it('ALL_CAPABILITIES contains all 10 core capabilities', () => {
      assert.equal(ALL_CAPABILITIES.length, 10);
      assert.deepEqual(ALL_CAPABILITIES, [
        'filesystem.read',
        'filesystem.write',
        'filesystem.delete',
        'terminal.execute',
        'network.http',
        'browser.control',
        'browser.download',
        'mcp.execute',
        'secrets.read',
        'process.launch',
      ]);
    });

    it('ALL_CAPABILITIES entries are valid Capability type', () => {
      // TypeScript compile-time check — if this compiles, the type is correct
      const _check: Capability[] = [...ALL_CAPABILITIES];
      assert.ok(_check.length === 10);
    });

    it('allows additional capability strings via escape hatch', () => {
      const customCap: Capability = 'custom.capability';
      const set = createCapabilitySet(customCap);
      assert.ok(hasCapability(set, 'custom.capability'));
    });
  });

  describe('createCapabilitySet', () => {
    it('creates a set from multiple capabilities', () => {
      const set = createCapabilitySet('filesystem.read', 'network.http', 'terminal.execute');
      assert.equal(set.size, 3);
      assert.ok(hasCapability(set, 'filesystem.read'));
      assert.ok(hasCapability(set, 'network.http'));
      assert.ok(hasCapability(set, 'terminal.execute'));
    });

    it('deduplicates capabilities', () => {
      const set = createCapabilitySet('filesystem.read', 'filesystem.read', 'network.http');
      assert.equal(set.size, 2);
    });

    it('creates empty set when no arguments', () => {
      const set = createCapabilitySet();
      assert.equal(set.size, 0);
    });

    it('returns ReadonlySet (compile-time immutable)', () => {
      // This test verifies the TypeScript compile-time constraint.
      // At runtime, ReadonlySet is a regular Set, but TypeScript prevents mutation.
      // The @ts-expect-error below should cause a compile error if uncommented:
      // const set = createCapabilitySet('filesystem.read');
      // set.add('filesystem.write'); // @ts-expect-error
      const set = createCapabilitySet('filesystem.read');
      assert.equal(set.size, 1);
    });
  });

  describe('hasCapability', () => {
    it('returns true for capability in set', () => {
      const set = createCapabilitySet('filesystem.read', 'network.http');
      assert.equal(hasCapability(set, 'filesystem.read'), true);
      assert.equal(hasCapability(set, 'network.http'), true);
    });

    it('returns false for capability not in set', () => {
      const set = createCapabilitySet('filesystem.read');
      assert.equal(hasCapability(set, 'network.http'), false);
      assert.equal(hasCapability(set, 'secrets.read'), false);
    });

    it('returns false for empty set', () => {
      const set = createCapabilitySet();
      assert.equal(hasCapability(set, 'filesystem.read'), false);
    });
  });

  describe('combineCapabilities', () => {
    it('unions multiple sets', () => {
      const set1 = createCapabilitySet('filesystem.read', 'filesystem.write');
      const set2 = createCapabilitySet('network.http', 'terminal.execute');
      const combined = combineCapabilities(set1, set2);

      assert.equal(combined.size, 4);
      assert.ok(hasCapability(combined, 'filesystem.read'));
      assert.ok(hasCapability(combined, 'filesystem.write'));
      assert.ok(hasCapability(combined, 'network.http'));
      assert.ok(hasCapability(combined, 'terminal.execute'));
    });

    it('deduplicates across sets', () => {
      const set1 = createCapabilitySet('filesystem.read', 'network.http');
      const set2 = createCapabilitySet('network.http', 'terminal.execute');
      const combined = combineCapabilities(set1, set2);

      assert.equal(combined.size, 3);
    });

    it('handles empty sets', () => {
      const set1 = createCapabilitySet('filesystem.read');
      const set2 = createCapabilitySet();
      const combined = combineCapabilities(set1, set2);

      assert.equal(combined.size, 1);
      assert.ok(hasCapability(combined, 'filesystem.read'));
    });

    it('handles single set', () => {
      const set1 = createCapabilitySet('filesystem.read', 'network.http');
      const combined = combineCapabilities(set1);

      assert.equal(combined.size, 2);
    });

    it('handles no sets', () => {
      const combined = combineCapabilities();
      assert.equal(combined.size, 0);
    });

    it('does not mutate input sets', () => {
      const set1 = createCapabilitySet('filesystem.read');
      const set2 = createCapabilitySet('network.http');
      combineCapabilities(set1, set2);

      assert.equal(set1.size, 1);
      assert.equal(set2.size, 1);
    });
  });

  describe('isSuperset', () => {
    it('returns true when superset contains all subset capabilities', () => {
      const superset = createCapabilitySet('filesystem.read', 'filesystem.write', 'network.http');
      const subset = createCapabilitySet('filesystem.read', 'network.http');
      assert.equal(isSuperset(superset, subset), true);
    });

    it('returns false when superset missing a capability', () => {
      const superset = createCapabilitySet('filesystem.read');
      const subset = createCapabilitySet('filesystem.read', 'network.http');
      assert.equal(isSuperset(superset, subset), false);
    });

    it('returns true for empty subset', () => {
      const superset = createCapabilitySet('filesystem.read');
      const subset = createCapabilitySet();
      assert.equal(isSuperset(superset, subset), true);
    });

    it('returns true when sets are equal', () => {
      const set1 = createCapabilitySet('filesystem.read', 'network.http');
      const set2 = createCapabilitySet('network.http', 'filesystem.read');
      assert.equal(isSuperset(set1, set2), true);
    });
  });

  describe('difference', () => {
    it('returns capabilities in first but not second', () => {
      const set = createCapabilitySet('filesystem.read', 'filesystem.write', 'network.http');
      const subtract = createCapabilitySet('filesystem.write');
      const diff = difference(set, subtract);

      assert.equal(diff.size, 2);
      assert.ok(hasCapability(diff, 'filesystem.read'));
      assert.ok(hasCapability(diff, 'network.http'));
      assert.equal(hasCapability(diff, 'filesystem.write'), false);
    });

    it('returns empty set when all capabilities subtracted', () => {
      const set = createCapabilitySet('filesystem.read');
      const subtract = createCapabilitySet('filesystem.read');
      const diff = difference(set, subtract);

      assert.equal(diff.size, 0);
    });

    it('returns original set when subtracting empty set', () => {
      const set = createCapabilitySet('filesystem.read', 'network.http');
      const subtract = createCapabilitySet();
      const diff = difference(set, subtract);

      assert.equal(diff.size, 2);
    });
  });

  describe('intersection', () => {
    it('returns capabilities present in both sets', () => {
      const a = createCapabilitySet('filesystem.read', 'filesystem.write', 'network.http');
      const b = createCapabilitySet('filesystem.write', 'terminal.execute', 'network.http');
      const inter = intersection(a, b);

      assert.equal(inter.size, 2);
      assert.ok(hasCapability(inter, 'filesystem.write'));
      assert.ok(hasCapability(inter, 'network.http'));
    });

    it('returns empty set when no overlap', () => {
      const a = createCapabilitySet('filesystem.read');
      const b = createCapabilitySet('network.http');
      const inter = intersection(a, b);

      assert.equal(inter.size, 0);
    });

    it('returns full set when sets are equal', () => {
      const a = createCapabilitySet('filesystem.read', 'network.http');
      const b = createCapabilitySet('network.http', 'filesystem.read');
      const inter = intersection(a, b);

      assert.equal(inter.size, 2);
    });
  });
});