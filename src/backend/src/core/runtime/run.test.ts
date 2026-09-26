/**
 * Run State Machine Tests
 *
 * Tests for the core/runtime run module (P1-05).
 * Run with: npm run test -w src/backend (after build)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// Import types from source for compile-time checking
import type { RunStatus, RunMode, RunEntity } from './run.js';
// Canonical 状态定义在 @pacc/shared（AEX-P0-002）：backend 不再重复定义
import { RUN_STATUSES, RUN_TERMINAL_STATUSES } from '@pacc/shared';
// Import runtime values from built dist
const { RunStateMachine, isValidRunTransition, RUN_STATUSES: MODULE_RUN_STATUSES, TERMINAL_RUN_STATUSES: MODULE_TERMINAL_RUN_STATUSES } = await import('./run.js')
const { RuntimeError } = await import('../errors/index.js')

function createMachine() {
  return new RunStateMachine();
}

const EXPECTED_RUN_STATUSES = RUN_STATUSES;

function isExpectedRunStatus(value: string): value is RunStatus {
  return EXPECTED_RUN_STATUSES.some((status) => status === value)
}

function toRunStatus(value: string): RunStatus {
  if (!isExpectedRunStatus(value)) {
    throw new Error(`unexpected run status in test: ${value}`)
  }
  return value
}

describe('core/runtime/run', () => {
  describe('RunStatus type', () => {
    it('includes all 11 expected statuses', () => {
      assert.equal(EXPECTED_RUN_STATUSES.length, 11)
      for (const status of EXPECTED_RUN_STATUSES) {
        assert.ok(isExpectedRunStatus(status))
      }
    });

    it('re-exports the canonical @pacc/shared status set (no duplicated definition)', () => {
      assert.deepEqual(MODULE_RUN_STATUSES, EXPECTED_RUN_STATUSES, 'run.ts 必须复用 shared 权威集合')
      assert.deepEqual(MODULE_TERMINAL_RUN_STATUSES, RUN_TERMINAL_STATUSES, '终态集合同样以 shared 为准')
    });

    it('canonical terminal statuses are the 5 absorbing states', () => {
      assert.equal(RUN_TERMINAL_STATUSES.length, 5)
      for (const terminal of RUN_TERMINAL_STATUSES) {
        assert.ok(isExpectedRunStatus(terminal), `${terminal} 必须属于 canonical 状态集合`)
      }
    });
  });

  describe('RunMode type', () => {
    it('includes all 4 expected modes', () => {
      const modes: RunMode[] = ['normal', 'super', 'workflow', 'background'];
      assert.equal(modes.length, 4);
    });
  });

  describe('RunStateMachine', () => {
    it('initial status is created', () => {
      const machine = createMachine();
      assert.equal(machine.status, 'created');
      assert.equal(machine.isTerminal, false);
      assert.equal(machine.hasStarted, false);
      assert.equal(machine.startedAt, undefined);
      assert.equal(machine.completedAt, undefined);
      assert.equal(machine.endReason, undefined);
      assert.equal(machine.inputTokens, 0);
      assert.equal(machine.outputTokens, 0);
      assert.equal(machine.totalTokens, 0);
    });

    it('valid path: created -> running -> waiting -> running -> completed', () => {
      const machine = createMachine();
      // created -> running
      machine.transition('running');
      assert.equal(machine.status, 'running');
      assert.ok(machine.hasStarted);
      assert.ok(machine.startedAt !== undefined);
      const firstStartedAt = machine.startedAt;

      // running -> waiting
      machine.transition('waiting');
      assert.equal(machine.status, 'waiting');
      assert.equal(machine.startedAt, firstStartedAt); // startedAt unchanged

      // waiting -> running
      machine.transition('running');
      assert.equal(machine.status, 'running');
      assert.equal(machine.startedAt, firstStartedAt); // startedAt unchanged

      // running -> completed
      machine.transition('completed', { endReason: 'Task finished successfully' });
      assert.equal(machine.status, 'completed');
      assert.equal(machine.isTerminal, true);
      assert.ok(machine.completedAt !== undefined);
      assert.equal(machine.endReason, 'Task finished successfully');
    });

    it('valid retry and verification paths preserve the state machine contract', () => {
      const machine = createMachine()
      const path = ['running', 'retry_waiting', 'retrying', 'running', 'verifying', 'completed'] as const

      for (const next of path) {
        machine.transition(toRunStatus(next))
      }

      assert.equal(machine.status, 'completed')
      assert.equal(machine.isTerminal, true)
    })

    it('legal transition table covers every declared edge and rejects every other edge', () => {
      const expectedTransitions: Readonly<Record<string, readonly string[]>> = {
        created: ['running'],
        running: [
          'waiting',
          'retry_waiting',
          'verifying',
          'completed',
          'failed',
          'cancelled',
          'interrupted',
          'budget_exceeded',
        ],
        waiting: [
          'running',
          'retry_waiting',
          'verifying',
          'completed',
          'failed',
          'cancelled',
          'interrupted',
          'budget_exceeded',
        ],
        retry_waiting: ['retrying', 'failed', 'cancelled', 'interrupted', 'budget_exceeded'],
        retrying: ['running', 'waiting', 'failed', 'cancelled', 'interrupted', 'budget_exceeded'],
        verifying: ['running', 'completed', 'failed', 'cancelled', 'interrupted', 'budget_exceeded'],
        completed: [],
        failed: [],
        cancelled: [],
        interrupted: [],
        budget_exceeded: [],
      }

      for (const from of EXPECTED_RUN_STATUSES) {
        const allowed = expectedTransitions[from]
        if (!allowed) {
          throw new Error(`missing expected transition row: ${from}`)
        }
        for (const to of EXPECTED_RUN_STATUSES) {
          assert.equal(
            isValidRunTransition(toRunStatus(from), toRunStatus(to)),
            allowed.includes(to),
            `unexpected transition result: ${from} -> ${to}`,
          )
        }
      }
    })

    it('startedAt set on first running transition', () => {
      const machine = createMachine()
      assert.equal(machine.startedAt, undefined)
      machine.transition('running')
      assert.ok(machine.startedAt !== undefined)
      const firstStartedAt = machine.startedAt

      // Subsequent transitions should not change startedAt
      machine.transition('waiting')
      machine.transition('running')
      assert.equal(machine.startedAt, firstStartedAt)
    })

    it('completedAt and endReason set on terminal transition', () => {
      const machine = createMachine();
      machine.transition('running');
      machine.transition('completed', { endReason: 'Done' });

      assert.ok(machine.completedAt !== undefined);
      assert.equal(machine.endReason, 'Done');
    });

    it('invalid transition completed -> running throws RuntimeError INVALID_RUN_TRANSITION', () => {
      const machine = createMachine();
      machine.transition('running');
      machine.transition('completed');

      assert.throws(
        () => machine.transition('running'),
        (err: Error) => {
          assert.ok(err instanceof RuntimeError);
          assert.equal(err.code, 'INVALID_RUN_TRANSITION');
          assert.equal(err.retryable, false);
          assert.ok(err.context);
          assert.equal(err.context?.currentState, 'completed');
          assert.equal(err.context?.attemptedState, 'running');
          return true;
        },
        'Expected RuntimeError on invalid transition completed->running'
      );
    });

    it('cancelled from waiting works', () => {
      const machine = createMachine();
      machine.transition('running');
      machine.transition('waiting');
      machine.transition('cancelled', { endReason: 'User cancelled' });

      assert.equal(machine.status, 'cancelled');
      assert.equal(machine.isTerminal, true);
      assert.equal(machine.endReason, 'User cancelled');
    });

    it('interrupted from running works', () => {
      const machine = createMachine();
      machine.transition('running');
      machine.transition('interrupted', { endReason: 'System interrupted' });

      assert.equal(machine.status, 'interrupted');
      assert.equal(machine.isTerminal, true);
      assert.equal(machine.endReason, 'System interrupted');
    });

    it('failed from running works with error', () => {
      const machine = createMachine()
      machine.transition('running')
      machine.transition('failed', { endReason: 'Model error', error: 'Rate limit exceeded' })

      assert.equal(machine.status, 'failed')
      assert.equal(machine.isTerminal, true)
      assert.equal(machine.endReason, 'Model error')
      const entity = machine.toEntity({
        id: 'run-error',
        mode: 'normal',
        createdAt: '2024-01-01T00:00:00.000Z',
      })
      assert.equal(entity.error, 'Rate limit exceeded')
      assert.notEqual(entity.error, entity.endReason)
    })

    it('assertStatus ok when status matches', () => {
      const machine = createMachine();
      machine.transition('running');
      machine.assertStatus('running'); // Should not throw
    });

    it('assertStatus throws RuntimeError on mismatch', () => {
      const machine = createMachine();
      machine.transition('running');

      assert.throws(
        () => machine.assertStatus('waiting'),
        (err: Error) => {
          assert.ok(err instanceof RuntimeError);
          assert.equal(err.code, 'INVALID_RUN_TRANSITION');
          assert.ok(err.context);
          assert.equal(err.context?.expected, 'waiting');
          assert.equal(err.context?.actual, 'running');
          return true;
        },
        'Expected RuntimeError on status mismatch'
      );
    });

    it('tokenUsage accumulated across transitions', () => {
      const machine = createMachine();
      machine.transition('running', {
        tokenUsage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
      });
      assert.equal(machine.inputTokens, 100);
      assert.equal(machine.outputTokens, 50);
      assert.equal(machine.totalTokens, 150);

      machine.transition('waiting', {
        tokenUsage: { inputTokens: 20, outputTokens: 10, totalTokens: 30 },
      });
      assert.equal(machine.inputTokens, 120);
      assert.equal(machine.outputTokens, 60);
      assert.equal(machine.totalTokens, 180);

      machine.transition('running', {
        tokenUsage: { inputTokens: 5, outputTokens: 5, totalTokens: 10 },
      });
      assert.equal(machine.inputTokens, 125);
      assert.equal(machine.outputTokens, 65);
      assert.equal(machine.totalTokens, 190);

      machine.transition('completed', {
        tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
      });
      assert.equal(machine.inputTokens, 125);
      assert.equal(machine.outputTokens, 65);
      assert.equal(machine.totalTokens, 190);
    });

    it('tokenUsage optional - transitions work without it', () => {
      const machine = createMachine();
      machine.transition('running');
      machine.transition('waiting');
      machine.transition('completed');

      assert.equal(machine.inputTokens, 0);
      assert.equal(machine.outputTokens, 0);
      assert.equal(machine.totalTokens, 0);
    });

    it('toEntity creates RunEntity with current state', () => {
      const machine = createMachine();
      machine.transition('running');
      machine.transition('completed', { endReason: 'Done' });

      const entity = machine.toEntity({
        id: 'run-123',
        conversationId: 'conv-456',
        mode: 'normal',
        rootAgentId: 'agent-1',
        metadata: { key: 'value' },
        createdAt: '2024-01-01T00:00:00.000Z',
      });

      assert.equal(entity.id, 'run-123');
      assert.equal(entity.conversationId, 'conv-456');
      assert.equal(entity.mode, 'normal');
      assert.equal(entity.rootAgentId, 'agent-1');
      assert.equal(entity.metadata?.key, 'value');
      assert.equal(entity.createdAt, '2024-01-01T00:00:00.000Z');
      assert.equal(entity.status, 'completed');
      assert.ok(entity.startedAt !== undefined);
      assert.ok(entity.completedAt !== undefined);
      assert.equal(entity.endReason, 'Done');
      assert.equal(entity.inputTokens, 0);
      assert.equal(entity.outputTokens, 0);
      assert.equal(entity.totalTokens, 0);
    });

    it('reset returns to initial state', () => {
      const machine = createMachine();
      machine.transition('running');
      machine.transition('completed');
      machine.reset();

      assert.equal(machine.status, 'created');
      assert.equal(machine.isTerminal, false);
      assert.equal(machine.hasStarted, false);
      assert.equal(machine.startedAt, undefined);
      assert.equal(machine.completedAt, undefined);
      assert.equal(machine.endReason, undefined);
      assert.equal(machine.inputTokens, 0);
      assert.equal(machine.outputTokens, 0);
      assert.equal(machine.totalTokens, 0);
    });

    it('all terminal states are absorbing (no outgoing transitions)', () => {
      for (const terminal of RUN_TERMINAL_STATUSES) {
        const m = createMachine()
        m.transition('running')
        m.transition(toRunStatus(terminal))

        // Try all possible transitions from terminal state
        for (const next of EXPECTED_RUN_STATUSES) {
          if (next === terminal) continue
          assert.throws(
            () => m.transition(toRunStatus(next)),
            (err: Error) => {
              assert.ok(err instanceof RuntimeError)
              assert.equal(err.code, 'INVALID_RUN_TRANSITION')
              return true
            },
            `Expected error from ${terminal} -> ${next}`,
          )
        }
      }
    })

    it('waiting -> running allowed (round-trip)', () => {
      const machine = createMachine();
      machine.transition('running');
      machine.transition('waiting');
      machine.transition('running'); // Should work
      assert.equal(machine.status, 'running');
    });

    it('created -> waiting throws (must go through running)', () => {
      const machine = createMachine();
      assert.throws(
        () => machine.transition('waiting'),
        (err: Error) => {
          assert.ok(err instanceof RuntimeError);
          assert.equal(err.code, 'INVALID_RUN_TRANSITION');
          return true;
        },
        'Expected error from created -> waiting'
      );
    });
  });
});