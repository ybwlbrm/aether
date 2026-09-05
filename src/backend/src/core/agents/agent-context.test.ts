/**
 * Agent Context Tests
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAgentContext, type AgentContext, type InboxMessage, type HandoffRecord } from './agent-context.js';
import type { AgentDefinition } from './agent-definition.js';
import { DEFAULT_AGENT_LIMITS } from './agent-definition.js';

function createTestDefinition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: 'test-agent',
    name: 'Test Agent',
    type: 'conversation',
    description: 'A test agent',
    capabilities: ['chat'],
    systemPrompt: 'You are a helpful assistant.',
    modelPolicy: {},
    toolPolicy: {},
    memoryPolicy: {
      readScopes: ['user'],
      writeScopes: ['session'],
    },
    limits: DEFAULT_AGENT_LIMITS,
    ...overrides,
  };
}

describe('agent-context', () => {
  describe('createAgentContext', () => {
    it('should create context with all required fields', () => {
      const def = createTestDefinition();
      const context = createAgentContext({
        runId: 'run-123',
        agentId: 'test-agent',
        definition: def,
        taskId: 'task-456',
      });

      assert.strictEqual(context.runId, 'run-123');
      assert.strictEqual(context.taskId, 'task-456');
      assert.strictEqual(context.agentId, 'test-agent');
      assert.strictEqual(context.definition, def);
      assert.ok(context.signal instanceof AbortSignal);
      assert.ok(context.store instanceof Map);
      assert.ok(typeof context.get === 'function');
      assert.ok(typeof context.set === 'function');
      assert.ok(Array.isArray(context.inbox));
      assert.strictEqual(context.inbox.length, 0);
      assert.ok(typeof context.deliver === 'function');
      assert.ok(typeof context.drainInbox === 'function');
      assert.ok(typeof context.handoff === 'function');
      assert.ok(typeof context.getLastHandoff === 'function');
    });

    it('should work without optional taskId', () => {
      const def = createTestDefinition();
      const context = createAgentContext({
        runId: 'run-123',
        agentId: 'test-agent',
        definition: def,
      });

      assert.strictEqual(context.runId, 'run-123');
      assert.strictEqual(context.taskId, undefined);
    });
  });

  describe('deliver and drainInbox', () => {
    it('should deliver messages to inbox', () => {
      const def = createTestDefinition();
      const context = createAgentContext({
        runId: 'run-123',
        agentId: 'test-agent',
        definition: def,
      });

      context.deliver({ from: 'user', content: 'Hello', type: 'message' });
      context.deliver({ from: 'system', content: 'Directive', type: 'directive' });

      assert.strictEqual(context.inbox.length, 2);
      assert.strictEqual(context.inbox[0].from, 'user');
      assert.strictEqual(context.inbox[0].content, 'Hello');
      assert.strictEqual(context.inbox[0].type, 'message');
      assert.ok(context.inbox[0].id);
      assert.ok(context.inbox[0].timestamp);
      assert.strictEqual(context.inbox[1].from, 'system');
      assert.strictEqual(context.inbox[1].type, 'directive');
    });

    it('should default type to "message" when not provided', () => {
      const def = createTestDefinition();
      const context = createAgentContext({
        runId: 'run-123',
        agentId: 'test-agent',
        definition: def,
      });

      context.deliver({ from: 'user', content: 'Hello' });

      assert.strictEqual(context.inbox[0].type, 'message');
    });

    it('should drain inbox and return all messages', () => {
      const def = createTestDefinition();
      const context = createAgentContext({
        runId: 'run-123',
        agentId: 'test-agent',
        definition: def,
      });

      context.deliver({ from: 'user', content: 'Message 1' });
      context.deliver({ from: 'user', content: 'Message 2' });

      const drained = context.drainInbox();

      assert.strictEqual(drained.length, 2);
      assert.strictEqual(drained[0].content, 'Message 1');
      assert.strictEqual(drained[1].content, 'Message 2');
      assert.strictEqual(context.inbox.length, 0);
    });

    it('should return empty array when draining empty inbox', () => {
      const def = createTestDefinition();
      const context = createAgentContext({
        runId: 'run-123',
        agentId: 'test-agent',
        definition: def,
      });

      const drained = context.drainInbox();

      assert.deepStrictEqual(drained, []);
    });

    it('should allow multiple drain cycles', () => {
      const def = createTestDefinition();
      const context = createAgentContext({
        runId: 'run-123',
        agentId: 'test-agent',
        definition: def,
      });

      context.deliver({ from: 'user', content: 'Batch 1' });
      const first = context.drainInbox();
      assert.strictEqual(first.length, 1);

      context.deliver({ from: 'user', content: 'Batch 2' });
      const second = context.drainInbox();
      assert.strictEqual(second.length, 1);
      assert.strictEqual(second[0].content, 'Batch 2');
    });
  });

  describe('handoff and getLastHandoff', () => {
    it('should record handoff and return it via getLastHandoff', () => {
      const def = createTestDefinition();
      const context = createAgentContext({
        runId: 'run-123',
        agentId: 'test-agent',
        definition: def,
      });

      context.handoff('target-agent', 'Need specialized help');

      const handoff = context.getLastHandoff();

      assert.ok(handoff);
      assert.strictEqual(handoff?.targetAgentId, 'target-agent');
      assert.strictEqual(handoff?.reason, 'Need specialized help');
      assert.ok(handoff?.timestamp);
    });

    it('should return undefined when no handoff recorded', () => {
      const def = createTestDefinition();
      const context = createAgentContext({
        runId: 'run-123',
        agentId: 'test-agent',
        definition: def,
      });

      const handoff = context.getLastHandoff();

      assert.strictEqual(handoff, undefined);
    });

    it('should overwrite previous handoff', () => {
      const def = createTestDefinition();
      const context = createAgentContext({
        runId: 'run-123',
        agentId: 'test-agent',
        definition: def,
      });

      context.handoff('agent-1', 'First handoff');
      context.handoff('agent-2', 'Second handoff');

      const handoff = context.getLastHandoff();

      assert.strictEqual(handoff?.targetAgentId, 'agent-2');
      assert.strictEqual(handoff?.reason, 'Second handoff');
    });

    it('should not throw on handoff', () => {
      const def = createTestDefinition();
      const context = createAgentContext({
        runId: 'run-123',
        agentId: 'test-agent',
        definition: def,
      });

      assert.doesNotThrow(() => {
        context.handoff('target-agent', 'Reason');
      });
    });
  });

  describe('RuntimeContext integration', () => {
    it('should support get/set on store', () => {
      const def = createTestDefinition();
      const context = createAgentContext({
        runId: 'run-123',
        agentId: 'test-agent',
        definition: def,
      });

      context.set('key1', 'value1');
      context.set('key2', 42);

      assert.strictEqual(context.get<string>('key1'), 'value1');
      assert.strictEqual(context.get<number>('key2'), 42);
      assert.strictEqual(context.get('nonexistent'), undefined);
    });

    it('should have abort signal linked to controller', () => {
      const def = createTestDefinition();
      const context = createAgentContext({
        runId: 'run-123',
        agentId: 'test-agent',
        definition: def,
      });

      assert.strictEqual(context.signal.aborted, false);
      // @ts-expect-error - abort is added via Object.defineProperty
      context.abort('test reason');
      assert.strictEqual(context.signal.aborted, true);
      assert.strictEqual(context.signal.reason, 'test reason');
    });
  });
});