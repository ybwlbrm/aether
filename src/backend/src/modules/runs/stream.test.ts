/**
 * Run Stream endpoint tests (P3-05/P3-06 — v2 SSE + Last-Event-ID resume)
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
import { registerRunStreamRoutes, readEvents } from './stream.js';
import { makeTestConfig } from '../../tests/helpers/mock-provider.sse.js';
import type { BackendConfig } from '../../config/index.js';
import { events, runs } from '../../db/schema/index.js';
import type { SQLJsDatabase } from 'drizzle-orm/sql-js';
import * as schema from '../../db/schema/index.js';
import { formatSseEvent } from '../../core/events/index.js';
import type { AgentEvent } from '@pacc/shared';

type Db = SQLJsDatabase<typeof schema>;

let app: FastifyInstance;
let cfg: BackendConfig;
let dir: string;

function seedRun(runId: string): void {
  getDb().insert(runs).values({
    id: runId,
    status: 'running',
    mode: 'normal',
    createdAt: new Date().toISOString(),
  }).run();
}

function seedEvent(runId: string, seq: number, type = 'agent.message.delta', content = `chunk-${seq}`): void {
  getDb().insert(events).values({
    id: `evt-${runId}-${seq}`,
    runId,
    seq,
    eventType: type,
    eventVersion: 2,
    payload: JSON.stringify({
      eventId: `evt-${runId}-${seq}`,
      sessionId: 'sess-1',
      runId,
      timestamp: '2026-01-01T00:00:00.000Z',
      seq,
      type,
      version: 2,
      payload: { content },
    } as AgentEvent),
    createdAt: new Date().toISOString(),
  }).run();
}

before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'pacc-stream-'));
  cfg = makeTestConfig(dir);
  await runMigrations(cfg);
  await initDb(cfg);
  app = Fastify({ logger: false });
  registerErrorHandler(app);
  registerRunStreamRoutes(app, cfg);
});

after(async () => {
  flushDbSync(cfg);
  if (app) await app.close();
  if (dir) rmSync(dir, { recursive: true, force: true });
});

describe('runs stream 端点 — v2 SSE + Last-Event-ID（P3-05/06）', () => {
  it('404 for an unknown run', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/runs/does-not-exist/stream' });
    assert.equal(res.statusCode, 404);
    const body = res.json() as { error: { code: string } };
    assert.equal(body.error.code, 'RUN_NOT_FOUND');
  });

  it('readEvents resumes from afterSeq (Last-Event-ID continuation)', () => {
    seedRun('run-seed');
    seedEvent('run-seed', 1);
    seedEvent('run-seed', 2);
    seedEvent('run-seed', 3);
    seedEvent('run-seed', 4);
    seedEvent('run-seed', 5);

    const db: Db = getDb();
    // Client saw up to seq=2 → reconnect with Last-Event-ID=2 → expect 3,4,5
    const after2 = readEvents(db, 'run-seed', 2);
    assert.deepEqual(after2.map((r) => r.seq), [3, 4, 5]);
    // From 0 → all
    assert.equal(readEvents(db, 'run-seed', 0).length, 5);
    // Beyond end → empty
    assert.deepEqual(readEvents(db, 'run-seed', 10), []);
  });

  it('readEvents returns events in seq order and preserves type', () => {
    seedRun('run-order');
    seedEvent('run-order', 1, 'run.created', 'created');
    seedEvent('run-order', 2, 'tool.completed', 'done');

    const db: Db = getDb();
    const rows = readEvents(db, 'run-order', 0);
    assert.deepEqual(rows.map((r) => r.type), ['run.created', 'tool.completed']);
    // Each payload parses into a valid v2 event
    for (const row of rows) {
      const event = JSON.parse(row.payload) as { seq: number; type: string; version: number };
      assert.equal(event.version, 2);
      assert.ok(event.seq > 0);
    }
  });

  it('SSE frame format (id: seq) round-trips through formatSseEvent', () => {
    const event: AgentEvent = {
      eventId: 'evt-x',
      sessionId: 's',
      runId: 'r',
      timestamp: '2026-01-01T00:00:00.000Z',
      seq: 7,
      type: 'run.started',
      version: 2,
      payload: {},
    } as AgentEvent;

    const frame = formatSseEvent(event);
    assert.ok(frame.startsWith('event: run.started\n'));
    assert.ok(frame.includes('\nid: 7\n\n'));
  });
});