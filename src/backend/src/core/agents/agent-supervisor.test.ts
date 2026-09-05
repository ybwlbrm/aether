/**
 * SupervisorAgent tests (P1-26)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { SupervisorAgent } from './agent-supervisor.js';
import { AgentRuntime } from './agent-runtime.js';
import { createAgentContext } from './agent-context.js';
import { DEFAULT_AGENT_LIMITS } from './agent-definition.js';
import type { AgentDefinition } from './agent-definition.js';
import { RuntimeError } from '../errors/index.js';

function definition(overrides: Partial<AgentDefinition> = {}): AgentDefinition {
  return {
    id: 'supervisor',
    name: 'Supervisor',
    type: 'supervisor',
    description: 'test supervisor',
    capabilities: ['orchestrate'],
    systemPrompt: 'supervise',
    modelPolicy: {},
    toolPolicy: {},
    memoryPolicy: { readScopes: ['user'], writeScopes: ['session'] },
    limits: DEFAULT_AGENT_LIMITS,
    ...overrides,
  };
}

function supervisorRuntime(maxConcurrentTasks = 4) {
  const def = definition();
  const context = createAgentContext({ runId: 'run-s', agentId: def.id, definition: def });
  return new SupervisorAgent(def, context, { maxConcurrentTasks });
}

/** A worker runtime whose runTask awaits a controllable gate. */
function gateWorker(name: string, gate: { promise: Promise<void>; release: () => void }, fail = false) {
  const def = definition({ id: name, name });
  const context = createAgentContext({ runId: 'run-w', agentId: name, definition: def });
  class Worker extends AgentRuntime {
    protected override async execute(input: Record<string, unknown>): Promise<unknown> {
      await gate.promise;
      if (fail) throw new Error('worker exploded');
      return { ok: true, input };
    }
  }
  return new Worker(def, context, name);
}

function makeGate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => { release = resolve; });
  return { promise, release };
}

describe('agent-supervisor', () => {
  it('createTask with registered worker runs to completed', async () => {
    const gate = makeGate();
    const supervisor = supervisorRuntime();
    await supervisor.start();
    const worker = gateWorker('w1', gate);
    supervisor.registerWorker('w1', worker);

    const taskId = await supervisor.createTask({ agentId: 'w1', task: { cmd: 'do' } });
    assert.equal(supervisor.taskStatus(taskId), 'running');

    gate.release();
    await supervisor.waitForAll();
    assert.equal(supervisor.taskStatus(taskId), 'completed');

    await supervisor.stop();
  });

  it('worker throwing marks the task failed', async () => {
    const gate = makeGate();
    const supervisor = supervisorRuntime();
    await supervisor.start();
    const worker = gateWorker('w1', gate, true);
    supervisor.registerWorker('w1', worker);

    const taskId = await supervisor.createTask({ agentId: 'w1', task: {} });
    gate.release();
    await supervisor.waitForAll();

    assert.equal(supervisor.taskStatus(taskId), 'failed');

    await supervisor.stop();
  });

  it('unregistered agentId leaves the task pending', async () => {
    const supervisor = supervisorRuntime();
    await supervisor.start();

    const taskId = await supervisor.createTask({ agentId: 'ghost', task: {} });
    assert.equal(supervisor.taskStatus(taskId), 'pending');

    await supervisor.stop();
  });

  it('capacity: second concurrent task exceeds maxConcurrentTasks=1', async () => {
    const gate = makeGate();
    const supervisor = supervisorRuntime(1);
    await supervisor.start();
    const worker = gateWorker('w1', gate);
    supervisor.registerWorker('w1', worker);

    await supervisor.createTask({ agentId: 'w1', task: { a: 1 } });

    await assert.rejects(
      supervisor.createTask({ agentId: 'w1', task: { a: 2 } }),
      (err: unknown) => err instanceof RuntimeError && err.code === 'SUPERVISOR_CAPACITY',
    );

    gate.release();
    await supervisor.waitForAll();
    await supervisor.stop();
  });

  it('capacity is released after a task completes', async () => {
    const gate = makeGate();
    const supervisor = supervisorRuntime(1);
    await supervisor.start();
    const worker = gateWorker('w1', gate);
    supervisor.registerWorker('w1', worker);

    const first = await supervisor.createTask({ agentId: 'w1', task: {} });
    gate.release();
    await supervisor.waitForAll();
    assert.equal(supervisor.taskStatus(first), 'completed');

    // Capacity freed — second task should now succeed
    const second = await supervisor.createTask({ agentId: 'w1', task: {} });
    await supervisor.waitForAll();
    assert.equal(supervisor.taskStatus(second), 'completed');

    await supervisor.stop();
  });

  it('waitForAll resolves once all tasks are terminal', async () => {
    const gate = makeGate();
    const supervisor = supervisorRuntime();
    await supervisor.start();
    const worker = gateWorker('w1', gate);
    supervisor.registerWorker('w1', worker);

    const t1 = await supervisor.createTask({ agentId: 'w1', task: {} });
    const t2 = await supervisor.createTask({ agentId: 'w1', task: {} });

    gate.release();
    await supervisor.waitForAll();

    assert.equal(supervisor.taskStatus(t1), 'completed');
    assert.equal(supervisor.taskStatus(t2), 'completed');

    await supervisor.stop();
  });

  it('taskStatus throws TASK_NOT_FOUND for unknown id', () => {
    const supervisor = supervisorRuntime();
    assert.throws(
      () => supervisor.taskStatus('nope'),
      (err: unknown) => err instanceof RuntimeError && err.code === 'TASK_NOT_FOUND',
    );
  });
});