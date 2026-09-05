/**
 * ChunkPacker tests (P3-07)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  PACKABLE_EVENT_TYPES,
  PACK_MAX_CHUNKS,
  PACK_MAX_BYTES,
  isPackable,
  queuePack,
  shouldFlushPack,
  buildPackedPayload,
  unpackPackedPayload,
  packedRowSeq,
  type PackedChunk,
} from './chunk-packer.js';
import type { AgentEvent } from '@pacc/shared';

function makeDelta(seq: number, content: string, type: AgentEvent['type'] = 'agent.message.delta'): AgentEvent {
  return {
    eventId: `evt-${seq}`,
    sessionId: 'sess-1',
    runId: 'run-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    seq,
    type,
    version: 2,
    payload: { content },
  } as AgentEvent;
}

describe('core/events/chunk-packer', () => {
  it('isPackable only for delta types when persist=true', () => {
    assert.equal(isPackable('agent.message.delta', true), true);
    assert.equal(isPackable('agent.reasoning.delta', true), true);
    assert.equal(isPackable('agent.output.delta', true), true);
    assert.equal(isPackable('tool.completed', true), false);
    assert.equal(isPackable('agent.message.delta', false), false);
  });

  it('PACKABLE_EVENT_TYPES contains exactly the three delta types', () => {
    assert.equal(PACKABLE_EVENT_TYPES.size, 3);
    assert.ok(PACKABLE_EVENT_TYPES.has('agent.message.delta'));
    assert.ok(PACKABLE_EVENT_TYPES.has('agent.reasoning.delta'));
    assert.ok(PACKABLE_EVENT_TYPES.has('agent.output.delta'));
  });

  it('queuePack accumulates chunks preserving eventId/seq/type/content', () => {
    const pending = new Map<string, PackedChunk[]>();
    queuePack(pending, 'run-1', makeDelta(1, 'a'));
    queuePack(pending, 'run-1', makeDelta(2, 'b'));

    const chunks = pending.get('run-1')!;
    assert.equal(chunks.length, 2);
    assert.deepEqual(chunks.map((c) => c.seq), [1, 2]);
    assert.deepEqual(chunks.map((c) => c.eventId), ['evt-1', 'evt-2']);
    assert.deepEqual(chunks.map((c) => c.content), ['a', 'b']);
  });

  it('shouldFlushPack triggers at 96 chunks', () => {
    const chunks = Array.from({ length: 96 }, (_, i) => ({
      eventId: `e${i}`, seq: i + 1, type: 'agent.message.delta' as const, content: 'x', timestamp: 't',
    }));
    assert.equal(shouldFlushPack(chunks.slice(0, 95)), false);
    assert.equal(shouldFlushPack(chunks), true);
  });

  it('shouldFlushPack triggers at 24KB content', () => {
    const chunk: PackedChunk = { eventId: 'e', seq: 1, type: 'agent.message.delta', content: 'x'.repeat(4096), timestamp: 't' };
    // 6 chunks * 4KB = 24KB → flush at exactly PACK_MAX_BYTES
    const chunks = Array.from({ length: 6 }, (_, i) => ({ ...chunk, eventId: `e${i}`, seq: i + 1 }));
    assert.equal(shouldFlushPack(chunks.slice(0, 5)), false); // 20KB
    assert.equal(shouldFlushPack(chunks), true); // 24KB
    void PACK_MAX_BYTES;
  });

  it('buildPackedPayload / unpackPackedPayload round-trip preserves all sub-events', () => {
    const chunks: PackedChunk[] = [
      { eventId: 'e1', seq: 1, type: 'agent.message.delta', content: 'hello', timestamp: 't1' },
      { eventId: 'e2', seq: 2, type: 'agent.message.delta', content: ' world', timestamp: 't2' },
      { eventId: 'e3', seq: 3, type: 'agent.output.delta', content: 'final', timestamp: 't3' },
    ];
    const packed = buildPackedPayload(chunks);
    const unpacked = unpackPackedPayload(packed, 3);

    assert.equal(unpacked.length, 3);
    assert.deepEqual(unpacked.map((c) => c.seq), [1, 2, 3]);
    assert.deepEqual(unpacked.map((c) => c.eventId), ['e1', 'e2', 'e3']);
    assert.deepEqual(unpacked.map((c) => c.content), ['hello', ' world', 'final']);
    assert.equal(unpacked[2].type, 'agent.output.delta');
  });

  it('unpackPackedPayload returns [] for null / non-array payload', () => {
    assert.deepEqual(unpackPackedPayload(null, 5), []);
    assert.deepEqual(unpackPackedPayload(undefined, 5), []);
    assert.deepEqual(unpackPackedPayload('{"not":"an array"}', 5), []);
    assert.deepEqual(unpackPackedPayload('[1,2,3]', 5), []);
    assert.deepEqual(unpackPackedPayload('not json', 5), []);
  });

  it('packedRowSeq uses the last sub-event seq for ordering', () => {
    const chunks: PackedChunk[] = [
      { eventId: 'a', seq: 10, type: 'agent.message.delta', content: '', timestamp: 't' },
      { eventId: 'b', seq: 11, type: 'agent.message.delta', content: '', timestamp: 't' },
      { eventId: 'c', seq: 12, type: 'agent.message.delta', content: '', timestamp: 't' },
    ];
    assert.equal(packedRowSeq(chunks), 12);
    assert.equal(packedRowSeq([]), 0);
  });

  it('PACK_MAX_CHUNKS constant is 96 (legacy parity)', () => {
    assert.equal(PACK_MAX_CHUNKS, 96);
  });
});