/**
 * Task State Machine Tests
 *
 * Tests for the core/runtime task module (P1-06).
 * Run with: npm run test -w src/backend (after build)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Import types from source for compile-time checking
import type { TaskStatus, TaskEntity } from './task.js';
// Import runtime values from built dist
const { TaskStateMachine, setChild, canStart } = await import('./index.js');
const { RuntimeError } = await import('../errors/index.js');

function createMachine() {
  return new TaskStateMachine();
}

describe('core/runtime/task', () => {
  describe('TaskStatus type', () => {
    it('includes all 6 expected statuses', () => {
      const statuses: TaskStatus[] = [
        'pending',
        'running',
        'waiting',
        'completed',
        'failed',
        'cancelled',
      ];
      assert.equal(statuses.length, 6);
    });
  });

  describe('TaskStateMachine', () => {
    it('initial status is pending', () => {
      const machine = createMachine();
      assert.equal(machine.status, 'pending');
      assert.equal(machine.isTerminal, false);
      assert.equal(machine.hasStarted, false);
      assert.equal(machine.startedAt, undefined);
      assert.equal(machine.completedAt, undefined);
      assert.equal(machine.error, undefined);
    });

    it('valid path: pending -> running -> completed', () => {
      const machine = createMachine();
      // pending -> running
      machine.transition('running');
      assert.equal(machine.status, 'running');
      assert.ok(machine.hasStarted);
      assert.ok(machine.startedAt !== undefined);
      const firstStartedAt = machine.startedAt;

      // running -> completed
      machine.transition('completed');
      assert.equal(machine.status, 'completed');
      assert.equal(machine.isTerminal, true);
      assert.ok(machine.completedAt !== undefined);
      assert.equal(machine.startedAt, firstStartedAt);
    });

    it('invalid transition completed -> pending throws RuntimeError INVALID_TASK_TRANSITION', () => {
      const machine = createMachine();
      machine.transition('running');
      machine.transition('completed');

      assert.throws(
        () => machine.transition('pending'),
        (err: Error) => {
          assert.ok(err instanceof RuntimeError);
          assert.equal(err.code, 'INVALID_TASK_TRANSITION');
          assert.equal(err.retryable, false);
          assert.ok(err.context);
          assert.equal(err.context?.currentState, 'completed');
          assert.equal(err.context?.attemptedState, 'pending');
          return true;
        },
        'Expected RuntimeError on invalid transition completed->pending'
      );
    });

    it('waiting round-trip: running -> waiting -> running', () => {
      const machine = createMachine();
      machine.transition('running');
      machine.transition('waiting');
      assert.equal(machine.status, 'waiting');

      machine.transition('running');
      assert.equal(machine.status, 'running');
    });

    it('cancelled from waiting works', () => {
      const machine = createMachine();
      machine.transition('running');
      machine.transition('waiting');
      machine.transition('cancelled');

      assert.equal(machine.status, 'cancelled');
      assert.equal(machine.isTerminal, true);
      assert.ok(machine.completedAt !== undefined);
    });

    it('failed from running works with error message', () => {
      const machine = createMachine();
      machine.transition('running');
      machine.transition('failed', 'Model rate limit exceeded');

      assert.equal(machine.status, 'failed');
      assert.equal(machine.isTerminal, true);
      assert.equal(machine.error, 'Model rate limit exceeded');
      assert.ok(machine.completedAt !== undefined);
    });

    it('failed without error message sets error to undefined', () => {
      const machine = createMachine();
      machine.transition('running');
      machine.transition('failed');

      assert.equal(machine.status, 'failed');
      assert.equal(machine.error, undefined);
    });

    it('startedAt set on first running transition', () => {
      const machine = createMachine();
      assert.equal(machine.startedAt, undefined);
      machine.transition('running');
      assert.ok(machine.startedAt !== undefined);
      const firstStartedAt = machine.startedAt;

      machine.transition('waiting');
      machine.transition('running');
      assert.equal(machine.startedAt, firstStartedAt);
    });

    it('completedAt set on terminal transition', () => {
      const machine = createMachine();
      machine.transition('running');
      machine.transition('completed');

      assert.ok(machine.completedAt !== undefined);
    });

    it('toEntity creates TaskEntity with current state', () => {
      const machine = createMachine();
      machine.transition('running');
      machine.transition('completed');

      const entity = machine.toEntity({
        id: 'task-123',
        runId: 'run-456',
        parentTaskId: 'parent-789',
        agentId: 'agent-1',
        agentType: 'conversation',
        input: { prompt: 'Hello' },
        output: { response: 'Hi there' },
        metadata: { key: 'value' },
        createdAt: '2024-01-01T00:00:00.000Z',
      });

      assert.equal(entity.id, 'task-123');
      assert.equal(entity.runId, 'run-456');
      assert.equal(entity.parentTaskId, 'parent-789');
      assert.equal(entity.agentId, 'agent-1');
      assert.equal(entity.agentType, 'conversation');
      assert.equal(entity.input?.prompt, 'Hello');
      assert.equal(entity.output?.response, 'Hi there');
      assert.equal(entity.metadata?.key, 'value');
      assert.equal(entity.createdAt, '2024-01-01T00:00:00.000Z');
      assert.equal(entity.status, 'completed');
      assert.ok(entity.startedAt !== undefined);
      assert.ok(entity.completedAt !== undefined);
      assert.equal(entity.error, undefined);
    });

    it('reset returns to initial state', () => {
      const machine = createMachine();
      machine.transition('running');
      machine.transition('completed');
      machine.reset();

      assert.equal(machine.status, 'pending');
      assert.equal(machine.isTerminal, false);
      assert.equal(machine.hasStarted, false);
      assert.equal(machine.startedAt, undefined);
      assert.equal(machine.completedAt, undefined);
      assert.equal(machine.error, undefined);
    });

    it('all terminal states are absorbing (no outgoing transitions)', () => {
      const terminalStatuses: TaskStatus[] = ['completed', 'failed', 'cancelled'];

      for (const terminal of terminalStatuses) {
        const m = createMachine();
        m.transition('running');
        m.transition(terminal);

        // Try all possible transitions from terminal state
        for (const next of ['pending', 'running', 'waiting', 'completed', 'failed', 'cancelled'] as TaskStatus[]) {
          if (next === terminal) continue;
          assert.throws(
            () => m.transition(next),
            (err: Error) => {
              assert.ok(err instanceof RuntimeError);
              assert.equal(err.code, 'INVALID_TASK_TRANSITION');
              return true;
            },
            `Expected error from ${terminal} -> ${next}`
          );
        }
      }
    });

    it('pending -> waiting throws (must go through running)', () => {
      const machine = createMachine();
      assert.throws(
        () => machine.transition('waiting'),
        (err: Error) => {
          assert.ok(err instanceof RuntimeError);
          assert.equal(err.code, 'INVALID_TASK_TRANSITION');
          return true;
        },
        'Expected error from pending -> waiting'
      );
    });
  });

  describe('setChild parent-child linking', () => {
    const parent: TaskEntity = {
      id: 'parent-1',
      runId: 'run-1',
      agentId: 'agent-1',
      agentType: 'conversation',
      status: 'running',
      createdAt: '2024-01-01T00:00:00.000Z',
    };

    it('valid parent-child linking succeeds', () => {
      const child: TaskEntity = {
        id: 'child-1',
        runId: 'run-1',
        parentTaskId: 'parent-1',
        agentId: 'agent-2',
        agentType: 'tool',
        status: 'pending',
        createdAt: '2024-01-01T00:00:00.000Z',
      };

      // Should not throw
      setChild(parent, child);
    });

    it('runId mismatch throws RuntimeError INVALID_TASK_TRANSITION', () => {
      const child: TaskEntity = {
        id: 'child-1',
        runId: 'run-2', // Different runId
        parentTaskId: 'parent-1',
        agentId: 'agent-2',
        agentType: 'tool',
        status: 'pending',
        createdAt: '2024-01-01T00:00:00.000Z',
      };

      assert.throws(
        () => setChild(parent, child),
        (err: Error) => {
          assert.ok(err instanceof RuntimeError);
          assert.equal(err.code, 'INVALID_TASK_TRANSITION');
          assert.ok(err.context);
          assert.equal(err.context?.parentRunId, 'run-1');
          assert.equal(err.context?.childRunId, 'run-2');
          return true;
        },
        'Expected RuntimeError on runId mismatch'
      );
    });

    it('parentTaskId mismatch throws RuntimeError INVALID_TASK_TRANSITION', () => {
      const child: TaskEntity = {
        id: 'child-1',
        runId: 'run-1',
        parentTaskId: 'parent-2', // Different parentTaskId
        agentId: 'agent-2',
        agentType: 'tool',
        status: 'pending',
        createdAt: '2024-01-01T00:00:00.000Z',
      };

      assert.throws(
        () => setChild(parent, child),
        (err: Error) => {
          assert.ok(err instanceof RuntimeError);
          assert.equal(err.code, 'INVALID_TASK_TRANSITION');
          assert.ok(err.context);
          assert.equal(err.context?.parentId, 'parent-1');
          assert.equal(err.context?.childParentTaskId, 'parent-2');
          return true;
        },
        'Expected RuntimeError on parentTaskId mismatch'
      );
    });
  });

  describe('canStart helper', () => {
    it('returns true only for pending status', () => {
      assert.equal(canStart('pending'), true);
      assert.equal(canStart('running'), false);
      assert.equal(canStart('waiting'), false);
      assert.equal(canStart('completed'), false);
      assert.equal(canStart('failed'), false);
      assert.equal(canStart('cancelled'), false);
    });

    it('TaskStateMachine.canStart static method works', () => {
      assert.equal(TaskStateMachine.canStart('pending'), true);
      assert.equal(TaskStateMachine.canStart('running'), false);
    });
  });
});