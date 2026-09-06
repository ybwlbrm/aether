/**
 * P0-06 — Ghost `__seq_claim` rows must never leak to readers.
 *
 * The DB sequence allocator inserts a `__seq_claim` placeholder row to
 * atomically claim a (runId, seq). If the process crashes after allocate()
 * but before the real event is appended, the claim row stays behind forever.
 * Every read path (store.list / listAfter / get / latest, the events REST
 * route, and the SSE stream replay) must hide these payload-less placeholder
 * rows so no ghost pseudo-event reaches the UI or corrupts replay.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { runMigrations } from '../../db/migrate.js';
import { initDb, getDb, flushDbSync } from '../../db/client.js';
import { makeTestConfig } from '../../tests/helpers/mock-provider.sse.js';
import type { BackendConfig } from '../../config/index.js';
import { SqliteEventStore } from './event-store.sqlite.js';
import { DbSequenceAllocator } from './sequence-allocator.db.js';
import { registerErrorHandler } from '../../plugins/error-handler.js';
import { registerRunEventsRoutes } from '../../modules/runs/index.js';
import { registerRunStreamRoutes, readEvents } from '../../modules/runs/stream.js';
import { events, runs } from '../../db/schema/index.js';
import { eq } from 'drizzle-orm';
import type { AgentEvent } from '@pacc/shared';

let cfg: BackendConfig;
let dir: string;
let store: SqliteEventStore;
let allocator: DbSequenceAllocator;
let app: FastifyInstance;

/** Build a v2 AgentEvent (caller supplies the already-allocated seq) */
function makeEvent(
  runId: string,
  seq: number,
  type: string,
  payload: Record<string, unknown> = {},
): AgentEvent {
  return {
    eventId: `evt-${runId}-${seq}`,
    sessionId: 'sess-1',
    runId,
    timestamp: '2026-01-01T00:00:00.000Z',
    seq,
    type,
    version: 2,
    payload,
  } as AgentEvent;
}

/** Seed a runs row so the events.run_id FK is satisfied */
function seedRun(runId: string): void {
  getDb().insert(runs).values({
    id: runId,
    status: 'created',
    mode: 'normal',
    createdAt: new Date().toISOString(),
  }).run();
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pacc-ghost-'));
  cfg = makeTestConfig(dir);
  await runMigrations(cfg);
  await initDb(cfg);
  store = new SqliteEventStore(getDb(), () => {});
  allocator = new DbSequenceAllocator(getDb());
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerRunEventsRoutes(app, cfg);
  registerRunStreamRoutes(app, cfg);
});

after(async () => {
  flushDbSync(cfg);
  if (app) await app.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('P0-06 ghost __seq_claim rows never leak to readers', () => {
  it('store.list() hides claim rows left behind by a crashed allocate', async () => {
    const runId = 'ghost-list';
    seedRun(runId);
    // allocate() writes a __seq_claim row; simulate a crash BEFORE the real
    // event is appended — the claim row remains in storage forever.
    await allocator.allocate(runId);

    assert.deepEqual(await store.list(runId), []);
  });

  it('store.listAfter() hides claim rows as well', async () => {
    const runId = 'ghost-list-after';
    seedRun(runId);
    await allocator.allocate(runId);

    assert.deepEqual(await store.listAfter(runId, 0), []);
  });

  it('store.latest() and store.get() never return a claim row', async () => {
    const runId = 'ghost-latest';
    seedRun(runId);
    await allocator.allocate(runId);

    assert.equal(await store.latest(runId), undefined, 'latest must not surface a claim');

    // The claim row IS physically present in storage — readers must hide it.
    const claimRow = getDb()
      .select({ id: events.id })
      .from(events)
      .where(eq(events.runId, runId))
      .get();
    assert.ok(claimRow, 'claim row is physically persisted');
    assert.equal(await store.get(runId, claimRow!.id), undefined, 'get must not surface a claim');
  });

  it('allocate + append replaces the claim and reads normally', async () => {
    const runId = 'ghost-replaced';
    seedRun(runId);
    const seq = await allocator.allocate(runId);
    await store.append(makeEvent(runId, seq, 'agent.message.delta', { content: 'hello' }));

    const list = await store.list(runId);
    assert.equal(list.length, 1);
    assert.equal(list[0].seq, seq);
    assert.equal(list[0].type, 'agent.message.delta');
    assert.deepEqual(list[0].payload, { content: 'hello' });
    assert.equal(await store.count(runId), 1);
  });

  it('GET /api/runs/:runId/events filters ghost claims from the response', async () => {
    const runId = 'ghost-route';
    seedRun(runId);
    await allocator.allocate(runId);

    const res = await app.inject({ method: 'GET', url: `/api/runs/${runId}/events?afterSeq=0` });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { events: unknown[]; nextSeq: number };
    assert.deepEqual(body.events, [], 'ghost claim must not appear in the events payload');
  });

  it('readEvents() (SSE replay source) filters ghost claims', async () => {
    const runId = 'ghost-stream';
    seedRun(runId);
    await allocator.allocate(runId);

    assert.deepEqual(readEvents(getDb(), runId, 0), []);
  });
});
