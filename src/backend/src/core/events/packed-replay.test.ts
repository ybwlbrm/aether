/**
 * P0-05 regression tests — packed rows must replay by LOGICAL sub-event seq.
 *
 * Background: chunk-packer collapses multiple delta sub-events into ONE
 * physical row whose `seq` is the LAST sub-event's seq. The replay paths used
 * to filter by PHYSICAL row seq only, so:
 *  - `listAfter(afterSeq)` returned a straddling pack ENTIRELY (sub-events
 *    ≤ afterSeq leaked through as duplicates);
 *  - GET /api/runs/:runId/events and stream `readEvents` never expanded the
 *    packed column at all (only the last sub-event's payload surfaced — events
 *    were lost on reconnect).
 *
 * These tests pin the correct behavior: packed rows expand back into their
 * sub-event stream and replay filters by LOGICAL seq.
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../../db/migrate.js';
import { initDb, getDb, flushDbSync } from '../../db/client.js';
import { SqliteEventStore } from './event-store.sqlite.js';
import type { PackedChunk } from './chunk-packer.js';
import { runs } from '../../db/schema/index.js';
import { registerErrorHandler } from '../../plugins/error-handler.js';
import { registerRunEventsRoutes } from '../../modules/runs/events.js';
import { readEvents } from '../../modules/runs/stream.js';
import { makeTestConfig } from '../../tests/helpers/mock-provider.sse.js';
import type { BackendConfig } from '../../config/index.js';
import type { AgentEvent } from '@pacc/shared';
import type { SQLJsDatabase } from 'drizzle-orm/sql-js';
import * as schema from '../../db/schema/index.js';

type Db = SQLJsDatabase<typeof schema>;

const TS = '2026-01-01T00:00:00.000Z';

/** First/last seq of the packed row used by every scenario */
const PACK_FROM = 101;
const PACK_TO = 196;
/** End of the whole seeded logical stream (non-packed events follow the pack) */
const STREAM_END = 200;

function makeChunk(runId: string, seq: number): PackedChunk {
  return {
    eventId: `evt-${runId}-${seq}`,
    seq,
    type: 'agent.message.delta',
    content: `chunk-${seq}`,
    timestamp: TS,
  };
}

function makeRunEvent(runId: string, seq: number): AgentEvent {
  return {
    eventId: `evt-${runId}-${seq}`,
    sessionId: 'session-1',
    runId,
    timestamp: TS,
    seq,
    type: 'run.created',
    version: 2,
    payload: {},
  } as AgentEvent;
}

/** The logical seqs expected for `seq > N` over the seeded 1..200 stream */
function expectedSeqsAfter(n: number): number[] {
  const out: number[] = [];
  for (let i = n + 1; i <= STREAM_END; i++) out.push(i);
  return out;
}

describe('P0-05 packed replay — logical sub-event seq filtering', () => {
  let store: SqliteEventStore;
  let dir: string;
  let app: FastifyInstance;
  let cfg: BackendConfig;

  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pacc-packed-replay-'));
    cfg = makeTestConfig(dir);
    await runMigrations(cfg);
    await initDb(cfg);
    store = new SqliteEventStore(getDb(), () => {});
    app = Fastify({ logger: false });
    registerErrorHandler(app);
    registerRunEventsRoutes(app, cfg);
  });

  after(async () => {
    flushDbSync(cfg);
    if (app) await app.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  function seedRun(runId: string): void {
    getDb().insert(runs).values({ id: runId, createdAt: TS }).run();
  }

  /**
   * Seed a logical stream of 1..200:
   *  - non-packed events 1..100 (store.append)
   *  - ONE packed row holding sub-events 101..196 (physical row seq = 196)
   *  - non-packed events 197..200 (store.append)
   */
  async function seedMixedStream(runId: string): Promise<void> {
    seedRun(runId);
    for (let i = 1; i < PACK_FROM; i++) await store.append(makeRunEvent(runId, i));
    const chunks: PackedChunk[] = [];
    for (let i = PACK_FROM; i <= PACK_TO; i++) chunks.push(makeChunk(runId, i));
    await store.appendPacked(runId, chunks, 'agent.message.delta');
    for (let i = PACK_TO + 1; i <= STREAM_END; i++) await store.append(makeRunEvent(runId, i));
  }

  it('listAfter(150) excludes packed sub-events ≤ 150 (must not return duplicates)', async () => {
    const runId = 'run-after';
    await seedMixedStream(runId);

    const after = await store.listAfter(runId, 150);
    const seqs = after.map((e) => e.seq);

    // The packed row straddles 150: its physical seq is 196 (> 150), so it is
    // fetched, but the logical filter must drop sub-events 101..150.
    assert.deepEqual(seqs, expectedSeqsAfter(150));
  });

  it('listAfter(0) returns the full logical stream in seq order (packed expanded)', async () => {
    const runId = 'run-full';
    await seedMixedStream(runId);

    const all = await store.listAfter(runId, 0);
    const seqs = all.map((e) => e.seq);
    assert.deepEqual(seqs, expectedSeqsAfter(0));
  });

  it('GET /api/runs/:runId/events?afterSeq=150 returns only logical events > 150', async () => {
    const runId = 'run-route';
    await seedMixedStream(runId);

    const res = await app.inject({ method: 'GET', url: `/api/runs/${runId}/events?afterSeq=150` });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { events: Array<{ seq: number; type: string }>; nextSeq: number };

    // The route must surface the expanded packed sub-events 151..196 (not just
    // the row's last payload) and nothing ≤ 150.
    assert.deepEqual(body.events.map((e) => e.seq), expectedSeqsAfter(150));
    assert.equal(body.nextSeq, STREAM_END);
  });

  it('readEvents (SSE resume) expands packed rows and filters by logical seq', async () => {
    const runId = 'run-stream';
    await seedMixedStream(runId);

    const db: Db = getDb();
    const after = readEvents(db, runId, 150);
    assert.deepEqual(after.map((r) => r.seq), expectedSeqsAfter(150));

    // Every returned row must carry a valid v2 event envelope.
    for (const row of after) {
      const event = JSON.parse(row.payload) as { seq: number; version: number };
      assert.equal(event.version, 2);
      assert.ok(event.seq > 150);
    }
  });
});
