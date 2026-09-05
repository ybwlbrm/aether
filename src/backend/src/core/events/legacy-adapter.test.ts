/**
 * LegacyEventAdapter tests (P3-08)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  toLegacyRow,
  fromLegacyRow,
  syncLegacyToNew,
  syncNewToLegacy,
  type LegacyEventRow,
} from './legacy-adapter.js';
import { verifyRoundTrip } from '@pacc/shared';
import type { AgentEvent } from '@pacc/shared';

function makeEvent(
  type: AgentEvent['type'],
  seq: number,
  runId = 'run-1',
  extra: Record<string, unknown> = {},
): AgentEvent {
  return {
    eventId: `evt-${type}-${seq}`,
    sessionId: 'sess-1',
    runId,
    timestamp: '2026-01-01T00:00:00.000Z',
    seq,
    type,
    version: 2,
    payload: {},
    ...extra,
  } as AgentEvent;
}

function makeRow(overrides: Partial<LegacyEventRow> = {}): LegacyEventRow {
  return {
    id: 'row-1',
    conversationId: 'sess-1',
    taskId: 'run-1',
    agentId: 'main',
    agentType: 'conversation',
    eventType: 'task.started',
    seq: 1,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('core/events/legacy-adapter', () => {
  it('toLegacyRow maps a v2 event to row shape (conversationId = sessionId, taskId = taskId ?? runId)', () => {
    const event = makeEvent('task.started', 3, 'run-9', { taskId: 'task-5' });
    const row = toLegacyRow(event);

    assert.equal(row.id, event.eventId);
    assert.equal(row.conversationId, 'sess-1');
    assert.equal(row.taskId, 'task-5');
    assert.equal(row.seq, 3);
    assert.equal(row.eventType, 'task.started');
    assert.equal(row.createdAt, '2026-01-01T00:00:00.000Z');
  });

  it('toLegacyRow defaults taskId to runId when taskId absent', () => {
    const event = makeEvent('run.created', 1, 'run-7');
    const row = toLegacyRow(event);
    assert.equal(row.taskId, 'run-7');
  });

  it('fromLegacyRow round-trips eventId/seq/type/version', () => {
    const row = makeRow({ id: 'r-id', eventType: 'task.completed', seq: 5, status: 'completed' });
    const event = fromLegacyRow(row, 'run-1');

    assert.equal(event.eventId, 'r-id');
    assert.equal(event.seq, 5);
    assert.equal(event.type, 'task.completed');
    assert.equal(event.version, 2);
    assert.equal(event.runId, 'run-1');
  });

  it('fromLegacyRow carries content through the v1 envelope for message delta events', () => {
    const row = makeRow({
      id: 'msg-1',
      eventType: 'agent.message.delta',
      seq: 7,
      content: 'hello world',
    });
    const event = fromLegacyRow(row, 'run-1');
    assert.equal(event.type, 'agent.message.delta');
    // content survives the envelope round-trip into the v2 payload
    const payload = event.payload as unknown as Record<string, unknown>;
    assert.equal(payload.content, 'hello world');
  });

  it('syncLegacyToNew maps rows preserving seq order and stamps runId', () => {
    const rows = [
      makeRow({ id: 'a', seq: 2, eventType: 'tool.completed' }),
      makeRow({ id: 'b', seq: 1, eventType: 'tool.started' }),
      makeRow({ id: 'c', seq: 3, eventType: 'token.usage' }),
    ];
    const events = syncLegacyToNew(rows, 'run-target');

    assert.equal(events.length, 3);
    assert.deepEqual(events.map((e) => e.seq), [1, 2, 3]);
    for (const e of events) assert.equal(e.runId, 'run-target');
    assert.equal(events[0].eventId, 'b');
  });

  it('syncNewToLegacy drives legacyEmit with sessionId/eventType/seq', () => {
    const events = [
      makeEvent('task.started', 1),
      makeEvent('agent.completed', 2, 'run-1', { agentId: 'a1' }),
    ];
    const calls: Array<{ sessionId: string; eventType: string; seq: number; fields: Record<string, unknown> }> = [];

    syncNewToLegacy(events, (params) => {
      calls.push({
        sessionId: params.sessionId,
        eventType: params.eventType,
        seq: params.seq,
        fields: params.fields,
      });
    });

    assert.equal(calls.length, 2);
    assert.equal(calls[0].sessionId, 'sess-1');
    assert.equal(calls[0].eventType, 'task.started');
    assert.equal(calls[0].seq, 1);
    assert.equal(calls[1].eventType, 'agent.completed');
    assert.equal(calls[1].seq, 2);
  });

  it('round-trip identity via shared verifyRoundTrip for a representative event', () => {
    const event = makeEvent('agent.message.delta', 10, 'run-1', {
      content: 'streaming text',
      taskId: 'task-1',
      agentId: 'agent-1',
    });
    const row = toLegacyRow(event);
    const roundTripped = fromLegacyRow(row, 'run-1');

    const verification = verifyRoundTrip(event, roundTripped);
    assert.ok(verification.ok, `round-trip mismatches: ${verification.mismatches.join(', ')}`);
  });
});