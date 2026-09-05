/**
 * Aether 2.0 — SequenceAllocator Unit Tests
 *
 * Tests for SequenceAllocator covering:
 * - allocate starts at 1 and increments
 * - allocate uniqueness under 1000 concurrent calls
 * - getCurrent reflects last allocated
 * - reset returns sequence to start
 * - empty runId throws RuntimeError with code INVALID_RUN_ID
 * - seeded startAt respected
 * - per-run sequence independence
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SequenceAllocator } from './event-sequence.js';
import { RuntimeError } from '../errors/index.js';

describe('SequenceAllocator', () => {
  it('allocate starts at 1 and increments', async () => {
    const allocator = new SequenceAllocator();

    assert.equal(await allocator.allocate('run-1'), 1);
    assert.equal(await allocator.allocate('run-1'), 2);
    assert.equal(await allocator.allocate('run-1'), 3);
  });

  it('allocate yields 1000 unique, gapless sequences under concurrent calls', async () => {
    const allocator = new SequenceAllocator();
    const RUN = 'run-concurrent';

    const seqs = await Promise.all(
      Array.from({ length: 1000 }, () => allocator.allocate(RUN)),
    );

    assert.equal(seqs.length, 1000);
    const unique = new Set(seqs);
    assert.equal(unique.size, 1000, 'all allocated seq must be distinct');
    assert.equal(Math.max(...seqs), 1000);
    assert.equal(Math.min(...seqs), 1);

    // Gapless: sum of 1..1000
    const expectedSum = (1000 * 1001) / 2;
    assert.equal(seqs.reduce((sum, s) => sum + s, 0), expectedSum);
  });

  it('getCurrent reflects last allocated', async () => {
    const allocator = new SequenceAllocator();

    assert.equal(await allocator.getCurrent('run-1'), 0, 'no allocations yet');

    await allocator.allocate('run-1');
    assert.equal(await allocator.getCurrent('run-1'), 1);

    await allocator.allocate('run-1');
    await allocator.allocate('run-1');
    assert.equal(await allocator.getCurrent('run-1'), 3);

    // Unknown run is still 0
    assert.equal(await allocator.getCurrent('run-other'), 0);
  });

  it('reset returns sequence to start', async () => {
    const allocator = new SequenceAllocator();

    await allocator.allocate('run-1'); // 1
    await allocator.allocate('run-1'); // 2
    await allocator.allocate('run-1'); // 3

    await allocator.reset('run-1');
    assert.equal(await allocator.getCurrent('run-1'), 0);

    assert.equal(await allocator.allocate('run-1'), 1, 'first seq after reset is 1');
    assert.equal(await allocator.getCurrent('run-1'), 1);
  });

  it('empty runId throws RuntimeError with code INVALID_RUN_ID', async () => {
    const allocator = new SequenceAllocator();

    await assert.rejects(
      allocator.allocate(''),
      (err: unknown) => {
        assert.ok(err instanceof RuntimeError);
        assert.equal((err as RuntimeError).code, 'INVALID_RUN_ID');
        return true;
      },
    );

    await assert.rejects(
      allocator.allocate('   '),
      (err: unknown) => {
        assert.ok(err instanceof RuntimeError);
        assert.equal((err as RuntimeError).code, 'INVALID_RUN_ID');
        return true;
      },
    );

    // Allocator unaffected — valid run still works after the guard fired
    assert.equal(await allocator.allocate('run-ok'), 1);
  });

  it('seeded startAt is respected', async () => {
    const allocator = new SequenceAllocator({ startAt: 100 });

    assert.equal(await allocator.allocate('run-1'), 100);
    assert.equal(await allocator.allocate('run-1'), 101);
    assert.equal(await allocator.getCurrent('run-1'), 101);
  });

  it('seed Map supplies pre-seeded current sequences', async () => {
    const seed = new Map<string, number>([
      ['run-seeded', 5],
      ['run-other', 42],
    ]);
    const allocator = new SequenceAllocator({ seed });

    assert.equal(await allocator.allocate('run-seeded'), 6);
    assert.equal(await allocator.allocate('run-other'), 43);

    // Unseeded run falls back to default startAt
    assert.equal(await allocator.allocate('run-fresh'), 1);
  });

  it('per-run sequences are independent', async () => {
    const allocator = new SequenceAllocator();

    assert.equal(await allocator.allocate('run-A'), 1);
    assert.equal(await allocator.allocate('run-B'), 1);
    assert.equal(await allocator.allocate('run-A'), 2);
    assert.equal(await allocator.allocate('run-B'), 2);
    assert.equal(await allocator.allocate('run-A'), 3);

    assert.equal(await allocator.getCurrent('run-A'), 3);
    assert.equal(await allocator.getCurrent('run-B'), 2);
  });
});