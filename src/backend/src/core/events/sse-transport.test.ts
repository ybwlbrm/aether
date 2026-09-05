/**
 * SseTransport tests (P3-05)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SseTransport, InMemorySseTransport, formatSseEvent } from './sse-transport.js';
import type { AgentEvent } from '@pacc/shared';

function makeEvent(seq: number, type: AgentEvent['type'] = 'run.started'): AgentEvent {
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

describe('core/events/sse-transport', () => {
  it('formatSseEvent produces valid SSE frame with event/data/id', () => {
    const event = makeEvent(7, 'task.started');
    const frame = formatSseEvent(event);

    assert.ok(frame.startsWith('event: task.started\n'), 'frame starts with event type line');
    assert.ok(frame.includes('\ndata: '), 'frame contains data line');
    assert.ok(frame.includes('\nid: 7\n\n'), 'frame contains id: seq line and blank-line terminator');

    // data payload is valid JSON of the event
    const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
    assert.ok(dataLine, 'data line present');
    const payload = JSON.parse(dataLine!.slice(6));
    assert.equal(payload.eventId, 'evt-7');
    assert.equal(payload.type, 'task.started');
    assert.equal(payload.version, 2);
  });

  it('SseTransport.send writes formatted frame to the target', () => {
    const written: string[] = [];
    const transport = new SseTransport({
      write: (chunk: string | Uint8Array) => {
        written.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk));
        return true;
      },
    });

    transport.send(makeEvent(1));
    transport.send(makeEvent(2));

    assert.equal(written.length, 2);
    assert.ok(written[0].includes('event: run.started'));
    assert.ok(written[0].includes('id: 1'));
    assert.ok(written[1].includes('id: 2'));
  });

  it('close() calls target.end() and is idempotent', () => {
    let endCalls = 0;
    const transport = new SseTransport({
      write: () => true,
      end: () => { endCalls += 1; },
    });

    transport.close();
    transport.close();

    assert.equal(endCalls, 1, 'end() called exactly once');
    assert.equal(transport.isClosed, true);
  });

  it('send() after close is a no-op', () => {
    const written: string[] = [];
    const transport = new SseTransport({ write: (c) => { written.push(String(c)); return true; } });
    transport.close();
    transport.send(makeEvent(1));
    assert.equal(written.length, 0);
  });

  it('send() tolerates a throwing target (marks closed, no throw)', () => {
    const transport = new SseTransport({ write: () => { throw new Error('broken pipe'); } });
    transport.send(makeEvent(1));
    assert.equal(transport.isClosed, true);
  });

  it('InMemorySseTransport records both raw events and frames', () => {
    const transport = new InMemorySseTransport();
    transport.send(makeEvent(3, 'agent.started'));
    transport.send(makeEvent(4, 'tool.completed'));

    assert.equal(transport.events().length, 2);
    assert.equal(transport.events()[0].type, 'agent.started');
    assert.equal(transport.framesList().length, 2);
    assert.ok(transport.framesList()[1].includes('event: tool.completed'));
  });
});