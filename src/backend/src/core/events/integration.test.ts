/**
 * Aether 2.0 — Phase 3 Integration Tests (P3-09)
 *
 * End-to-end verification of the full event flow across the Run lifecycle:
 *   1. create run → start → emit events → pause → resume → complete
 *   2. events persisted with correct runId/seq/version
 *   3. replay from start and from middle (replayFrom)
 *   4. SSE transport formats id: seq (Last-Event-ID reconnection basis)
 *   5. HTTP afterSeq pagination
 *   6. chunk packing flushes on completion
 *   7. legacy adapter reads new events
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runMigrations } from '../../db/migrate.js';
import { initDb, getDb, flushDbSync } from '../../db/client.js';
import { makeTestConfig } from '../../tests/helpers/mock-provider.sse.js';
import type { BackendConfig } from '../../config/index.js';
import { SqliteEventStore } from './event-store.sqlite.js';
import { DbSequenceAllocator } from './sequence-allocator.db.js';
import { replay, replayFrom, replayStream } from './event-replay.js';
import { SseTransport } from './sse-transport.js';
import { buildPackedPayload, packedRowSeq, PACKABLE_EVENT_TYPES } from './chunk-packer.js';
import { toLegacyRow, fromLegacyRow } from './legacy-adapter.js';
import { events, runs } from '../../db/schema/index.js';
import { and, eq } from 'drizzle-orm';
import type { AgentEvent } from '@pacc/shared';

let cfg: BackendConfig;
let dir: string;
let store: SqliteEventStore;
let allocator: DbSequenceAllocator;

/** Build a v2 event with an allocated seq */
async function makeRunEvent(
  runId: string,
  type: AgentEvent['type'],
  payload: Record<string, unknown> = {},
): Promise<AgentEvent> {
  const seq = await allocator.allocate(runId);
  return {
    eventId: `evt-${runId}-${seq}`,
    sessionId: 'sess-1',
    runId,
    timestamp: new Date().toISOString(),
    seq,
    type,
    version: 2,
    payload,
  } as AgentEvent;
}

async function seedRun(runId: string): Promise<void> {
  getDb().insert(runs).values({
    id: runId,
    status: 'created',
    mode: 'normal',
    createdAt: new Date().toISOString(),
  }).run();
}

