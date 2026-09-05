/**
 * Aether 2.0 — v2 AgentEvent Protocol Tests
 *
 * Comprehensive test suite covering:
 * - All 37 event types constructible with correct discriminant
 * - Exhaustive switching on AgentEvent union
 * - isAgentEvent type guard narrowing
 * - Legacy adapter round-trip preservation
 * - BaseEvent compile-time requirements (version & runId)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AgentEvent,
  BaseEvent,
  AGENT_EVENT_TYPES,
  isAgentEvent,
  assertNever,
  // Event types for construction
  RunCreatedEvent,
  RunStartedEvent,
  RunPausedEvent,
  RunResumedEvent,
  RunCompletedEvent,
  RunFailedEvent,
  RunCancelledEvent,
  RunInterruptedEvent,
  TaskStartedEvent,
  TaskPlanEvent,
  TaskProgressEvent,
  TaskAskConfirmEvent,
  TaskCompletedEvent,
  TaskCancelledEvent,
  TaskFailedEvent,
  AgentStartedEvent,
  AgentStatusEvent,
  AgentWaitingEvent,
  AgentResumedEvent,
  AgentCompletedEvent,
  AgentErrorEvent,
  AgentRetryEvent,
  AgentSpawnedEvent,
  AgentHandoffEvent,
  AgentFailedEvent,
  AgentInboxDirectiveEvent,
  AgentMessageDeltaEvent,
  AgentMessageCompletedEvent,
  AgentReasoningDeltaEvent,
  AgentOutputDeltaEvent,
  AgentOutputCompletedEvent,
  ToolStartedEvent,
  ToolProgressEvent,
  ToolCompletedEvent,
  ToolErrorEvent,
  ToolRetryEvent,
  TokenUsageEvent,
} from './events.js';
import { toLegacy, toV2, verifyRoundTrip } from './legacy-adapter.js';
import type { AgentEventEnvelope } from '../agent-event.js';

// Helper to create a minimal valid BaseEvent
function baseEvent(overrides: Partial<BaseEvent> = {}): BaseEvent {
  return {
    eventId: 'evt-1',
    sessionId: 'sess-1',
    runId: 'run-1',
    timestamp: '2026-09-05T00:00:00.000Z',
    seq: 1,
    version: 2,
    type: 'task.started', // default, will be overridden
    ...overrides,
  } as BaseEvent;
}

describe('v2 AgentEvent protocol', () => {
  describe('all 37 event types constructible with correct discriminant', () => {
    const eventConstructors: Array<{ type: AgentEvent['type']; create: () => AgentEvent }> = [
      { type: 'run.created', create: () => ({ ...baseEvent(), type: 'run.created', payload: {} }) as RunCreatedEvent },
      { type: 'run.started', create: () => ({ ...baseEvent(), type: 'run.started', payload: {} }) as RunStartedEvent },
      { type: 'run.paused', create: () => ({ ...baseEvent(), type: 'run.paused', payload: {} }) as RunPausedEvent },
      { type: 'run.resumed', create: () => ({ ...baseEvent(), type: 'run.resumed', payload: {} }) as RunResumedEvent },
      { type: 'run.completed', create: () => ({ ...baseEvent(), type: 'run.completed', payload: { endReason: 'completed', tokenUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } } }) as RunCompletedEvent },
      { type: 'run.failed', create: () => ({ ...baseEvent(), type: 'run.failed', payload: { endReason: 'error', error: { message: 'oops' } } }) as RunFailedEvent },
      { type: 'run.cancelled', create: () => ({ ...baseEvent(), type: 'run.cancelled', payload: { endReason: 'aborted' } }) as RunCancelledEvent },
      { type: 'run.interrupted', create: () => ({ ...baseEvent(), type: 'run.interrupted', payload: { endReason: 'aborted' } }) as RunInterruptedEvent },

      { type: 'task.started', create: () => ({ ...baseEvent(), type: 'task.started', payload: { status: 'started' as const } }) as TaskStartedEvent },
      { type: 'task.plan', create: () => ({ ...baseEvent(), type: 'task.plan', payload: { content: 'plan', status: 'running' as const } }) as TaskPlanEvent },
      { type: 'task.progress', create: () => ({ ...baseEvent(), type: 'task.progress', payload: { content: 'progress', status: 'running' as const } }) as TaskProgressEvent },
      { type: 'task.ask-confirm', create: () => ({ ...baseEvent(), type: 'task.ask-confirm', payload: { content: 'confirm?', status: 'running' as const } }) as TaskAskConfirmEvent },
      { type: 'task.completed', create: () => ({ ...baseEvent(), type: 'task.completed', payload: { status: 'completed' as const, endReason: 'completed', content: 'done' } }) as TaskCompletedEvent },
      { type: 'task.cancelled', create: () => ({ ...baseEvent(), type: 'task.cancelled', payload: { status: 'cancelled' as const, endReason: 'aborted', content: 'cancelled' } }) as TaskCancelledEvent },
      { type: 'task.failed', create: () => ({ ...baseEvent(), type: 'task.failed', payload: { status: 'error' as const, endReason: 'error', content: 'failed', error: { message: 'err' } } }) as TaskFailedEvent },

      { type: 'agent.started', create: () => ({ ...baseEvent(), type: 'agent.started', payload: { status: 'running' as const } }) as AgentStartedEvent },
      { type: 'agent.status', create: () => ({ ...baseEvent(), type: 'agent.status', payload: { status: 'running' as const } }) as AgentStatusEvent },
      { type: 'agent.waiting', create: () => ({ ...baseEvent(), type: 'agent.waiting', payload: { status: 'waiting' as const, content: 'waiting' } }) as AgentWaitingEvent },
      { type: 'agent.resumed', create: () => ({ ...baseEvent(), type: 'agent.resumed', payload: { status: 'running' as const } }) as AgentResumedEvent },
      { type: 'agent.completed', create: () => ({ ...baseEvent(), type: 'agent.completed', payload: { status: 'completed' as const } }) as AgentCompletedEvent },
      { type: 'agent.error', create: () => ({ ...baseEvent(), type: 'agent.error', payload: { status: 'error' as const, content: 'err', error: { message: 'err' } } }) as AgentErrorEvent },
      { type: 'agent.retry', create: () => ({ ...baseEvent(), type: 'agent.retry', payload: { status: 'retry' as const, content: 'retry' } }) as AgentRetryEvent },
      { type: 'agent.spawned', create: () => ({ ...baseEvent(), type: 'agent.spawned', payload: { targetAgentId: 'agent-2' } }) as AgentSpawnedEvent },
      { type: 'agent.handoff', create: () => ({ ...baseEvent(), type: 'agent.handoff', payload: { targetAgentId: 'agent-2', content: 'handoff' } }) as AgentHandoffEvent },
      { type: 'agent.failed', create: () => ({ ...baseEvent(), type: 'agent.failed', payload: { status: 'error' as const, content: 'failed', error: { message: 'err' } } }) as AgentFailedEvent },
      { type: 'agent.inbox.directive', create: () => ({ ...baseEvent(), type: 'agent.inbox.directive', payload: { directive: 'do this' } }) as AgentInboxDirectiveEvent },

      { type: 'agent.message.delta', create: () => ({ ...baseEvent(), type: 'agent.message.delta', payload: { content: 'hello', isFinal: false } }) as AgentMessageDeltaEvent },
      { type: 'agent.message.completed', create: () => ({ ...baseEvent(), type: 'agent.message.completed', payload: { content: 'hello', isFinal: true } }) as AgentMessageCompletedEvent },
      { type: 'agent.reasoning.delta', create: () => ({ ...baseEvent(), type: 'agent.reasoning.delta', payload: { content: 'thinking', isFinal: false } }) as AgentReasoningDeltaEvent },

      { type: 'agent.output.delta', create: () => ({ ...baseEvent(), type: 'agent.output.delta', payload: { content: 'output', isFinal: false } }) as AgentOutputDeltaEvent },
      { type: 'agent.output.completed', create: () => ({ ...baseEvent(), type: 'agent.output.completed', payload: { content: 'output', isFinal: true } }) as AgentOutputCompletedEvent },

      { type: 'tool.started', create: () => ({ ...baseEvent(), type: 'tool.started', payload: { toolName: 'read_file', toolInput: 'path', status: 'started' as const } }) as ToolStartedEvent },
      { type: 'tool.progress', create: () => ({ ...baseEvent(), type: 'tool.progress', payload: { toolName: 'read_file', toolInput: 'path', status: 'running' as const } }) as ToolProgressEvent },
      { type: 'tool.completed', create: () => ({ ...baseEvent(), type: 'tool.completed', payload: { toolName: 'read_file', toolInput: 'path', toolOutput: 'content', status: 'completed' as const } }) as ToolCompletedEvent },
      { type: 'tool.error', create: () => ({ ...baseEvent(), type: 'tool.error', payload: { toolName: 'read_file', toolInput: 'path', error: { message: 'err' }, status: 'error' as const } }) as ToolErrorEvent },
      { type: 'tool.retry', create: () => ({ ...baseEvent(), type: 'tool.retry', payload: { toolName: 'read_file', toolInput: 'path', status: 'retry' as const } }) as ToolRetryEvent },

      { type: 'token.usage', create: () => ({ ...baseEvent(), type: 'token.usage', payload: { inputTokens: 100, outputTokens: 200, totalTokens: 300 } }) as TokenUsageEvent },
    ];

    it('AGENT_EVENT_TYPES has exactly 37 entries', () => {
      assert.equal(AGENT_EVENT_TYPES.length, 37);
    });

    it('each event type constructs and matches its discriminant', () => {
      for (const { type, create } of eventConstructors) {
        const event = create();
        assert.equal(event.type, type, `Event ${type} discriminant mismatch`);
        assert.ok(isAgentEvent(event), `isAgentEvent should return true for ${type}`);
      }
    });

    it('AGENT_EVENT_TYPES contains all 37 discriminants in correct order', () => {
      const expected = [
        'run.created', 'run.started', 'run.paused', 'run.resumed', 'run.completed', 'run.failed', 'run.cancelled', 'run.interrupted',
        'task.started', 'task.plan', 'task.progress', 'task.ask-confirm', 'task.completed', 'task.cancelled', 'task.failed',
        'agent.started', 'agent.status', 'agent.waiting', 'agent.resumed', 'agent.completed', 'agent.error', 'agent.retry', 'agent.spawned', 'agent.handoff', 'agent.failed', 'agent.inbox.directive',
        'agent.message.delta', 'agent.message.completed', 'agent.reasoning.delta',
        'agent.output.delta', 'agent.output.completed',
        'tool.started', 'tool.progress', 'tool.completed', 'tool.error', 'tool.retry',
        'token.usage',
      ];
      assert.deepEqual([...AGENT_EVENT_TYPES], expected);
    });
  });

  describe('exhaustive switching on AgentEvent union', () => {
    // This function demonstrates exhaustive switching — if a new type is added
    // to AgentEvent but not handled here, TypeScript will error on the assertNever call.
    function handleEventExhaustively(event: AgentEvent): string {
      switch (event.type) {
        case 'run.created': return 'run-created';
        case 'run.started': return 'run-started';
        case 'run.paused': return 'run-paused';
        case 'run.resumed': return 'run-resumed';
        case 'run.completed': return 'run-completed';
        case 'run.failed': return 'run-failed';
        case 'run.cancelled': return 'run-cancelled';
        case 'run.interrupted': return 'run-interrupted';
        case 'task.started': return 'task-started';
        case 'task.plan': return 'task-plan';
        case 'task.progress': return 'task-progress';
        case 'task.ask-confirm': return 'task-ask-confirm';
        case 'task.completed': return 'task-completed';
        case 'task.cancelled': return 'task-cancelled';
        case 'task.failed': return 'task-failed';
        case 'agent.started': return 'agent-started';
        case 'agent.status': return 'agent-status';
        case 'agent.waiting': return 'agent-waiting';
        case 'agent.resumed': return 'agent-resumed';
        case 'agent.completed': return 'agent-completed';
        case 'agent.error': return 'agent-error';
        case 'agent.retry': return 'agent-retry';
        case 'agent.spawned': return 'agent-spawned';
        case 'agent.handoff': return 'agent-handoff';
        case 'agent.failed': return 'agent-failed';
        case 'agent.inbox.directive': return 'agent-inbox-directive';
        case 'agent.message.delta': return 'agent-message-delta';
        case 'agent.message.completed': return 'agent-message-completed';
        case 'agent.reasoning.delta': return 'agent-reasoning-delta';
        case 'agent.output.delta': return 'agent-output-delta';
        case 'agent.output.completed': return 'agent-output-completed';
        case 'tool.started': return 'tool-started';
        case 'tool.progress': return 'tool-progress';
        case 'tool.completed': return 'tool-completed';
        case 'tool.error': return 'tool-error';
        case 'tool.retry': return 'tool-retry';
        case 'token.usage': return 'token-usage';
        default: return assertNever(event);
      }
    }

    it('exhaustive switch compiles and handles all 37 types', () => {
      const sampleEvent = { ...baseEvent(), type: 'task.started' as const, payload: { status: 'started' as const } };
      const result = handleEventExhaustively(sampleEvent);
      assert.equal(result, 'task-started');
    });

    it('exhaustive switch works for each event category', () => {
      const runEvent = { ...baseEvent(), type: 'run.completed' as const, payload: { endReason: 'completed' as const, tokenUsage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 } } };
      assert.equal(handleEventExhaustively(runEvent), 'run-completed');

      const agentEvent = { ...baseEvent(), type: 'agent.message.delta' as const, payload: { content: 'x', isFinal: false } };
      assert.equal(handleEventExhaustively(agentEvent), 'agent-message-delta');

      const toolEvent = { ...baseEvent(), type: 'tool.completed' as const, payload: { toolName: 't', toolInput: 'i', toolOutput: 'o', status: 'completed' as const } };
      assert.equal(handleEventExhaustively(toolEvent), 'tool-completed');
    });
  });

  describe('isAgentEvent type guard', () => {
    it('returns true for valid AgentEvent objects', () => {
      const validEvent = { ...baseEvent(), type: 'task.started' as const, payload: { status: 'started' as const } };
      assert.ok(isAgentEvent(validEvent));
    });

    it('returns false for objects missing required fields', () => {
      assert.ok(!isAgentEvent(null));
      assert.ok(!isAgentEvent(undefined));
      assert.ok(!isAgentEvent({}));
      assert.ok(!isAgentEvent({ type: 'task.started' }));
      assert.ok(!isAgentEvent({ type: 'task.started', eventId: 'x' }));
      assert.ok(!isAgentEvent({ type: 'task.started', eventId: 'x', sessionId: 's' }));
      assert.ok(!isAgentEvent({ type: 'task.started', eventId: 'x', sessionId: 's', runId: 'r' }));
      assert.ok(!isAgentEvent({ type: 'task.started', eventId: 'x', sessionId: 's', runId: 'r', timestamp: 't' }));
      assert.ok(!isAgentEvent({ type: 'task.started', eventId: 'x', sessionId: 's', runId: 'r', timestamp: 't', seq: 1 }));
      assert.ok(!isAgentEvent({ type: 'task.started', eventId: 'x', sessionId: 's', runId: 'r', timestamp: 't', seq: 1, version: 1 })); // wrong version
    });

    it('returns false for unknown event type', () => {
      const unknownType = { ...baseEvent(), type: 'unknown.type' };
      assert.ok(!isAgentEvent(unknownType));
    });

    it('narrows type in conditional blocks', () => {
      const unknown: unknown = { ...baseEvent(), type: 'agent.message.delta' as const, payload: { content: 'hi', isFinal: false } };

      if (isAgentEvent(unknown)) {
        // TypeScript should narrow to AgentEvent here
        assert.equal(unknown.type, 'agent.message.delta');
        assert.equal(unknown.payload.content, 'hi');
      } else {
        assert.fail('should have narrowed to AgentEvent');
      }
    });
  });

  describe('legacy adapter round-trip', () => {
    const runId = 'run-123';

    it('preserves key fields for task.started', () => {
      const original: AgentEvent = {
        ...baseEvent({ eventId: 'evt-task', taskId: 'task-1', agentId: 'agent-1', seq: 5, runId }),
        type: 'task.started',
        payload: { status: 'started' },
      };

      const roundTripped = toV2(toLegacy(original), runId);
      const verification = verifyRoundTrip(original, roundTripped);

      assert.ok(verification.ok, `Mismatches: ${verification.mismatches.join(', ')}`);
      assert.equal(roundTripped.type, 'task.started');
    });

    it('preserves key fields for agent.message.delta', () => {
      const original: AgentEvent = {
        ...baseEvent({ eventId: 'evt-msg', taskId: 'task-1', agentId: 'agent-1', seq: 10, runId }),
        type: 'agent.message.delta',
        payload: { content: 'Hello world', isFinal: false },
      };

      const roundTripped = toV2(toLegacy(original), runId);
      const verification = verifyRoundTrip(original, roundTripped);

      assert.ok(verification.ok, `Mismatches: ${verification.mismatches.join(', ')}`);
      assert.equal(roundTripped.type, 'agent.message.delta');
    });

    it('preserves key fields for tool.completed', () => {
      const original: AgentEvent = {
        ...baseEvent({ eventId: 'evt-tool', taskId: 'task-1', agentId: 'agent-1', seq: 15, runId }),
        type: 'tool.completed',
        payload: { toolName: 'read_file', toolInput: 'src/main.ts', toolOutput: 'file content', status: 'completed' },
      };

      const roundTripped = toV2(toLegacy(original), runId);
      const verification = verifyRoundTrip(original, roundTripped);

      assert.ok(verification.ok, `Mismatches: ${verification.mismatches.join(', ')}`);
      assert.equal(roundTripped.type, 'tool.completed');
    });

    it('toLegacy produces valid v1 envelope with all required fields', () => {
      const event: AgentEvent = {
        ...baseEvent({ eventId: 'evt-1', taskId: 'task-1', agentId: 'agent-1', seq: 1 }),
        type: 'task.completed',
        payload: { status: 'completed', endReason: 'completed', content: 'Done' },
      };

      const legacy = toLegacy(event);

      assert.equal(legacy.eventId, 'evt-1');
      assert.equal(legacy.sessionId, 'sess-1');
      assert.equal(legacy.taskId, 'task-1');
      assert.equal(legacy.agentId, 'agent-1');
      assert.equal(legacy.eventType, 'task.completed');
      assert.equal(legacy.seq, 1);
      assert.equal(legacy.status, 'completed');
      assert.equal(legacy.content, 'Done');
      assert.equal(legacy.endReason, 'completed');
    });

    it('toV2 requires runId argument and sets version to 2', () => {
      const envelope: AgentEventEnvelope = {
        eventId: 'evt-1',
        sessionId: 'sess-1',
        taskId: 'task-1',
        agentId: 'agent-1',
        agentType: 'conversation',
        eventType: 'task.started',
        timestamp: '2026-09-05T00:00:00.000Z',
        seq: 1,
      };

      const v2 = toV2(envelope, 'run-456');

      assert.equal(v2.runId, 'run-456');
      assert.equal(v2.version, 2);
      assert.equal(v2.type, 'task.started');
    });
  });

  describe('BaseEvent compile-time requirements', () => {
    it('BaseEvent requires version field (compile-time check)', () => {
      // This test demonstrates that BaseEvent requires version at type level.
      // If version were optional, the following would compile but it shouldn't.
      // We verify at runtime that version is present and equals 2.
      const event: BaseEvent = {
        eventId: 'x',
        sessionId: 's',
        runId: 'r',
        timestamp: 't',
        seq: 1,
        type: 'task.started',
        version: 2,
      };
      assert.equal(event.version, 2);
    });

    it('BaseEvent requires runId field (compile-time check)', () => {
      // Similarly, runId is required in BaseEvent
      const event: BaseEvent = {
        eventId: 'x',
        sessionId: 's',
        runId: 'r',
        timestamp: 't',
        seq: 1,
        type: 'task.started',
        version: 2,
      };
      assert.equal(event.runId, 'r');
    });

    it('AgentEvent requires version === 2', () => {
      const event: AgentEvent = {
        ...baseEvent(),
        type: 'task.started',
        payload: { status: 'started' },
      };
      assert.equal(event.version, 2);
    });
  });

  describe('payload field completeness', () => {
    it('RunCompletedEvent requires endReason and tokenUsage', () => {
      const event: RunCompletedEvent = {
        ...baseEvent(),
        type: 'run.completed',
        payload: { endReason: 'completed', tokenUsage: { inputTokens: 10, outputTokens: 20, totalTokens: 30 } },
      };
      assert.equal(event.payload.endReason, 'completed');
      assert.equal(event.payload.tokenUsage?.totalTokens, 30);
    });

    it('RunFailedEvent requires endReason and error', () => {
      const event: RunFailedEvent = {
        ...baseEvent(),
        type: 'run.failed',
        payload: { endReason: 'error', error: { message: 'boom' } },
      };
      assert.equal(event.payload.error.message, 'boom');
    });

    it('TaskCompletedEvent requires status, endReason', () => {
      const event: TaskCompletedEvent = {
        ...baseEvent(),
        type: 'task.completed',
        payload: { status: 'completed', endReason: 'completed', content: 'done' },
      };
      assert.equal(event.payload.status, 'completed');
    });

    it('AgentErrorEvent requires status, content, error', () => {
      const event: AgentErrorEvent = {
        ...baseEvent(),
        type: 'agent.error',
        payload: { status: 'error', content: 'failed', error: { message: 'err' } },
      };
      assert.equal(event.payload.status, 'error');
    });

    it('ToolCompletedEvent requires toolOutput and status completed', () => {
      const event: ToolCompletedEvent = {
        ...baseEvent(),
        type: 'tool.completed',
        payload: { toolName: 't', toolInput: 'i', toolOutput: 'o', status: 'completed' },
      };
      assert.equal(event.payload.toolOutput, 'o');
    });

    it('TokenUsageEvent requires inputTokens, outputTokens, totalTokens', () => {
      const event: TokenUsageEvent = {
        ...baseEvent(),
        type: 'token.usage',
        payload: { inputTokens: 100, outputTokens: 200, totalTokens: 300 },
      };
      assert.equal(event.payload.totalTokens, 300);
    });
  });
});