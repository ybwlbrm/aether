/**
 * Agent Runtime Tests
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { AgentRuntime } from './agent-runtime.js';
import type { AgentDefinition } from './agent-definition.js';
import { createAgentContext } from './agent-context.js';
import { DEFAULT_AGENT_LIMITS } from './agent-definition.js';
import { RuntimeError } from '../errors/index.js';

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

function createTestRuntime(definition?: AgentDefinition) {
  const def = definition ?? createTestDefinition();
  const context = createAgentContext({
    runId: 'run-123',
    agentId: def.id,
    definition: def,
    taskId: 'task-456',
  });
  return new AgentRuntime(def, context, 'test-runtime');
}

describe('agent-runtime', () => {
  let runtime: AgentRuntime;

  beforeEach(() => {
    runtime = createTestRuntime();
  });

  afterEach(async () => {
    if (runtime.isRunning) {
      await runtime.stop();
    }
  });

  describe('constructor', () => {
    it('should create runtime with definition and context', () => {
      assert.strictEqual(runtime.definition.id, 'test-agent');
      assert.strictEqual(runtime.context.agentId, 'test-agent');
      assert.strictEqual(runtime.name, 'test-runtime');
      assert.strictEqual(runtime.state, 'created');
    });

    it('should use agent id as name when name not provided', () => {
      const def = createTestDefinition({ id: 'custom-agent' });
      const context = createAgentContext({
        runId: 'run-123',
        agentId: def.id,
        definition: def,
      });
      const rt = new AgentRuntime(def, context);

      assert.strictEqual(rt.name, 'custom-agent');
    });
  });

  describe('start/stop lifecycle', () => {
    it('should start and emit agent.started', async () => {
      const events: Array<{ type: string; payload?: unknown }> = [];
      const unsubscribe = runtime.onEvent((e) => events.push({ type: e.type, payload: e.payload }));

      await runtime.start();

      assert.strictEqual(runtime.state, 'running');
      assert.strictEqual(runtime.isRunning, true);

      const startedEvent = events.find((e) => e.type === 'agent.started');
      assert.ok(startedEvent, 'agent.started event should be emitted');
      assert.deepStrictEqual(startedEvent?.payload, { status: 'running' });

      unsubscribe();
    });

    it('should emit agent.status running when executing a task after start', async () => {
      const events: Array<{ type: string; payload?: unknown }> = [];
      runtime.onEvent((e) => events.push({ type: e.type, payload: e.payload }));

      await runtime.start();
      await runtime.runTask({ test: 'data' });

      const statusEvent = events.find((e) => e.type === 'agent.status');
      assert.ok(statusEvent, 'agent.status event should be emitted during task execution');
      assert.deepStrictEqual(statusEvent?.payload, { status: 'running' });
    });

    it('should stop and emit agent.completed', async () => {
      await runtime.start();

      const events: Array<{ type: string; payload?: unknown }> = [];
      const unsubscribe = runtime.onEvent((e) => events.push({ type: e.type, payload: e.payload }));

      await runtime.stop();

      assert.strictEqual(runtime.state, 'stopped');
      assert.strictEqual(runtime.isRunning, false);

      const completedEvent = events.find((e) => e.type === 'agent.completed');
      assert.ok(completedEvent, 'agent.completed event should be emitted');
      assert.deepStrictEqual(completedEvent?.payload, { status: 'completed' });

      unsubscribe();
    });

    it('should throw on double start', async () => {
      await runtime.start();

      await assert.rejects(
        runtime.start(),
        (err: Error) => {
          assert.strictEqual(err.name, 'RuntimeError');
          assert.ok(err.message.includes('already started'));
          return true;
        }
      );
    });

    it('should throw on stop before start', async () => {
      await assert.rejects(
        runtime.stop(),
        (err: Error) => {
          assert.strictEqual(err.name, 'RuntimeError');
          assert.ok(err.message.includes('not running'));
          return true;
        }
      );
    });
  });

  describe('runTask', () => {
    it('should throw AGENT_NOT_STARTED when not running', async () => {
      await assert.rejects(
        runtime.runTask({ input: 'test' }),
        (err: Error) => {
          assert.strictEqual(err.name, 'RuntimeError');
          assert.ok(err.message.includes('not started') || err.message.includes('AGENT_NOT_STARTED'));
          return true;
        }
      );
    });

    it('should execute task and return result when running', async () => {
      await runtime.start();

      const result = await runtime.runTask({ key: 'value', number: 42 });

      assert.deepStrictEqual(result, { received: { key: 'value', number: 42 } });
    });

    it('should emit agent.status running before execution', async () => {
      await runtime.start();

      const events: Array<{ type: string; payload?: unknown }> = [];
      const unsubscribe = runtime.onEvent((e) => events.push({ type: e.type, payload: e.payload }));

      await runtime.runTask({ test: 'data' });

      const statusEvent = events.find((e) => e.type === 'agent.status' && e.payload && typeof e.payload === 'object' && 'status' in e.payload && e.payload.status === 'running');
      assert.ok(statusEvent, 'agent.status running should be emitted before execution');

      unsubscribe();
    });

    it('should emit agent.completed on successful execution', async () => {
      await runtime.start();

      const events: Array<{ type: string; payload?: unknown }> = [];
      const unsubscribe = runtime.onEvent((e) => events.push({ type: e.type, payload: e.payload }));

      await runtime.runTask({ test: 'data' });

      const completedEvent = events.find((e) => e.type === 'agent.completed');
      assert.ok(completedEvent, 'agent.completed should be emitted on success');
      assert.deepStrictEqual(completedEvent?.payload, { status: 'completed' });

      unsubscribe();
    });

    it('should emit agent.failed on execution error', async () => {
      // Create a runtime with a failing execute
      const def = createTestDefinition();
      const context = createAgentContext({
        runId: 'run-123',
        agentId: def.id,
        definition: def,
      });

      class FailingRuntime extends AgentRuntime {
        protected override async execute(): Promise<unknown> {
          throw new Error('Execution failed');
        }
      }

      const failingRuntime = new FailingRuntime(def, context, 'failing-runtime');
      await failingRuntime.start();

      const events: Array<{ type: string; payload?: unknown }> = [];
      const unsubscribe = failingRuntime.onEvent((e) => events.push({ type: e.type, payload: e.payload }));

      await assert.rejects(
        failingRuntime.runTask({ test: 'data' }),
        (err: Error) => {
          assert.strictEqual(err.message, 'Execution failed');
          return true;
        }
      );

      const failedEvent = events.find((e) => e.type === 'agent.failed');
      assert.ok(failedEvent, 'agent.failed should be emitted on error');
      assert.ok(failedEvent.payload);
      const payload = failedEvent.payload as { status: string; content: string; error: { message: string } };
      assert.strictEqual(payload.status, 'error');
      assert.strictEqual(payload.content, 'Execution failed');
      assert.strictEqual(payload.error.message, 'Execution failed');

      unsubscribe();
      await failingRuntime.stop();
    });
  });

  describe('sendDirective', () => {
    it('should deliver directive to context inbox', async () => {
      await runtime.start();

      runtime.sendDirective('Test directive');

      const inbox = runtime.context.drainInbox();
      assert.strictEqual(inbox.length, 1);
      assert.strictEqual(inbox[0].from, 'system');
      assert.strictEqual(inbox[0].content, 'Test directive');
      assert.strictEqual(inbox[0].type, 'directive');
    });

    it('should emit agent.inbox.directive event', async () => {
      await runtime.start();

      const events: Array<{ type: string; payload?: unknown }> = [];
      const unsubscribe = runtime.onEvent((e) => events.push({ type: e.type, payload: e.payload }));

      runtime.sendDirective('Test directive');

      const directiveEvent = events.find((e) => e.type === 'agent.inbox.directive');
      assert.ok(directiveEvent, 'agent.inbox.directive should be emitted');
      assert.deepStrictEqual(directiveEvent?.payload, { directive: 'Test directive' });

      unsubscribe();
    });

    it('should work before start (delivers to inbox)', () => {
      runtime.sendDirective('Pre-start directive');

      const inbox = runtime.context.drainInbox();
      assert.strictEqual(inbox.length, 1);
      assert.strictEqual(inbox[0].content, 'Pre-start directive');
    });
  });

  describe('event structure', () => {
    it('should emit events with proper BaseEvent fields via onEvent', async () => {
      const events: Array<{ type: string; payload?: unknown; eventId?: string; sessionId?: string; runId?: string; agentId?: string; timestamp?: string; seq?: number; version?: number }> = [];
      const unsubscribe = runtime.onEvent((e) => {
        const evt = e as unknown as Record<string, unknown>;
        events.push({
          type: e.type,
          payload: e.payload,
          eventId: evt.eventId as string,
          sessionId: evt.sessionId as string,
          runId: evt.runId as string,
          agentId: evt.agentId as string,
          timestamp: evt.timestamp as string,
          seq: evt.seq as number,
          version: evt.version as number,
        });
      });

      await runtime.start();

      await runtime.runTask({ test: 'data' });

      const startedEvent = events.find((e) => e.type === 'agent.started');
      assert.ok(startedEvent);
      assert.ok(startedEvent.eventId);
      assert.strictEqual(startedEvent.sessionId, 'run-123');
      assert.strictEqual(startedEvent.runId, 'run-123');
      assert.strictEqual(startedEvent.agentId, 'test-agent');
      assert.ok(startedEvent.timestamp);
      assert.strictEqual(startedEvent.seq, 0);
      assert.strictEqual(startedEvent.version, 2);

      unsubscribe();
    });

    it('should increment seq for each event', async () => {
      const seqs: number[] = [];
      const unsubscribe = runtime.onEvent((e) => {
        const evt = e as unknown as Record<string, unknown>;
        const seq = evt.seq as number;
        if (typeof seq === 'number') seqs.push(seq);
      });

      await runtime.start();

      await runtime.runTask({ test: 'data' });

      // Should have at least: agent.started, agent.status, agent.completed
      assert.ok(seqs.length >= 3);
      // Check seq is monotonically increasing
      for (let i = 1; i < seqs.length; i++) {
        assert.ok(seqs[i] > seqs[i - 1], `seq should increase: ${seqs[i - 1]} -> ${seqs[i]}`);
      }

      unsubscribe();
    });
  });
});