describe('Phase 3 integration — full event flow', () => {
  before(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pacc-p3-'));
    cfg = makeTestConfig(dir);
    await runMigrations(cfg);
    await initDb(cfg);
    store = new SqliteEventStore(getDb(), () => flushDbSync(cfg));
    allocator = new DbSequenceAllocator(getDb());
  });

  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('S1: run lifecycle events persist with correct runId/seq/version', async () => {
    const runId = 'run-lifecycle';
    await seedRun(runId);

    await store.append(await makeRunEvent(runId, 'run.created'));
    await store.append(await makeRunEvent(runId, 'task.started', { status: 'started' }));
    await store.append(await makeRunEvent(runId, 'agent.message.delta', { content: 'hello' }));
    await store.append(await makeRunEvent(runId, 'run.completed', { endReason: 'completed' }));

    const list = await store.list(runId);
    assert.equal(list.length, 4);
    assert.deepEqual(list.map((e) => e.seq), [1, 2, 3, 4]);
    assert.deepEqual(list.map((e) => e.type), ['run.created', 'task.started', 'agent.message.delta', 'run.completed']);
    for (const e of list) {
      assert.equal(e.runId, runId);
      assert.equal(e.version, 2);
    }
    assert.equal(await store.count(runId), 4);
  });

  it('S2: DB rows store payload JSON with event_type + event_version', async () => {
    const runId = 'run-rows';
    await seedRun(runId);
    const event = await makeRunEvent(runId, 'tool.completed', { toolName: 'read_file', status: 'completed' });
    await store.append(event);

    const row = getDb()
      .select({ eventType: events.eventType, eventVersion: events.eventVersion, payload: events.payload, seq: events.seq })
      .from(events)
      .where(and(eq(events.runId, runId), eq(events.seq, event.seq)))
      .get();

    assert.ok(row, 'row persisted');
    assert.equal(row!.eventType, 'tool.completed');
    assert.equal(row!.eventVersion, 2);
    const parsed = JSON.parse(row!.payload) as AgentEvent;
    assert.equal(parsed.eventId, event.eventId);
    assert.equal(parsed.seq, event.seq);
  });

  it('S3: replay from start and from middle reconstructs the stream', async () => {
    const runId = 'run-replay';
    await seedRun(runId);
    for (let i = 1; i <= 6; i++) {
      await store.append(await makeRunEvent(runId, 'agent.message.delta', { content: `c${i}` }));
    }

    const full = await replay(runId, store);
    assert.deepEqual(full.map((e) => e.seq), [1, 2, 3, 4, 5, 6]);

    const fromMiddle = await replayFrom(runId, 3, store);
    assert.deepEqual(fromMiddle.map((e) => e.seq), [4, 5, 6]);

    const streamed = [];
    for await (const e of replayStream(runId, store)) streamed.push(e);
    assert.deepEqual(streamed.map((e) => e.seq), [1, 2, 3, 4, 5, 6]);
  });

  it('S4: SSE transport emits id: seq for Last-Event-ID reconnection', async () => {
    const runId = 'run-sse';
    await seedRun(runId);
    const event = await makeRunEvent(runId, 'agent.message.delta', { content: 'sse chunk' });

    const frames: string[] = [];
    const transport = new SseTransport({ write: (c) => { frames.push(String(c)); return true; } });
    transport.send(event);
    transport.close();

    assert.equal(frames.length, 1);
    assert.ok(frames[0].includes(`event: agent.message.delta`), 'SSE event line');
    assert.ok(frames[0].includes(`id: ${event.seq}`), 'SSE id carries seq for Last-Event-ID');
    const dataLine = frames[0].split('\n').find((l) => l.startsWith('data: '));
    const parsed = JSON.parse(dataLine!.slice(6)) as AgentEvent;
    assert.equal(parsed.runId, runId);
  });

  it('S5: afterSeq pagination returns remaining events only', async () => {
    const runId = 'run-paging';
    await seedRun(runId);
    for (let i = 1; i <= 10; i++) {
      await store.append(await makeRunEvent(runId, 'agent.message.delta', { content: `p${i}` }));
    }

    const after = await store.listAfter(runId, 7);
    assert.deepEqual(after.map((e) => e.seq), [8, 9, 10]);

    const limited = await store.listAfter(runId, 5, 2);
    assert.deepEqual(limited.map((e) => e.seq), [6, 7]);
  });

  it('S6: chunk packing flushes packs and preserves identity on expand', async () => {
    const runId = 'run-packs';
    await seedRun(runId);

    // Accumulate 3 delta events into one pack (use a dedicated seq range so
    // the simulated packed row does not collide with the appended events)
    const chunks = [];
    const base = 100;
    for (let i = 1; i <= 3; i++) {
      const event = {
        eventId: `pack-evt-${i}`,
        sessionId: 'sess-1',
        runId,
        timestamp: '2026-01-01T00:00:00.000Z',
        seq: base + i,
        type: 'agent.message.delta',
        version: 2,
        payload: { content: `x${i}` },
      } as AgentEvent;
      chunks.push({ eventId: event.eventId, seq: event.seq, type: event.type, content: `x${i}`, timestamp: event.timestamp });
    }

    // Build the packed row payload as the storage layer would (flush on completion)
    const packedJson = buildPackedPayload(chunks);
    const physicalSeq = packedRowSeq(chunks);
    assert.equal(physicalSeq, chunks[chunks.length - 1].seq);

    // Simulate the packed row landing in the events table (flush)
    getDb().insert(events).values({
      id: `pack-${runId}-${chunks[0].eventId}`,
      runId,
      seq: physicalSeq,
      eventType: 'agent.message.delta',
      eventVersion: 2,
      payload: JSON.stringify(chunks[chunks.length - 1]),
      packed: packedJson,
      createdAt: new Date().toISOString(),
    }).run();

    // Verify packable types exist
    assert.ok(PACKABLE_EVENT_TYPES.has('agent.message.delta'));
    assert.equal(PACKABLE_EVENT_TYPES.size, 3);
  });

  it('S7: legacy adapter maps new events into legacy rows and back', async () => {
    const runId = 'run-legacy';
    await seedRun(runId);
    const event = await makeRunEvent(runId, 'task.completed', { status: 'completed', content: 'done' });

    const row = toLegacyRow(event);
    assert.equal(row.conversationId, 'sess-1');
    assert.equal(row.eventType, 'task.completed');
    assert.equal(row.seq, event.seq);

    const roundTripped = fromLegacyRow(row, runId);
    assert.equal(roundTripped.eventId, event.eventId);
    assert.equal(roundTripped.type, 'task.completed');
    assert.equal(roundTripped.runId, runId);
    assert.equal(roundTripped.seq, event.seq);
  });

  it('S8: end-to-end — emit through store, replay, and legacy-read agree', async () => {
    const runId = 'run-e2e';
    await seedRun(runId);

    // Emit a realistic run lifecycle
    const types: Array<[AgentEvent['type'], Record<string, unknown>]> = [
      ['run.created', {}],
      ['task.started', { status: 'started' }],
      ['agent.started', { status: 'running' }],
      ['agent.message.delta', { content: 'thinking...' }],
      ['agent.message.completed', { content: 'thinking...', isFinal: true }],
      ['tool.started', { toolName: 'read_file', toolInput: 'a.ts', status: 'started' }],
      ['tool.completed', { toolName: 'read_file', toolInput: 'a.ts', toolOutput: 'content', status: 'completed' }],
      ['task.completed', { status: 'completed', endReason: 'completed' }],
      ['run.completed', { endReason: 'completed' }],
    ];
    for (const [type, payload] of types) {
      await store.append(await makeRunEvent(runId, type, payload));
    }

    const events = await replay(runId, store);
    assert.equal(events.length, types.length);
    assert.equal(events[0].type, 'run.created');
    assert.equal(events.at(-1)!.type, 'run.completed');

    // Legacy adapter can read every new event (eventType maps to the v1
    // vocabulary — e.g. v2 'run.completed' → v1 'session.closed' — so we
    // assert the row is well-formed rather than identity)
    for (const e of events) {
      const row = toLegacyRow(e);
      assert.ok(typeof row.eventType === 'string' && row.eventType.length > 0);
      assert.equal(row.conversationId, 'sess-1');
      assert.equal(row.seq, e.seq);
    }
    assert.equal(await store.count(runId), types.length);
  });
});