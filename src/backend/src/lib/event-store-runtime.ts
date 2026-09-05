/**
 * Event Store Runtime — Aether 2.0 production wiring for the v2 Event Runtime
 *
 * Fixes Oracle gap B (v2 EventStore/SequenceAllocator were test-only islands):
 * this module owns the PRODUCTION instances of SqliteEventStore and
 * DbSequenceAllocator and exposes an emit helper that appends v2 AgentEvents
 * to the `events` table during real orchestration runs.
 *
 * The legacy activity_events path is untouched (Adapter pattern §2.1);
 * v2 events are written ALONGSIDE the legacy eventBus so both layers stay
 * consistent and GET /api/runs/:runId/events returns real data.
 *
 * Pure TypeScript — no Fastify/SSE/React imports.
 */

import type { SQLJsDatabase } from 'drizzle-orm/sql-js';
import { eq } from 'drizzle-orm';
import * as schema from '../db/schema/index.js';
import { getDb } from '../db/client.js';
import { SqliteEventStore, DbSequenceAllocator } from '../core/events/index.js';
import type { AgentEvent } from '@pacc/shared';

type Db = SQLJsDatabase<typeof schema>;

let store: SqliteEventStore | null = null;
let allocator: DbSequenceAllocator | null = null;

/** Lazily create the production v2 EventStore singleton */
export function getV2EventStore(): SqliteEventStore {
  if (!store) {
    store = new SqliteEventStore(getDb());
  }
  return store;
}

/** Lazily create the production v2 sequence allocator singleton */
export function getV2SequenceAllocator(): DbSequenceAllocator {
  if (!allocator) {
    allocator = new DbSequenceAllocator(getDb());
  }
  return allocator;
}

/** Test aid: reset the singletons so a fresh DB can take over */
export function resetV2EventRuntime(): void {
  store = null;
  allocator = null;
}

/** Map legacy v1 eventType to the closest v2 discriminated type */
export function mapEventTypeToV2(legacyType: string): AgentEvent['type'] {
  const map: Record<string, AgentEvent['type']> = {
    'task.started': 'task.started',
    'task.plan': 'task.plan',
    'task.progress': 'task.progress',
    'task.ask-confirm': 'task.ask-confirm',
    'task.completed': 'task.completed',
    'task.cancelled': 'task.cancelled',
    'task.failed': 'task.failed',
    'agent.started': 'agent.started',
    'agent.status': 'agent.status',
    'agent.waiting': 'agent.waiting',
    'agent.resumed': 'agent.resumed',
    'agent.completed': 'agent.completed',
    'agent.error': 'agent.error',
    'agent.retry': 'agent.retry',
    'agent.spawned': 'agent.spawned',
    'agent.handoff': 'agent.handoff',
    'agent.failed': 'agent.failed',
    'agent.inbox.directive': 'agent.inbox.directive',
    'agent.message.delta': 'agent.message.delta',
    'agent.message.completed': 'agent.message.completed',
    'agent.reasoning.delta': 'agent.reasoning.delta',
    'agent.output.delta': 'agent.output.delta',
    'agent.output.completed': 'agent.output.completed',
    'tool.started': 'tool.started',
    'tool.progress': 'tool.progress',
    'tool.completed': 'tool.completed',
    'tool.error': 'tool.error',
    'tool.retry': 'tool.retry',
    'token': 'token.usage',
  };
  return map[legacyType] ?? 'run.created';
}

/** Map workflow lifecycle event types (§57) to the closest v2 discriminated type */
export function mapWorkflowEventType(type: string): AgentEvent['type'] {
  const map: Record<string, AgentEvent['type']> = {
    'workflow.started': 'run.created',
    'workflow.node.started': 'task.started',
    'workflow.node.completed': 'task.completed',
    'workflow.completed': 'run.completed',
    'workflow.failed': 'run.failed',
  };
  return map[type] ?? 'run.created';
}

/**
 * Emit a v2 AgentEvent to the production events table.
 * The seq is allocated atomically (claim-row + UNIQUE arbitration), and the
 * eventId is preserved so replay/afterSeq stay consistent.
 * Never throws — orchestration must not break because an event write failed.
 */
export async function emitV2Event(input: {
  runId: string;
  sessionId: string;
  taskId?: string;
  agentId?: string;
  parentEventId?: string;
  type: AgentEvent['type'];
  payload: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  eventId?: string;
}): Promise<AgentEvent | null> {
  try {
    const seq = await getV2SequenceAllocator().allocate(input.runId);
    const event: AgentEvent = {
      eventId: input.eventId ?? `${input.type}-${input.runId}-${seq}`,
      sessionId: input.sessionId,
      runId: input.runId,
      taskId: input.taskId,
      agentId: input.agentId,
      parentEventId: input.parentEventId,
      timestamp: new Date().toISOString(),
      seq,
      type: input.type,
      version: 2,
      payload: input.payload as never,
      metadata: input.metadata,
    } as AgentEvent;
    await getV2EventStore().append(event);
    return event;
  } catch (err) {
    // Never break orchestration because the events table write failed
    console.warn('[EventStoreRuntime] emitV2Event failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Ensure a runs row exists for the given runId (idempotent).
 * This is the production writer for Oracle gap C: orchestration runs get a
 * runs row so start/pause/resume/cancel and token snapshots have somewhere
 * to land.
 */
export function ensureRunRow(
  db: Db,
  runId: string,
  conversationId?: string,
  mode: 'normal' | 'super' | 'workflow' | 'background' = 'normal',
): void {
  const { runs } = schema;
  const existing = db.select({ id: runs.id }).from(runs).where(eq(runs.id, runId)).get();
  if (existing) return;
  db.insert(runs).values({
    id: runId,
    conversationId: conversationId ?? null,
    status: 'running',
    mode,
    startedAt: new Date().toISOString(),
    createdAt: new Date().toISOString(),
  }).run();
}

/**
 * Write terminal status + token usage back to the runs row.
 * Fixes Oracle gap C: completed/failed + token fields had no DB producer.
 */
export function finalizeRunTokens(
  db: Db,
  runId: string,
  status: 'completed' | 'failed' | 'cancelled',
  tokens: { inputTokens?: number; outputTokens?: number; totalTokens?: number },
  error?: string,
): void {
  const { runs } = schema;
  const inputTokens = tokens.inputTokens ?? 0;
  const outputTokens = tokens.outputTokens ?? 0;
  db.update(runs)
    .set({
      status,
      completedAt: new Date().toISOString(),
      endReason: status === 'cancelled' ? 'cancelled' : status === 'failed' ? 'error' : 'completed',
      inputTokens,
      outputTokens,
      totalTokens: tokens.totalTokens ?? inputTokens + outputTokens,
      error: error ?? null,
    })
    .where(eq(runs.id, runId))
    .run();
}