/**
 * Aether 2.0 — SqliteEventStore Tests (P3-02, Wave 5)
 *
 * Covers:
 * - append + list round-trip preserves event fields
 * - appendBatch multiple events (in order)
 * - listAfter filters seq > N + limit
 * - get found + undefined
 * - count accurate
 * - latest returns max-seq
 * - runId isolation
 * - duplicate seq append is idempotent
 * - round-trip preserves metadata
 * - appendBatch skips duplicate rows and continues
 * - markDirty callback invoked after writes
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BackendConfig } from '../../config/index.js';
import { runMigrations } from '../../db/migrate.js';
import { initDb, getDb } from '../../db/client.js';
import { events, runs } from '../../db/schema/index.js';
import { SqliteEventStore } from './event-store.sqlite.js';
import type {
  RunCreatedEvent,
  RunStartedEvent,
  TaskStartedEvent,
  RunCompletedEvent,
} from '@pacc/shared';

const TS = '2026-01-01T00:00:00.000Z';

// ── v2 AgentEvent literal builders (union-valid) ──────────────────────────

function makeRunCreatedEvent(runId: string, seq: number, overrides: Partial<Omit<RunCreatedEvent, 'type'>> = {}): RunCreatedEvent {
  return {
    eventId: `evt-${runId}-${seq}`,
    sessionId: 'session-1',
    runId,
    timestamp: TS,
    seq,
    type: 'run.created',
    version: 2,
    payload: {},
    ...overrides,
  };
}

function makeRunStartedEvent(runId: string, seq: number, overrides: Partial<Omit<RunStartedEvent, 'type'>> = {}): RunStartedEvent {
  return {
    eventId: `evt-${runId}-${seq}`,
    sessionId: 'session-1',
    runId,
    timestamp: TS,
    seq,
    type: 'run.started',
    version: 2,
    payload: {},
    ...overrides,
  };
}

function makeTaskStartedEvent(runId: string, seq: number, overrides: Partial<Omit<TaskStartedEvent, 'type'>> = {}): TaskStartedEvent {
  return {
    eventId: `evt-${runId}-${seq}`,
    sessionId: 'session-1',
    runId,
    timestamp: TS,
    seq,
    type: 'task.started',
    version: 2,
    payload: { status: 'started' },
    ...overrides,
  };
}

function makeRunCompletedEvent(runId: string, seq: number, overrides: Partial<Omit<RunCompletedEvent, 'type'>> = {}): RunCompletedEvent {
  return {
    eventId: `evt-${runId}-${seq}`,
    sessionId: 'session-1',
    runId,
    timestamp: TS,
    seq,
    type: 'run.completed',
    version: 2,
    payload: { endReason: 'completed', tokenUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } },
    ...overrides,
  };
}

// ── Test suite ────────────────────────────────────────────────────────────

describe('EventStore - SqliteEventStore', () => {
  let store: SqliteEventStore;
  let dir: string;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pacc-evtstore-'));
    const config: BackendConfig = {
      encryptionKey: 'test-key-12345678901234567890123456789012',
      dbPath: join(dir, 'test.db'),
      dataDir: dir,
      allowedDirs: [dir],
      allowedOrigins: [],
      enableSwagger: false,
      port: 3000,
      host: '127.0.0.1',
    };
    await runMigrations(config);
    await initDb(config);

    // events.run_id references runs(id) with FK enforcement ON — seed runs first.
    for (const runId of ['r1', 'r2', 'rA', 'rB']) {
      getDb().insert(runs).values({ id: runId, createdAt: TS }).run();
    }

    // no-op markDirty: tests focus on store behavior; a real flush timer would
    // keep the test process alive after tmp dir removal.
    store = new SqliteEventStore(getDb(), () => {});
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  beforeEach(() => {
    getDb().delete(events).run();
  });

  it('append + list round-trip preserves event fields', async () => {
    const event = makeRunCreatedEvent('r1', 1);
    await store.append(event);

    const eventsList = await store.list('r1');
    assert.equal(eventsList.length, 1);
    assert.deepEqual(eventsList[0].eventId, event.eventId);
    assert.deepEqual(eventsList[0].seq, event.seq);
    assert.deepEqual(eventsList[0].type, 'run.created');
    assert.deepEqual(eventsList[0].version, 2);
    assert.deepEqual(eventsList[0].runId, 'r1');
    assert.deepEqual(eventsList[0].sessionId, 'session-1');
    assert.deepEqual(eventsList[0].timestamp, TS);
    assert.deepEqual(eventsList[0].payload, {});
  });

  it('appendBatch persists multiple events in order', async () => {
    await store.appendBatch([
      makeRunCreatedEvent('r1', 1),
      makeRunStartedEvent('r1', 2),
      makeTaskStartedEvent('r1', 3),
    ]);

    const eventsList = await store.list('r1');
    assert.equal(eventsList.length, 3);
    assert.deepEqual(eventsList.map((e) => e.eventId), ['evt-r1-1', 'evt-r1-2', 'evt-r1-3']);
    assert.deepEqual(eventsList.map((e) => e.seq), [1, 2, 3]);
    assert.deepEqual(eventsList.map((e) => e.type), ['run.created', 'run.started', 'task.started']);
  });

  it('listAfter filters seq > N and applies limit', async () => {
    await store.append(makeRunCreatedEvent('r1', 1));
    await store.append(makeRunStartedEvent('r1', 2));
    await store.append(makeTaskStartedEvent('r1', 3));
    await store.append(makeRunCreatedEvent('r1', 4));

    const after1 = await store.listAfter('r1', 1);
    assert.deepEqual(after1.map((e) => e.seq), [2, 3, 4]);

    const after1Limited = await store.listAfter('r1', 1, 2);
    assert.equal(after1Limited.length, 2);
    assert.deepEqual(after1Limited.map((e) => e.seq), [2, 3]);

    const after3 = await store.listAfter('r1', 3);
    assert.deepEqual(after3.map((e) => e.seq), [4]);

    const after4 = await store.listAfter('r1', 4);
    assert.deepEqual(after4, []);

    // limit=0 / undefined means no limit
    const unlimited = await store.listAfter('r1', 0, 0);
    assert.deepEqual(unlimited.map((e) => e.seq), [1, 2, 3, 4]);
  });

  it('get returns event when found and undefined when missing', async () => {
    await store.append(makeRunCreatedEvent('r1', 1));

    const found = await store.get('r1', 'evt-r1-1');
    assert.ok(found);
    assert.deepEqual(found?.eventId, 'evt-r1-1');
    assert.deepEqual(found?.seq, 1);

    const missing = await store.get('r1', 'nonexistent');
    assert.equal(missing, undefined);

    const wrongRun = await store.get('r2', 'evt-r1-1');
    assert.equal(wrongRun, undefined);
  });

  it('count returns accurate event count per run', async () => {
    assert.equal(await store.count('r1'), 0);

    await store.append(makeRunCreatedEvent('r1', 1));
    assert.equal(await store.count('r1'), 1);

    await store.append(makeRunStartedEvent('r1', 2));
    await store.append(makeTaskStartedEvent('r1', 3));
    assert.equal(await store.count('r1'), 3);

    // Different runId has its own count
    assert.equal(await store.count('r2'), 0);
  });

  it('latest returns the max-seq event', async () => {
    assert.equal(await store.latest('r1'), undefined);

    await store.append(makeRunCreatedEvent('r1', 1));
    let latest = await store.latest('r1');
    assert.ok(latest);
    assert.deepEqual(latest?.seq, 1);

    await store.append(makeRunStartedEvent('r1', 2));
    await store.append(makeTaskStartedEvent('r1', 3));
    latest = await store.latest('r1');
    assert.ok(latest);
    assert.deepEqual(latest?.seq, 3);
    assert.deepEqual(latest?.eventId, 'evt-r1-3');
  });

  it('runId isolation — events do not leak across runs', async () => {
    await store.append(makeRunCreatedEvent('rA', 1));
    await store.append(makeRunStartedEvent('rA', 2));
    await store.append(makeRunCreatedEvent('rB', 1));

    const runA = await store.list('rA');
    const runB = await store.list('rB');
    assert.equal(runA.length, 2);
    assert.deepEqual(runA.map((e) => e.eventId), ['evt-rA-1', 'evt-rA-2']);
    assert.equal(runB.length, 1);
    assert.deepEqual(runB.map((e) => e.eventId), ['evt-rB-1']);

    assert.equal(await store.count('rA'), 2);
    assert.equal(await store.count('rB'), 1);

    const latestA = await store.latest('rA');
    const latestB = await store.latest('rB');
    assert.deepEqual(latestA?.eventId, 'evt-rA-2');
    assert.deepEqual(latestB?.eventId, 'evt-rB-1');

    assert.ok(await store.get('rA', 'evt-rA-1'));
    assert.equal(await store.get('rB', 'evt-rA-1'), undefined);

    const afterA = await store.listAfter('rA', 0);
    const afterB = await store.listAfter('rB', 0);
    assert.equal(afterA.length, 2);
    assert.equal(afterB.length, 1);
  });

  it('duplicate seq append is idempotent (no throw, row stays first)', async () => {
    const first = makeRunCreatedEvent('r1', 1);
    await store.append(first);

    // Same runId + seq but different eventId → UNIQUE(run_id, seq) violation
    await store.append(makeRunStartedEvent('r1', 1));

    const eventsList = await store.list('r1');
    assert.equal(eventsList.length, 1);
    assert.deepEqual(eventsList[0].eventId, first.eventId);
    assert.deepEqual(eventsList[0].type, 'run.created');
    assert.deepEqual(eventsList[0].seq, 1);
    assert.equal(await store.count('r1'), 1);
  });

  it('round-trip preserves metadata', async () => {
    const metadata = { custom: 'value', nested: { a: 1 }, tokens: 42 };
    const event = makeRunCreatedEvent('r1', 1, { metadata });
    await store.append(event);

    const eventsList = await store.list('r1');
    assert.equal(eventsList.length, 1);
    assert.deepEqual(eventsList[0].metadata, metadata);

    const latest = await store.latest('r1');
    assert.deepEqual(latest?.metadata, metadata);
  });

  it('round-trip preserves payload details', async () => {
    const event = makeRunCompletedEvent('r1', 1);
    await store.append(event);

    const [loaded] = await store.list('r1');
    assert.deepEqual(loaded.payload, {
      endReason: 'completed',
      tokenUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    });
  });

  it('appendBatch skips duplicate (runId, seq) rows and continues', async () => {
    await store.append(makeRunCreatedEvent('r1', 1));

    // Batch contains a conflicting seq=1 row plus fresh rows — no throw.
    await store.appendBatch([
      makeRunStartedEvent('r1', 1), // duplicate → skipped
      makeTaskStartedEvent('r1', 2), // fresh → inserted
      makeRunStartedEvent('r1', 3), // fresh → inserted
    ]);

    const eventsList = await store.list('r1');
    assert.equal(eventsList.length, 3);
    assert.deepEqual(eventsList.map((e) => e.seq), [1, 2, 3]);
    assert.deepEqual(eventsList.map((e) => e.eventId), ['evt-r1-1', 'evt-r1-2', 'evt-r1-3']);
    assert.equal(await store.count('r1'), 3);
  });

  it('appendBatch with empty array is a no-op', async () => {
    await store.appendBatch([]);
    assert.equal(await store.count('r1'), 0);
    assert.deepEqual(await store.list('r1'), []);
  });

  it('markDirty callback is invoked after successful writes', async () => {
    let calls = 0;
    const spyStore = new SqliteEventStore(getDb(), () => { calls += 1; });

    await spyStore.append(makeRunCreatedEvent('r1', 1));
    assert.equal(calls, 1);

    await spyStore.appendBatch([
      makeRunStartedEvent('r1', 2),
      makeTaskStartedEvent('r1', 3),
    ]);
    assert.equal(calls, 3); // one per successful insert

    // Duplicate append is swallowed — no markDirty
    await spyStore.append(makeRunCreatedEvent('r1', 1));
    assert.equal(calls, 3);
  });
});
