/**
 * Run Events endpoint tests (P3-06 — reconnection / incremental replay)
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import Fastify, { type FastifyInstance } from 'fastify';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../../db/migrate.js';
import { initDb, getDb, flushDbSync } from '../../db/client.js';
import { registerErrorHandler } from '../../plugins/error-handler.js';
import { registerRunEventsRoutes } from './index.js';
import { makeTestConfig } from '../../tests/helpers/mock-provider.sse.js';
import type { BackendConfig } from '../../config/index.js';
import { events, runs } from '../../db/schema/index.js';
import { eq } from 'drizzle-orm';

interface EventJson {
  eventId: string;
  seq: number;
  type: string;
  version: number;
  payload: Record<string, unknown>;
}

let app: FastifyInstance;
let cfg: BackendConfig;
let dir: string;

/** Seed a run + a batch of event rows directly (bypassing Run API for speed) */
function seedRunAndEvents(runId: string, count: number): void {
  getDb().insert(runs).values({
    id: runId,
    status: 'running',
    mode: 'normal',
    createdAt: new Date().toISOString(),
  }).run();

  for (let i = 1; i <= count; i++) {
    getDb().insert(events).values({
      id: `evt-${runId}-${i}`,
      runId,
      seq: i,
      eventType: 'agent.message.delta',
      eventVersion: 2,
      payload: JSON.stringify({
        eventId: `evt-${runId}-${i}`,
        sessionId: 'sess-1',
        runId,
        timestamp: '2026-01-01T00:00:00.000Z',
        seq: i,
        type: 'agent.message.delta',
        version: 2,
        payload: { content: `chunk-${i}` },
      }),
      createdAt: new Date().toISOString(),
    }).run();
  }
}

describe('runs events 端点 — 断线恢复 / 增量回放（P3-06）', () => {
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pacc-runs-events-'));
    cfg = makeTestConfig(dir);
    await runMigrations(cfg);
    await initDb(cfg);
    app = Fastify({ logger: false });
    registerErrorHandler(app);
    registerRunEventsRoutes(app, cfg);
  });

  after(async () => {
    flushDbSync(cfg);
    if (app) await app.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it('returns all events in seq order when afterSeq=0', async () => {
    seedRunAndEvents('run-full', 3);
    const res = await app.inject({ method: 'GET', url: '/api/runs/run-full/events?afterSeq=0' });

    assert.equal(res.statusCode, 200);
    const body = res.json() as { events: EventJson[]; nextSeq: number };
    assert.equal(body.events.length, 3);
    assert.deepEqual(body.events.map((e) => e.seq), [1, 2, 3]);
    assert.equal(body.nextSeq, 3);
    // payload preserved as full v2 event
    assert.equal((body.events[0].payload as { content?: string }).content, 'chunk-1');
  });

  it('afterSeq resumes from the last received seq (reconnection)', async () => {
    seedRunAndEvents('run-resume', 5);
    // client saw up to seq=2, reconnect with afterSeq=2
    const res = await app.inject({ method: 'GET', url: '/api/runs/run-resume/events?afterSeq=2' });

    assert.equal(res.statusCode, 200);
    const body = res.json() as { events: EventJson[]; nextSeq: number };
    assert.deepEqual(body.events.map((e) => e.seq), [3, 4, 5]);
    assert.equal(body.nextSeq, 5);
  });

  it('afterSeq beyond the end returns empty events with nextSeq=afterSeq', async () => {
    seedRunAndEvents('run-end', 4);
    const res = await app.inject({ method: 'GET', url: '/api/runs/run-end/events?afterSeq=10' });

    assert.equal(res.statusCode, 200);
    const body = res.json() as { events: EventJson[]; nextSeq: number };
    assert.deepEqual(body.events, []);
    assert.equal(body.nextSeq, 10);
  });

  it('limit caps the returned page (pagination)', async () => {
    seedRunAndEvents('run-page', 10);
    const res = await app.inject({ method: 'GET', url: '/api/runs/run-page/events?afterSeq=0&limit=4' });

    assert.equal(res.statusCode, 200);
    const body = res.json() as { events: EventJson[]; nextSeq: number };
    assert.equal(body.events.length, 4);
    assert.deepEqual(body.events.map((e) => e.seq), [1, 2, 3, 4]);
    assert.equal(body.nextSeq, 4);
  });

  it('404 for an unknown run', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/runs/does-not-exist/events?afterSeq=0' });
    assert.equal(res.statusCode, 404);
    const body = res.json() as { error: { code: string } };
    assert.equal(body.error.code, 'RUN_NOT_FOUND');
  });

  it('invalid afterSeq falls back to 0 (all events)', async () => {
    seedRunAndEvents('run-invalid', 2);
    const res = await app.inject({ method: 'GET', url: '/api/runs/run-invalid/events?afterSeq=abc' });
    assert.equal(res.statusCode, 200);
    const body = res.json() as { events: EventJson[] };
    assert.equal(body.events.length, 2);
  });
});