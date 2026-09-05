/**
 * Aether 2.0 — EventStore Unit Tests
 *
 * Tests for InMemoryEventStore covering:
 * - append + list returns [event] sorted
 * - appendBatch multiple
 * - listAfter with limit
 * - get found + undefined
 * - count
 * - latest returns max-seq
 * - append maintains sort when appended out of order
 * - runId isolation
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryEventStore } from './event-store.js';
import type {
  AgentEvent,
  RunEventPayload,
  RunCreatedEvent,
  RunStartedEvent,
  TaskStartedEvent,
  RunCompletedEvent,
  AgentStartedEvent,
  ToolStartedEvent,
  TokenUsageEvent,
} from '@pacc/shared';

// Helper to build a minimal valid v2 AgentEvent (run.created)
function makeRunCreatedEvent(overrides: Omit<Partial<RunCreatedEvent>, 'type'> = {}): RunCreatedEvent {
  return {
    eventId: 'evt-1',
    sessionId: 'session-1',
    runId: 'run-1',
    timestamp: new Date().toISOString(),
    seq: 1,
    type: 'run.created',
    version: 2,
    payload: {} as RunEventPayload,
    ...overrides,
  };
}

// Helper to build a run.started event
function makeRunStartedEvent(overrides: Omit<Partial<RunStartedEvent>, 'type'> = {}): RunStartedEvent {
  return {
    eventId: 'evt-2',
    sessionId: 'session-1',
    runId: 'run-1',
    timestamp: new Date().toISOString(),
    seq: 2,
    type: 'run.started',
    version: 2,
    payload: {} as RunEventPayload,
    ...overrides,
  };
}

// Helper to build a task.started event
function makeTaskStartedEvent(overrides: Omit<Partial<TaskStartedEvent>, 'type'> = {}): TaskStartedEvent {
  return {
    eventId: 'evt-3',
    sessionId: 'session-1',
    runId: 'run-1',
    timestamp: new Date().toISOString(),
    seq: 3,
    type: 'task.started',
    version: 2,
    payload: { status: 'started' },
    ...overrides,
  };
}

// Helper to build a run.completed event
function makeRunCompletedEvent(overrides: Omit<Partial<RunCompletedEvent>, 'type'> = {}): RunCompletedEvent {
  return {
    eventId: 'evt-4',
    sessionId: 'session-1',
    runId: 'run-1',
    timestamp: new Date().toISOString(),
    seq: 4,
    type: 'run.completed',
    version: 2,
    payload: { endReason: 'completed', tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 } },
    ...overrides,
  };
}

// Helper to build an agent.started event
function makeAgentStartedEvent(overrides: Omit<Partial<AgentStartedEvent>, 'type'> = {}): AgentStartedEvent {
  return {
    eventId: 'evt-5',
    sessionId: 'session-1',
    runId: 'run-1',
    timestamp: new Date().toISOString(),
    seq: 5,
    type: 'agent.started',
    version: 2,
    payload: { status: 'running' },
    ...overrides,
  };
}

// Helper to build a tool.started event
function makeToolStartedEvent(overrides: Omit<Partial<ToolStartedEvent>, 'type'> = {}): ToolStartedEvent {
  return {
    eventId: 'evt-6',
    sessionId: 'session-1',
    runId: 'run-1',
    timestamp: new Date().toISOString(),
    seq: 6,
    type: 'tool.started',
    version: 2,
    payload: { toolName: 'read_file', toolInput: 'test.ts', status: 'started' },
    ...overrides,
  };
}

// Helper to build a token.usage event
function makeTokenUsageEvent(overrides: Omit<Partial<TokenUsageEvent>, 'type'> = {}): TokenUsageEvent {
  return {
    eventId: 'evt-7',
    sessionId: 'session-1',
    runId: 'run-1',
    timestamp: new Date().toISOString(),
    seq: 7,
    type: 'token.usage',
    version: 2,
    payload: { inputTokens: 100, outputTokens: 200, totalTokens: 300 },
    ...overrides,
  };
}

describe('EventStore - InMemoryEventStore', () => {
  let store: InMemoryEventStore;

  beforeEach(() => {
    store = new InMemoryEventStore();
  });

  it('append + list returns [event] sorted', async () => {
    const event = makeRunCreatedEvent({ eventId: 'e1', seq: 1 });
    await store.append(event);

    const events = await store.list('run-1');
    assert.equal(events.length, 1);
    assert.deepEqual(events[0].eventId, 'e1');
    assert.deepEqual(events[0].seq, 1);
  });

  it('append maintains sort when appended out of order', async () => {
    // Append out of order: seq 3, then 1, then 2
    await store.append(makeTaskStartedEvent({ eventId: 'e3', seq: 3 }));
    await store.append(makeRunCreatedEvent({ eventId: 'e1', seq: 1 }));
    await store.append(makeRunStartedEvent({ eventId: 'e2', seq: 2 }));

    const events = await store.list('run-1');
    assert.equal(events.length, 3);
    assert.deepEqual(events.map((e) => e.seq), [1, 2, 3]);
    assert.deepEqual(events.map((e) => e.eventId), ['e1', 'e2', 'e3']);
  });

  it('appendBatch multiple events', async () => {
    const events = [
      makeRunCreatedEvent({ eventId: 'e1', seq: 1 }),
      makeRunStartedEvent({ eventId: 'e2', seq: 2 }),
      makeTaskStartedEvent({ eventId: 'e3', seq: 3 }),
    ];

    await store.appendBatch(events);

    const listed = await store.list('run-1');
    assert.equal(listed.length, 3);
    assert.deepEqual(listed.map((e) => e.eventId), ['e1', 'e2', 'e3']);
  });

  it('appendBatch with empty array does nothing', async () => {
    await store.appendBatch([]);
    const events = await store.list('run-1');
    assert.deepEqual(events, []);
  });

  it('appendBatch maintains sort across batches', async () => {
    await store.appendBatch([
      makeTaskStartedEvent({ eventId: 'e3', seq: 3 }),
      makeRunCreatedEvent({ eventId: 'e1', seq: 1 }),
    ]);
    await store.appendBatch([
      makeRunStartedEvent({ eventId: 'e2', seq: 2 }),
    ]);

    const events = await store.list('run-1');
    assert.equal(events.length, 3);
    assert.deepEqual(events.map((e) => e.seq), [1, 2, 3]);
  });

  it('listAfter with limit returns filtered and limited results', async () => {
    await store.append(makeRunCreatedEvent({ eventId: 'e1', seq: 1 }));
    await store.append(makeRunStartedEvent({ eventId: 'e2', seq: 2 }));
    await store.append(makeTaskStartedEvent({ eventId: 'e3', seq: 3 }));
    await store.append(makeRunCreatedEvent({ eventId: 'e4', seq: 4 }));

    const after1 = await store.listAfter('run-1', 1);
    assert.deepEqual(after1.map((e) => e.seq), [2, 3, 4]);

    const after2Limited = await store.listAfter('run-1', 1, 2);
    assert.equal(after2Limited.length, 2);
    assert.deepEqual(after2Limited.map((e) => e.seq), [2, 3]);

    const after3 = await store.listAfter('run-1', 3);
    assert.deepEqual(after3.map((e) => e.seq), [4]);

    const after4 = await store.listAfter('run-1', 4);
    assert.deepEqual(after4, []);
  });

  it('listAfter returns empty for unknown runId', async () => {
    const events = await store.listAfter('unknown-run', 0);
    assert.deepEqual(events, []);
  });

  it('get returns event when found', async () => {
    const event = makeRunCreatedEvent({ eventId: 'e1', seq: 1 });
    await store.append(event);

    const found = await store.get('run-1', 'e1');
    assert.ok(found);
    assert.deepEqual(found?.eventId, 'e1');
    assert.deepEqual(found?.seq, 1);
  });

  it('get returns undefined when not found', async () => {
    await store.append(makeRunCreatedEvent({ eventId: 'e1', seq: 1 }));

    const notFound = await store.get('run-1', 'nonexistent');
    assert.equal(notFound, undefined);

    const wrongRun = await store.get('other-run', 'e1');
    assert.equal(wrongRun, undefined);
  });

  it('count returns correct number of events for runId', async () => {
    assert.equal(await store.count('run-1'), 0);

    await store.append(makeRunCreatedEvent({ eventId: 'e1', seq: 1 }));
    assert.equal(await store.count('run-1'), 1);

    await store.append(makeRunStartedEvent({ eventId: 'e2', seq: 2 }));
    assert.equal(await store.count('run-1'), 2);

    await store.appendBatch([
      makeTaskStartedEvent({ eventId: 'e3', seq: 3 }),
      makeRunCreatedEvent({ eventId: 'e4', seq: 4 }),
    ]);
    assert.equal(await store.count('run-1'), 4);

    // Different runId has separate count
    assert.equal(await store.count('run-2'), 0);
  });

  it('latest returns max-seq event', async () => {
    assert.equal(await store.latest('run-1'), undefined);

    await store.append(makeRunCreatedEvent({ eventId: 'e1', seq: 1 }));
    let latest = await store.latest('run-1');
    assert.ok(latest);
    assert.deepEqual(latest?.seq, 1);

    await store.append(makeRunStartedEvent({ eventId: 'e2', seq: 2 }));
    latest = await store.latest('run-1');
    assert.ok(latest);
    assert.deepEqual(latest?.seq, 2);

    await store.append(makeTaskStartedEvent({ eventId: 'e3', seq: 3 }));
    latest = await store.latest('run-1');
    assert.ok(latest);
    assert.deepEqual(latest?.seq, 3);
    assert.deepEqual(latest?.eventId, 'e3');
  });

  it('latest returns undefined for unknown runId', async () => {
    const latest = await store.latest('unknown-run');
    assert.equal(latest, undefined);
  });

  it('runId isolation - events do not leak across runs', async () => {
    await store.append(makeRunCreatedEvent({ eventId: 'e1', seq: 1, runId: 'run-A' }));
    await store.append(makeRunStartedEvent({ eventId: 'e2', seq: 2, runId: 'run-A' }));
    await store.append(makeRunCreatedEvent({ eventId: 'e3', seq: 1, runId: 'run-B' }));

    const runA = await store.list('run-A');
    const runB = await store.list('run-B');

    assert.equal(runA.length, 2);
    assert.deepEqual(runA.map((e) => e.eventId), ['e1', 'e2']);

    assert.equal(runB.length, 1);
    assert.deepEqual(runB.map((e) => e.eventId), ['e3']);

    // count isolated
    assert.equal(await store.count('run-A'), 2);
    assert.equal(await store.count('run-B'), 1);

    // latest isolated
    const latestA = await store.latest('run-A');
    const latestB = await store.latest('run-B');
    assert.ok(latestA);
    assert.ok(latestB);
    assert.deepEqual(latestA?.eventId, 'e2');
    assert.deepEqual(latestB?.eventId, 'e3');

    // get isolated
    const getA = await store.get('run-A', 'e1');
    const getB = await store.get('run-B', 'e1');
    assert.ok(getA);
    assert.equal(getB, undefined);

    // listAfter isolated
    const afterA = await store.listAfter('run-A', 0);
    const afterB = await store.listAfter('run-B', 0);
    assert.equal(afterA.length, 2);
    assert.equal(afterB.length, 1);
  });

  it('appendBatch with events from multiple runIds stores correctly', async () => {
    await store.appendBatch([
      makeRunCreatedEvent({ eventId: 'e1', seq: 1, runId: 'run-A' }),
      makeRunCreatedEvent({ eventId: 'e2', seq: 1, runId: 'run-B' }),
      makeRunStartedEvent({ eventId: 'e3', seq: 2, runId: 'run-A' }),
    ]);

    const runA = await store.list('run-A');
    const runB = await store.list('run-B');

    assert.equal(runA.length, 2);
    assert.deepEqual(runA.map((e) => e.eventId), ['e1', 'e3']);

    assert.equal(runB.length, 1);
    assert.deepEqual(runB.map((e) => e.eventId), ['e2']);
  });

  it('list returns copy - external mutation does not affect store', async () => {
    await store.append(makeRunCreatedEvent({ eventId: 'e1', seq: 1 }));

    const events = await store.list('run-1');
    events.push({} as AgentEvent); // Mutate the returned array

    const eventsAgain = await store.list('run-1');
    assert.equal(eventsAgain.length, 1); // Original store unchanged
  });

  it('listAfter returns copy - external mutation does not affect store', async () => {
    await store.append(makeRunCreatedEvent({ eventId: 'e1', seq: 1 }));
    await store.append(makeRunStartedEvent({ eventId: 'e2', seq: 2 }));

    const events = await store.listAfter('run-1', 0);
    events.push({} as AgentEvent);

    const eventsAgain = await store.listAfter('run-1', 0);
    assert.equal(eventsAgain.length, 2);
  });
});