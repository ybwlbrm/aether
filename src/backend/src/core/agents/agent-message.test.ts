/**
 * AgentMessage tests (P1-24)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentMessage, isAgentMessage } from './agent-message.js';
import type { AgentMessage } from './agent-message.js';

function base(input: Partial<AgentMessage> = {}): Omit<AgentMessage, 'id' | 'createdAt'> {
  return {
    runId: 'run-1',
    type: 'user',
    content: 'hello',
    ...input,
  };
}

describe('agent-message', () => {
  it('createAgentMessage fills id and createdAt', () => {
    const msg = createAgentMessage(base());
    assert.ok(typeof msg.id === 'string' && msg.id.length > 0);
    assert.ok(typeof msg.createdAt === 'string');
    assert.ok(!Number.isNaN(Date.parse(msg.createdAt)));
  });

  it('preserves supplied fields', () => {
    const msg = createAgentMessage(
      base({
        runId: 'run-42',
        taskId: 'task-7',
        fromAgentId: 'a1',
        toAgentId: 'a2',
        type: 'handoff',
        content: 'take over',
        parentMessageId: 'parent-1',
        metadata: { reason: 'x' },
      }),
    );
    assert.equal(msg.runId, 'run-42');
    assert.equal(msg.taskId, 'task-7');
    assert.equal(msg.fromAgentId, 'a1');
    assert.equal(msg.toAgentId, 'a2');
    assert.equal(msg.type, 'handoff');
    assert.equal(msg.content, 'take over');
    assert.equal(msg.parentMessageId, 'parent-1');
    assert.deepEqual(msg.metadata, { reason: 'x' });
  });

  it('all five message types are constructible', () => {
    for (const type of ['user', 'assistant', 'tool', 'system', 'handoff'] as const) {
      const msg = createAgentMessage(base({ type }));
      assert.equal(msg.type, type);
    }
  });

  it('isAgentMessage returns true for a valid message', () => {
    const msg = createAgentMessage(base());
    assert.equal(isAgentMessage(msg), true);
  });

  it('isAgentMessage returns false for invalid values', () => {
    assert.equal(isAgentMessage(null), false);
    assert.equal(isAgentMessage(undefined), false);
    assert.equal(isAgentMessage({}), false);
    assert.equal(isAgentMessage({ id: 'x' }), false);
    assert.equal(isAgentMessage({ id: 'x', runId: 'r', content: 'c', createdAt: 't' }), false);
  });
});