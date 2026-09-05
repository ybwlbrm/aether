/**
 * DbSequenceAllocator tests (P3-03)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DbSequenceAllocator } from './sequence-allocator.db.js';
import { runMigrations } from '../../db/migrate.js';
import { initDb, getDb } from '../../db/client.js';
import { events, runs } from '../../db/schema/index.js';
import { eq, sql } from 'drizzle-orm';
import { RuntimeError } from '../errors/index.js';

function makeConfig(dir: string) {
  return {
    encryptionKey: 'test-key-12345678901234567890123456789012',
    dbPath: join(dir, 'test.db'),
    dataDir: dir,
    allowedDirs: [dir],
  };
}

/** Insert a raw event row directly (bypassing the allocator) to seed sequences */
async function seedSeq(runId: string, seq: number): Promise<void> {
  await seedRun(runId);
  getDb().insert(events).values({
    id: `seed-${runId}-${seq}`,
    runId,
    seq,
    eventType: 'run.created',
    eventVersion: 1,
    payload: JSON.stringify({ seq }),
    createdAt: new Date().toISOString(),
  }).run();
}

/** Insert a runs row so the events.run_id FK is satisfied */
async function seedRun(runId: string): Promise<void> {
  const existing = getDb().select({ id: runs.id }).from(runs).where(eq(runs.id, runId)).get();
  if (existing) return;
  getDb().insert(runs).values({
    id: runId,
    status: 'created',
    mode: 'normal',
    createdAt: new Date().toISOString(),
  }).run();
}

describe('core/events/sequence-allocator.db', () => {
  let dir: string;
  let allocator: DbSequenceAllocator;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pacc-seq-'));
    const config = makeConfig(dir);
    await runMigrations(config as never);
    await initDb(config as never);
    // The allocator claims seq by inserting into events (run_id FK -> runs).
    // These unit tests exercise the allocator in isolation, so relax FK
    // enforcement (the real run rows are created by the Run API layer).
    getDb().run(sql`PRAGMA foreign_keys = OFF`);
    allocator = new DbSequenceAllocator(getDb());
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('allocate starts at 1 for a fresh run and increments', async () => {
    const a = await allocator.allocate('run-fresh-1');
    const b = await allocator.allocate('run-fresh-1');
    const c = await allocator.allocate('run-fresh-1');
    assert.equal(a, 1);
    assert.equal(b, 2);
    assert.equal(c, 3);
  });

  it('allocate continues after seeded rows', async () => {
    const runId = 'run-seeded';
    await seedSeq(runId, 5);
    await seedSeq(runId, 6);
    const next = await allocator.allocate(runId);
    assert.equal(next, 7);
  });

  it('allocate uniqueness under 1000 concurrent calls', async () => {
    const runId = 'run-concurrent';
    const calls = Array.from({ length: 1000 }, () => allocator.allocate(runId));
    const results = await Promise.all(calls);
    const unique = new Set(results);
    assert.equal(unique.size, 1000, 'all 1000 allocations must be unique');
    assert.equal(Math.max(...results), 1000);
    assert.equal(Math.min(...results), 1);
  });

  it('getCurrent reflects the highest allocated seq', async () => {
    const runId = 'run-current';
    assert.equal(await allocator.getCurrent(runId), 0, 'fresh run has no current seq');
    await allocator.allocate(runId);
    await allocator.allocate(runId);
    await allocator.allocate(runId);
    assert.equal(await allocator.getCurrent(runId), 3);
  });

  it('reset deletes stored events and restarts from startAt', async () => {
    const runId = 'run-reset';
    await seedSeq(runId, 10);
    assert.equal(await allocator.getCurrent(runId), 10);

    await allocator.reset(runId);

    assert.equal(await allocator.getCurrent(runId), 0, 'after reset, no rows remain');
    const next = await allocator.allocate(runId);
    assert.equal(next, 1, 'allocator restarts from startAt after reset');
  });

  it('empty runId throws RuntimeError INVALID_RUN_ID', async () => {
    await assert.rejects(
      allocator.allocate('   '),
      (err: unknown) => err instanceof RuntimeError && err.code === 'INVALID_RUN_ID',
    );
  });

  it('runs are isolated', async () => {
    await allocator.allocate('run-iso-a');
    await allocator.allocate('run-iso-a');
    const b1 = await allocator.allocate('run-iso-b');
    assert.equal(b1, 1, 'run-iso-b starts fresh regardless of run-iso-a');
  });

  it('startAt option changes the first allocated seq', async () => {
    const custom = new DbSequenceAllocator(getDb(), { startAt: 100 });
    const first = await custom.allocate('run-startat');
    assert.equal(first, 100);
  });

  it('UNIQUE(run_id, seq) rejects duplicate seq inserts (storage-level guarantee)', async () => {
    const runId = 'run-dup';
    const seq = 1;
    await seedRun(runId);
    getDb().insert(events).values({
      id: 'dup-1',
      runId,
      seq,
      eventType: 'run.created',
      eventVersion: 1,
      payload: '{}',
      createdAt: new Date().toISOString(),
    }).run();

    assert.throws(() => {
      getDb().insert(events).values({
        id: 'dup-2',
        runId,
        seq,
        eventType: 'run.created',
        eventVersion: 1,
        payload: '{}',
        createdAt: new Date().toISOString(),
      }).run();
    }, /UNIQUE/i);
  });

  it('allocator restart (new instance) continues from persisted MAX(seq)', async () => {
    const runId = 'run-restart';
    await allocator.allocate(runId);
    await allocator.allocate(runId);
    await allocator.allocate(runId);

    const restarted = new DbSequenceAllocator(getDb());
    const next = await restarted.allocate(runId);
    assert.equal(next, 4, 'restarted allocator reads MAX(seq) from the events table');
  });
});