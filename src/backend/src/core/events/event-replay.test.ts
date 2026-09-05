/**
 * Aether 2.0 — EventReplay Unit Tests
 *
 * Tests for replay() and replayFrom() covering:
 * - returns events sorted by seq for a seeded store
 * - empty run returns []
 * - replayFrom skips events with seq <= given seq
 * - replayFrom respects limit
 * - replayFrom eventTypes filter (only matching types)
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryEventStore } from './event-store.js';
import { replay, replayFrom } from './event-replay.js';
import type {
  AgentEvent,
  RunEventPayload,
  RunCreatedEvent,
  RunStartedEvent,
  TaskStartedEvent,
  ToolStartedEvent,
  TokenUsageEvent,
} from '@pacc/shared';

const RUN = 'run-replay-1';

let eventCounter = 0;
function nextEventId(): string {
  eventCounter += 1;
  return `evt-${eventCounter}`;
}

function makeRunCreatedEvent(overrides: Omit<Partial<RunCreatedEvent>, 'type'> = {}): RunCreatedEvent {
  return {
    eventId: nextEventId(),
    sessionId: 'session-1',
    runId: RUN,
    timestamp: new Date().toISOString(),
    seq: 1,
    type: 'run.created',
    version: 2,
    payload: {} as RunEventPayload,
    ...overrides,
  };
}

function makeRunStartedEvent(overrides: Omit<Partial<RunStartedEvent>, 'type'> = {}): RunStartedEvent {
  return {
    eventId: nextEventId(),
    sessionId: 'session-1',
    runId: RUN,
    timestamp: new Date().toISOString(),
    seq: 1,
    type: 'run.started',
    version: 2,
    payload: {} as RunEventPayload,
    ...overrides,
  };
}

function makeTaskStartedEvent(overrides: Omit<Partial<TaskStartedEvent>, 'type'> = {}): TaskStartedEvent {
  return {
    eventId: nextEventId(),
    sessionId: 'session-1',
    runId: RUN,
    timestamp: new Date().toISOString(),
    seq: 1,
    type: 'task.started',
    version: 2,
    payload: { status: 'started' },
    ...overrides,
  };
}

function makeToolStartedEvent(overrides: Omit<Partial<ToolStartedEvent>, 'type'> = {}): ToolStartedEvent {
  return {
    eventId: nextEventId(),
    sessionId: 'session-1',
    runId: RUN,
    timestamp: new Date().toISOString(),
    seq: 1,
    type: 'tool.started',
    version: 2,
    payload: { toolName: 'read_file', toolInput: 'test.ts', status: 'started' },
    ...overrides,
  };
}

function makeTokenUsageEvent(overrides: Omit<Partial<TokenUsageEvent>, 'type'> = {}): TokenUsageEvent {
  return {
    eventId: nextEventId(),
    sessionId: 'session-1',
    runId: RUN,
    timestamp: new Date().toISOString(),
    seq: 1,
    type: 'token.usage',
    version: 2,
    payload: { inputTokens: 10, outputTokens: 20, totalTokens: 30 },
    ...overrides,
  };
}

describe('EventReplay', () => {
  let store: InMemoryEventStore;

  beforeEach(() => {
    store = new InMemoryEventStore();
  });

  it('replay returns events sorted by seq for a seeded store', async () => {
    // Seed out of order to prove sorting
    await store.append(makeToolStartedEvent({ eventId: 'e-tool', seq: 5 }));
    await store.append(makeRunCreatedEvent({ eventId: 'e-run', seq: 1 }));
    await store.append(makeTaskStartedEvent({ eventId: 'e-task', seq: 3 }));
    await store.append(makeRunStartedEvent({ eventId: 'e-start', seq: 2 }));
    await store.append(makeTokenUsageEvent({ eventId: 'e-token', seq: 4 }));

    const events = await replay(RUN, store);

    assert.equal(events.length, 5);
    assert.deepEqual(events.map((e) => e.seq), [1, 2, 3, 4, 5]);
    assert.deepEqual(
      events.map((e) => e.eventId),
      ['e-run', 'e-start', 'e-task', 'e-token', 'e-tool'],
    );
  });

  it('replay on empty run returns []', async () => {
    const events = await replay(RUN, store);
    assert.deepEqual(events, []);
  });

  it('replay returns [] for an unknown runId', async () => {
    await store.append(makeRunCreatedEvent({ eventId: 'e-run', seq: 1 }));
    const events = await replay('never-seen-run', store);
    assert.deepEqual(events, []);
  });

  it('replayFrom skips events with seq <= given seq', async () => {
    await store.append(makeRunCreatedEvent({ eventId: 'e1', seq: 1 }));
    await store.append(makeRunStartedEvent({ eventId: 'e2', seq: 2 }));
    await store.append(makeTaskStartedEvent({ eventId: 'e3', seq: 3 }));
    await store.append(makeToolStartedEvent({ eventId: 'e4', seq: 4 }));
    await store.append(makeTokenUsageEvent({ eventId: 'e5', seq: 5 }));

    const events = await replayFrom(RUN, 2, store);

    assert.deepEqual(events.map((e) => e.seq), [3, 4, 5]);
    // Order preserved ascending
    assert.deepEqual(
      events.map((e) => e.eventId),
      ['e3', 'e4', 'e5'],
    );
  });

  it('replayFrom respects limit', async () => {
    await store.append(makeRunCreatedEvent({ eventId: 'e1', seq: 1 }));
    await store.append(makeRunStartedEvent({ eventId: 'e2', seq: 2 }));
    await store.append(makeTaskStartedEvent({ eventId: 'e3', seq: 3 }));
    await store.append(makeToolStartedEvent({ eventId: 'e4', seq: 4 }));
    await store.append(makeTokenUsageEvent({ eventId: 'e5', seq: 5 }));

    const limited = await replayFrom(RUN, 0, store, { limit: 2 });

    assert.equal(limited.length, 2);
    assert.deepEqual(limited.map((e) => e.seq), [1, 2]);

    const limitedAfter = await replayFrom(RUN, 2, store, { limit: 2 });
    assert.deepEqual(limitedAfter.map((e) => e.seq), [3, 4]);
  });

  it('replayFrom eventTypes filter returns only matching types', async () => {
    await store.append(makeRunCreatedEvent({ eventId: 'e1', seq: 1 }));
    await store.append(makeRunStartedEvent({ eventId: 'e2', seq: 2 }));
    await store.append(makeTaskStartedEvent({ eventId: 'e3', seq: 3 }));
    await store.append(makeToolStartedEvent({ eventId: 'e4', seq: 4 }));
    await store.append(makeTokenUsageEvent({ eventId: 'e5', seq: 5 }));

    const filtered = await replayFrom(RUN, 0, store, {
      eventTypes: ['task.started', 'token.usage'],
    });

    assert.equal(filtered.length, 2);
    assert.deepEqual(filtered.map((e) => e.type), ['task.started', 'token.usage']);
    // Seq order still ascending
    assert.deepEqual(filtered.map((e) => e.seq), [3, 5]);
  });

  it('replayFrom with no matching eventTypes returns []', async () => {
    await store.append(makeRunCreatedEvent({ eventId: 'e1', seq: 1 }));

    const filtered = await replayFrom(RUN, 0, store, {
      eventTypes: ['task.plan'],
    });

    assert.deepEqual(filtered, []);
  });

  it('replayFrom on empty run returns []', async () => {
    const events = await replayFrom(RUN, 0, store);
    assert.deepEqual(events, []);
  });

  it('replay with no opts behaves like full replay', async () => {
    await store.append(makeRunCreatedEvent({ eventId: 'e1', seq: 1 }));

    const events: AgentEvent[] = await replayFrom(RUN, 0, store, {});
    assert.deepEqual(events.map((e) => e.seq), [1]);
  });
});