/**
 * ToolRuntime unit tests.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { ToolRuntime, createToolContext, ToolContext } from './tool-runtime.js';
import { ToolPolicy } from './tool-policy.js';
import type { CapabilitySet } from '../permissions/index.js';

describe('tool-runtime', () => {
  describe('createToolContext', () => {
    test('creates context with required fields', () => {
      const policy = new ToolPolicy();
      const context = createToolContext({
        runId: 'run-123',
        policy,
      });

      assert.equal(context.runId, 'run-123');
      assert.equal(context.taskId, undefined);
      assert.equal(context.agentId, undefined);
      assert.equal(context.workspaceId, undefined);
      assert.ok(context.permissions instanceof Set);
      assert.equal(context.policy, policy);
      assert.equal(context.abortSignal, undefined);
      assert.equal(context.logger, undefined);
      assert.equal(context.memory, undefined);
      assert.equal(context.artifacts, undefined);
    });

    test('creates context with all optional fields', () => {
      const policy = new ToolPolicy();
      const caps = new Set(['filesystem.read']) as CapabilitySet;
      const abortController = new AbortController();
      const logger = {
        info: () => {},
        warn: () => {},
        error: () => {},
      };
      const memory = {
        remember: async () => {},
        recall: async () => [],
      };
      const artifacts = {
        create: async () => ({ id: 'artifact-1' }),
      };

      const context = createToolContext({
        runId: 'run-123',
        taskId: 'task-456',
        agentId: 'agent-789',
        workspaceId: 'ws-101',
        policy,
        permissions: caps,
        abortSignal: abortController.signal,
        logger,
        memory,
        artifacts,
      });

      assert.equal(context.runId, 'run-123');
      assert.equal(context.taskId, 'task-456');
      assert.equal(context.agentId, 'agent-789');
      assert.equal(context.workspaceId, 'ws-101');
      assert.equal(context.permissions, caps);
      assert.equal(context.abortSignal, abortController.signal);
      assert.equal(context.logger, logger);
      assert.equal(context.memory, memory);
      assert.equal(context.artifacts, artifacts);
    });

    test('default permissions is empty set when not provided', () => {
      const policy = new ToolPolicy();
      const context = createToolContext({ runId: 'run-1', policy });

      assert.ok(context.permissions instanceof Set);
      assert.equal(context.permissions.size, 0);
    });
  });

  describe('ToolRuntime', () => {
    test('extends Runtime', () => {
      const runtime = new ToolRuntime('test-runtime', 'session-1', 'run-1', 'agent-1');

      assert.ok(runtime instanceof ToolRuntime);
      // Runtime is the parent class
      assert.equal(typeof runtime.start, 'function');
      assert.equal(typeof runtime.stop, 'function');
      assert.equal(typeof runtime.onEvent, 'function');
      // Public tool emission API (emit itself is protected in the base class)
      assert.equal(typeof runtime.emitToolCompleted, 'function');
      assert.equal(typeof runtime.emitToolError, 'function');
      assert.equal(typeof runtime.emitToolStarted, 'function');
    });

    test('initial state is created', () => {
      const runtime = new ToolRuntime('test', 'session-1', 'run-1');

      assert.equal(runtime.state, 'created');
      assert.equal(runtime.isRunning, false);
    });

    test('emitToolCompleted emits v2-format event', () => {
      const runtime = new ToolRuntime('test', 'session-1', 'run-1', 'agent-1');
      let emittedEvent: unknown;

      runtime.onEvent((event) => {
        emittedEvent = event;
      });

      runtime.emitToolCompleted({
        toolName: 'test-tool',
        toolInput: 'input',
        toolOutput: 'output',
        status: 'completed',
      });

      assert.ok(emittedEvent);
      const event = emittedEvent as Record<string, unknown>;
      assert.equal(event.type, 'tool.completed');
      assert.equal(event.runtimeName, 'test');
      assert.ok(typeof event.timestamp === 'number');

      const payload = event.payload as Record<string, unknown>;
      assert.equal(payload.toolName, 'test-tool');
      assert.equal(payload.toolInput, 'input');
      assert.equal(payload.toolOutput, 'output');
      assert.equal(payload.status, 'completed');
      assert.ok(typeof payload.eventId === 'string');
      assert.equal(payload.sessionId, 'session-1');
      assert.equal(payload.runId, 'run-1');
      assert.equal(payload.agentId, 'agent-1');
      assert.ok(typeof payload.timestamp === 'string');
      assert.ok(typeof payload.seq === 'number');
      assert.equal(payload.version, 2);
    });

    test('emitToolError emits v2-format event', () => {
      const runtime = new ToolRuntime('test', 'session-1', 'run-1', 'agent-1');
      let emittedEvent: unknown;

      runtime.onEvent((event) => {
        emittedEvent = event;
      });

      runtime.emitToolError({
        toolName: 'test-tool',
        toolInput: 'input',
        status: 'error',
        error: { message: 'Something failed', code: 'TOOL_ERROR' },
      });

      assert.ok(emittedEvent);
      const event = emittedEvent as Record<string, unknown>;
      assert.equal(event.type, 'tool.error');

      const payload = event.payload as Record<string, unknown>;
      assert.equal(payload.toolName, 'test-tool');
      assert.equal(payload.status, 'error');
      assert.deepEqual(payload.error, { message: 'Something failed', code: 'TOOL_ERROR' });
      assert.equal(payload.version, 2);
    });

    test('emitToolStarted emits v2-format event', () => {
      const runtime = new ToolRuntime('test', 'session-1', 'run-1', 'agent-1');
      let emittedEvent: unknown;

      runtime.onEvent((event) => {
        emittedEvent = event;
      });

      runtime.emitToolStarted({
        toolName: 'test-tool',
        toolInput: 'input',
        status: 'started',
      });

      assert.ok(emittedEvent);
      const event = emittedEvent as Record<string, unknown>;
      assert.equal(event.type, 'tool.started');

      const payload = event.payload as Record<string, unknown>;
      assert.equal(payload.status, 'started');
      assert.equal(payload.version, 2);
    });

    test('emitToolProgress emits v2-format event', () => {
      const runtime = new ToolRuntime('test', 'session-1', 'run-1', 'agent-1');
      let emittedEvent: unknown;

      runtime.onEvent((event) => {
        emittedEvent = event;
      });

      runtime.emitToolProgress({
        toolName: 'test-tool',
        toolInput: 'input',
        status: 'running',
      });

      assert.ok(emittedEvent);
      const event = emittedEvent as Record<string, unknown>;
      assert.equal(event.type, 'tool.progress');

      const payload = event.payload as Record<string, unknown>;
      assert.equal(payload.status, 'running');
      assert.equal(payload.version, 2);
    });

    test('emitToolRetry emits v2-format event', () => {
      const runtime = new ToolRuntime('test', 'session-1', 'run-1', 'agent-1');
      let emittedEvent: unknown;

      runtime.onEvent((event) => {
        emittedEvent = event;
      });

      runtime.emitToolRetry({
        toolName: 'test-tool',
        toolInput: 'input',
        status: 'retry',
      });

      assert.ok(emittedEvent);
      const event = emittedEvent as Record<string, unknown>;
      assert.equal(event.type, 'tool.retry');

      const payload = event.payload as Record<string, unknown>;
      assert.equal(payload.status, 'retry');
      assert.equal(payload.version, 2);
    });

    test('sequence numbers increment', () => {
      const runtime = new ToolRuntime('test', 'session-1', 'run-1', 'agent-1');
      const events: unknown[] = [];

      runtime.onEvent((event) => {
        events.push(event);
      });

      runtime.emitToolStarted({ toolName: 't', toolInput: 'i', status: 'started' });
      runtime.emitToolProgress({ toolName: 't', toolInput: 'i', status: 'running' });
      runtime.emitToolCompleted({ toolName: 't', toolInput: 'i', toolOutput: 'o', status: 'completed' });

      assert.equal(events.length, 3);
      const seqs = events.map((e) => (e as Record<string, unknown>).payload).map((p) => (p as Record<string, unknown>).seq);
      assert.equal(seqs[0], 1);
      assert.equal(seqs[1], 2);
      assert.equal(seqs[2], 3);
    });

    test('start and stop work', async () => {
      const runtime = new ToolRuntime('test', 'session-1', 'run-1');

      await runtime.start();
      assert.equal(runtime.state, 'running');
      assert.equal(runtime.isRunning, true);

      await runtime.stop();
      assert.equal(runtime.state, 'stopped');
      assert.equal(runtime.isRunning, false);
    });
  });
});