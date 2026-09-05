/**
 * Aether 2.0 — EventBus Unit Tests
 *
 * Tests for createInMemoryEventBus() covering:
 * - emit delivers to subscriber in order
 * - unsubscribe stops delivery
 * - listEvents returns stored sorted
 * - listEventsAfter returns only >afterSeq
 * - two runIds isolated
 * - no subscriber error propagation when one throws
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createInMemoryEventBus } from './event-bus.js';
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

describe('EventBus - createInMemoryEventBus', () => {
  let bus: ReturnType<typeof createInMemoryEventBus>;

  beforeEach(() => {
    bus = createInMemoryEventBus();
  });

  it('emit delivers to subscriber in order', () => {
    const received: AgentEvent[] = [];
    const unsubscribe = bus.subscribe((e) => received.push(e));

    const e1 = makeRunCreatedEvent({ eventId: 'e1', seq: 1 });
    const e2 = makeRunStartedEvent({ eventId: 'e2', seq: 2 });
    const e3 = makeTaskStartedEvent({ eventId: 'e3', seq: 3 });

    bus.emit(e1);
    bus.emit(e2);
    bus.emit(e3);

    assert.deepEqual(received.map((e) => e.eventId), ['e1', 'e2', 'e3']);
    assert.deepEqual(received.map((e) => e.seq), [1, 2, 3]);

    unsubscribe();
  });

  it('unsubscribe stops delivery', () => {
    const received: AgentEvent[] = [];
    const unsubscribe = bus.subscribe((e) => received.push(e));

    bus.emit(makeRunCreatedEvent({ eventId: 'e1', seq: 1 }));
    unsubscribe();
    bus.emit(makeRunStartedEvent({ eventId: 'e2', seq: 2 }));

    assert.deepEqual(received.map((e) => e.eventId), ['e1']);
    assert.equal(received.length, 1);
  });

  it('listEvents returns stored events sorted by seq', () => {
    // Emit out of order to test sorting
    bus.emit(makeTaskStartedEvent({ eventId: 'e3', seq: 3 }));
    bus.emit(makeRunCreatedEvent({ eventId: 'e1', seq: 1 }));
    bus.emit(makeRunStartedEvent({ eventId: 'e2', seq: 2 }));

    const events = bus.listEvents('run-1');
    assert.equal(events.length, 3);
    assert.deepEqual(events.map((e) => e.seq), [1, 2, 3]);
    assert.deepEqual(events.map((e) => e.eventId), ['e1', 'e2', 'e3']);
  });

  it('listEvents returns empty array for unknown runId', () => {
    const events = bus.listEvents('unknown-run');
    assert.deepEqual(events, []);
  });

  it('listEventsAfter returns only events with seq > afterSeq', () => {
    bus.emit(makeRunCreatedEvent({ eventId: 'e1', seq: 1 }));
    bus.emit(makeRunStartedEvent({ eventId: 'e2', seq: 2 }));
    bus.emit(makeTaskStartedEvent({ eventId: 'e3', seq: 3 }));
    bus.emit(makeRunCreatedEvent({ eventId: 'e4', seq: 4 }));

    const after1 = bus.listEventsAfter('run-1', 1);
    assert.deepEqual(after1.map((e) => e.seq), [2, 3, 4]);

    const after2 = bus.listEventsAfter('run-1', 2);
    assert.deepEqual(after2.map((e) => e.seq), [3, 4]);

    const after4 = bus.listEventsAfter('run-1', 4);
    assert.deepEqual(after4, []);
  });

  it('listEventsAfter respects limit parameter', () => {
    bus.emit(makeRunCreatedEvent({ eventId: 'e1', seq: 1 }));
    bus.emit(makeRunStartedEvent({ eventId: 'e2', seq: 2 }));
    bus.emit(makeTaskStartedEvent({ eventId: 'e3', seq: 3 }));
    bus.emit(makeRunCreatedEvent({ eventId: 'e4', seq: 4 }));

    const limited = bus.listEventsAfter('run-1', 0, 2);
    assert.equal(limited.length, 2);
    assert.deepEqual(limited.map((e) => e.seq), [1, 2]);
  });

  it('listEventsAfter returns empty for unknown runId', () => {
    const events = bus.listEventsAfter('unknown-run', 0);
    assert.deepEqual(events, []);
  });

  it('two runIds are isolated - events do not leak across runs', () => {
    bus.emit(makeRunCreatedEvent({ eventId: 'e1', seq: 1, runId: 'run-A' }));
    bus.emit(makeRunStartedEvent({ eventId: 'e2', seq: 2, runId: 'run-A' }));
    bus.emit(makeRunCreatedEvent({ eventId: 'e3', seq: 1, runId: 'run-B' }));

    const runA = bus.listEvents('run-A');
    const runB = bus.listEvents('run-B');

    assert.equal(runA.length, 2);
    assert.deepEqual(runA.map((e) => e.eventId), ['e1', 'e2']);

    assert.equal(runB.length, 1);
    assert.deepEqual(runB.map((e) => e.eventId), ['e3']);

    // listEventsAfter also isolated
    const afterA = bus.listEventsAfter('run-A', 0);
    const afterB = bus.listEventsAfter('run-B', 0);
    assert.equal(afterA.length, 2);
    assert.equal(afterB.length, 1);
  });

  it('subscriber errors do not propagate - other subscribers still receive', () => {
    const received1: AgentEvent[] = [];
    const received2: AgentEvent[] = [];

    // Subscriber 1 throws
    bus.subscribe((e) => {
      received1.push(e);
      throw new Error('intentional test error');
    });

    // Subscriber 2 should still receive
    bus.subscribe((e) => {
      received2.push(e);
    });

    bus.emit(makeRunCreatedEvent({ eventId: 'e1', seq: 1 }));

    assert.equal(received1.length, 1);
    assert.equal(received2.length, 1);
    assert.deepEqual(received1[0].eventId, 'e1');
    assert.deepEqual(received2[0].eventId, 'e1');
  });

  it('multiple subscribers all receive events', () => {
    const received1: AgentEvent[] = [];
    const received2: AgentEvent[] = [];
    const received3: AgentEvent[] = [];

    bus.subscribe((e) => received1.push(e));
    bus.subscribe((e) => received2.push(e));
    bus.subscribe((e) => received3.push(e));

    bus.emit(makeRunCreatedEvent({ eventId: 'e1', seq: 1 }));
    bus.emit(makeRunStartedEvent({ eventId: 'e2', seq: 2 }));

    assert.deepEqual(received1.map((e) => e.eventId), ['e1', 'e2']);
    assert.deepEqual(received2.map((e) => e.eventId), ['e1', 'e2']);
    assert.deepEqual(received3.map((e) => e.eventId), ['e1', 'e2']);
  });

  it('emit with different event types works correctly', () => {
    const received: AgentEvent[] = [];
    bus.subscribe((e) => received.push(e));

    // Test various event types from the 37-type union
    bus.emit(makeRunCreatedEvent({ eventId: 'e1', seq: 1 }));
    bus.emit(makeRunCompletedEvent({ eventId: 'e2', seq: 2, payload: { endReason: 'completed', tokenUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } } }));
    bus.emit(makeAgentStartedEvent({ eventId: 'e3', seq: 3 }));
    bus.emit(makeToolStartedEvent({ eventId: 'e4', seq: 4 }));
    bus.emit(makeTokenUsageEvent({ eventId: 'e5', seq: 5 }));

    assert.equal(received.length, 5);
    assert.deepEqual(received.map((e) => e.type), [
      'run.created',
      'run.completed',
      'agent.started',
      'tool.started',
      'token.usage',
    ]);
  });
});