/**
 * replayStream tests (P3-04 streaming replay)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { replayStream } from './event-replay.js';
import { InMemoryEventStore } from './event-store.js';
import type { AgentEvent } from '@pacc/shared';

function makeEvent(seq: number, type: AgentEvent['type'] = 'run.created'): AgentEvent {
  return {
    eventId: `evt-${seq}`,
    sessionId: 'sess-1',
    runId: 'run-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    seq,
    type,
    version: 2,
    payload: {},
  } as AgentEvent;
}

async function collect(stream: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const e of stream) out.push(e);
  return out;
}

describe('core/events/replay-stream', () => {
  it('yields all events in seq order', async () => {
    const store = new InMemoryEventStore();
    // append out of order to verify store ordering is respected
    await store.append(makeEvent(2));
    await store.append(makeEvent(1));
    await store.append(makeEvent(3));

    const events = await collect(replayStream('run-1', store));
    assert.deepEqual(events.map((e) => e.seq), [1, 2, 3]);
  });

  it('yields nothing for an empty run', async () => {
    const store = new InMemoryEventStore();
    const events = await collect(replayStream('run-missing', store));
    assert.deepEqual(events, []);
  });

  it('eventTypes filter only yields matching types', async () => {
    const store = new InMemoryEventStore();
    await store.append(makeEvent(1, 'run.created'));
    await store.append(makeEvent(2, 'task.started'));
    await store.append(makeEvent(3, 'agent.message.delta'));
    await store.append(makeEvent(4, 'tool.completed'));

    const events = await collect(replayStream('run-1', store, { eventTypes: ['task.started', 'tool.completed'] }));
    assert.deepEqual(events.map((e) => e.seq), [2, 4]);
    assert.deepEqual(events.map((e) => e.type), ['task.started', 'tool.completed']);
  });

  it('handles large runs (1000+ events) without loss', async () => {
    const store = new InMemoryEventStore();
    for (let i = 1; i <= 1200; i++) {
      await store.append(makeEvent(i, i % 2 === 0 ? 'agent.message.delta' : 'run.created'));
    }

    const events = await collect(replayStream('run-1', store));
    assert.equal(events.length, 1200);
    assert.equal(events[0].seq, 1);
    assert.equal(events[1199].seq, 1200);
    // monotonic
    for (let i = 1; i < events.length; i++) {
      assert.ok(events[i].seq > events[i - 1].seq);
    }
  });

  it('constant memory: processes event by event (generator laziness)', async () => {
    const store = new InMemoryEventStore();
    for (let i = 1; i <= 100; i++) await store.append(makeEvent(i));

    const stream = replayStream('run-1', store);
    const first = await stream.next();
    assert.ok(!first.done, 'first event available');
    assert.equal((first.value as AgentEvent).seq, 1);
    await stream.return(undefined);
  });
});