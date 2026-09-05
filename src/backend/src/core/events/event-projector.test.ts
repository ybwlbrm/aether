/**
 * Aether 2.0 — EventProjector Unit Tests
 *
 * Tests for Projector / ProjectorRegistry / project() covering:
 * - registered projector receives events in seq order
 * - multiple projectors all receive events
 * - unregister stops delivery
 * - register duplicate throws RuntimeError PROJECTOR_EXISTS
 * - get / list registry queries
 * - project with fromSeq skips earlier events
 * - projector throwing does not break other projectors
 * - project with no events does nothing
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryEventStore } from './event-store.js';
import { ProjectorRegistry, project } from './event-projector.js';
import type { Projector } from './event-projector.js';
import { RuntimeError } from '../errors/index.js';
import type {
  AgentEvent,
  RunEventPayload,
  RunCreatedEvent,
  RunStartedEvent,
  TaskStartedEvent,
  ToolStartedEvent,
} from '@pacc/shared';

const RUN = 'run-project-1';

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

/** Recording projector for assertions */
class RecordingProjector implements Projector {
  readonly received: AgentEvent[] = [];
  handle(event: AgentEvent): void {
    this.received.push(event);
  }
}

describe('EventProjector - registry', () => {
  let registry: ProjectorRegistry;

  beforeEach(() => {
    registry = new ProjectorRegistry();
  });

  it('get returns projector after register, undefined otherwise', () => {
    const projector = new RecordingProjector();
    registry.register('p1', projector);

    assert.equal(registry.get('p1'), projector);
    assert.equal(registry.get('missing'), undefined);
  });

  it('list returns registered ids in registration order', () => {
    registry.register('b', new RecordingProjector());
    registry.register('a', new RecordingProjector());
    registry.register('c', new RecordingProjector());

    assert.deepEqual(registry.list(), ['b', 'a', 'c']);
  });

  it('register duplicate throws RuntimeError with code PROJECTOR_EXISTS', () => {
    const projector = new RecordingProjector();
    registry.register('p1', projector);

    assert.throws(
      () => registry.register('p1', new RecordingProjector()),
      (err: unknown) => {
        assert.ok(err instanceof RuntimeError);
        assert.equal((err as RuntimeError).code, 'PROJECTOR_EXISTS');
        return true;
      },
    );

    // Original projector untouched
    assert.equal(registry.get('p1'), projector);
  });

  it('unregister removes a projector and reports success', () => {
    registry.register('p1', new RecordingProjector());

    assert.equal(registry.unregister('p1'), true);
    assert.equal(registry.get('p1'), undefined);
    assert.equal(registry.unregister('p1'), false, 'second unregister fails');
    assert.equal(registry.unregister('never-registered'), false);
  });
});

describe('EventProjector - project()', () => {
  let store: InMemoryEventStore;
  let registry: ProjectorRegistry;

  beforeEach(() => {
    store = new InMemoryEventStore();
    registry = new ProjectorRegistry();
  });

  it('registered projector receives events in seq order', async () => {
    await store.append(makeRunCreatedEvent({ eventId: 'e1', seq: 1 }));
    await store.append(makeRunStartedEvent({ eventId: 'e2', seq: 2 }));
    await store.append(makeTaskStartedEvent({ eventId: 'e3', seq: 3 }));
    await store.append(makeToolStartedEvent({ eventId: 'e4', seq: 4 }));

    const recorder = new RecordingProjector();
    registry.register('recorder', recorder);

    await project(store, RUN, registry);

    assert.deepEqual(
      recorder.received.map((e) => e.eventId),
      ['e1', 'e2', 'e3', 'e4'],
    );
    assert.deepEqual(recorder.received.map((e) => e.seq), [1, 2, 3, 4]);
  });

  it('multiple projectors all receive every event', async () => {
    await store.append(makeRunCreatedEvent({ eventId: 'e1', seq: 1 }));
    await store.append(makeTaskStartedEvent({ eventId: 'e2', seq: 2 }));

    const recorderA = new RecordingProjector();
    const recorderB = new RecordingProjector();
    registry.register('a', recorderA);
    registry.register('b', recorderB);

    await project(store, RUN, registry);

    assert.deepEqual(recorderA.received.map((e) => e.eventId), ['e1', 'e2']);
    assert.deepEqual(recorderB.received.map((e) => e.eventId), ['e1', 'e2']);
  });

  it('unregister stops delivery to that projector', async () => {
    await store.append(makeRunCreatedEvent({ eventId: 'e1', seq: 1 }));
    await store.append(makeTaskStartedEvent({ eventId: 'e2', seq: 2 }));

    const recorderA = new RecordingProjector();
    const recorderB = new RecordingProjector();
    registry.register('a', recorderA);
    registry.register('b', recorderB);

    assert.equal(registry.unregister('a'), true);

    await project(store, RUN, registry);

    assert.deepEqual(recorderA.received, [], 'unregistered projector gets nothing');
    assert.deepEqual(recorderB.received.map((e) => e.eventId), ['e1', 'e2']);
  });

  it('project with fromSeq skips earlier events', async () => {
    await store.append(makeRunCreatedEvent({ eventId: 'e1', seq: 1 }));
    await store.append(makeRunStartedEvent({ eventId: 'e2', seq: 2 }));
    await store.append(makeTaskStartedEvent({ eventId: 'e3', seq: 3 }));
    await store.append(makeToolStartedEvent({ eventId: 'e4', seq: 4 }));

    const recorder = new RecordingProjector();
    registry.register('recorder', recorder);

    await project(store, RUN, registry, { fromSeq: 2 });

    assert.deepEqual(
      recorder.received.map((e) => e.seq),
      [3, 4],
      'events with seq <= fromSeq are skipped',
    );
  });

  it('projector throwing does not break other projectors', async () => {
    await store.append(makeRunCreatedEvent({ eventId: 'e1', seq: 1 }));
    await store.append(makeRunStartedEvent({ eventId: 'e2', seq: 2 }));
    await store.append(makeTaskStartedEvent({ eventId: 'e3', seq: 3 }));
    await store.append(makeToolStartedEvent({ eventId: 'e4', seq: 4 }));

    // Throws on every event
    const throwingProjector: Projector = {
      handle(): void {
        throw new Error('boom');
      },
    };
    const recorder = new RecordingProjector();
    registry.register('throwing', throwingProjector);
    registry.register('recorder', recorder);

    // project() must not reject — errors isolated per projector
    await project(store, RUN, registry);

    assert.deepEqual(
      recorder.received.map((e) => e.eventId),
      ['e1', 'e2', 'e3', 'e4'],
      'healthy projector still receives all remaining events',
    );
  });

  it('project with no registered projectors succeeds without events', async () => {
    await store.append(makeRunCreatedEvent({ eventId: 'e1', seq: 1 }));

    await project(store, RUN, registry); // empty registry
  });

  it('project with no events does nothing', async () => {
    const recorder = new RecordingProjector();
    registry.register('recorder', recorder);

    await project(store, RUN, registry);

    assert.deepEqual(recorder.received, []);
  });
});