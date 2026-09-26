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
import { RunLifecycleManager } from '../core/runtime/index.js';
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

/**
 * AEX-P0-016：未知 workflow 事件类型的显式失败。
 * 调用方（modules/workflows/index.ts onEvent）整体包在 try/catch 里，
 * 因此抛出即等价于「跳过这条事件的 v2 镜像」——legacy 路径与工作流执行不受影响。
 */
export class UnknownWorkflowEventTypeError extends Error {
  readonly eventType: string;

  constructor(eventType: string) {
    super(`unknown workflow event type: ${eventType}`);
    this.name = 'UnknownWorkflowEventTypeError';
    this.eventType = eventType;
  }
}

/**
 * Map workflow lifecycle event types (§57) to the closest v2 discriminated type.
 *
 * AEX-P0-016：未登记的类型抛 UnknownWorkflowEventTypeError，绝不伪造 run.created ——
 * 伪造会把任意工作流内部事件读成「run 起点」，让 run 回放/增量消费得到假轨迹。
 * 未知类型属于「新增事件未同步映射表」的集成缺口，必须在调用点可见（error 级），
 * 而不是被静默降级掩盖。
 */
export function mapWorkflowEventType(type: string): AgentEvent['type'] {
  const map: Record<string, AgentEvent['type'] | undefined> = {
    'workflow.started': 'run.created',
    'workflow.node.started': 'task.started',
    'workflow.node.completed': 'task.completed',
    'workflow.completed': 'run.completed',
    'workflow.failed': 'run.failed',
    'workflow.cancelled': 'run.cancelled',
  };
  const mapped = map[type];
  if (mapped === undefined) {
    throw new UnknownWorkflowEventTypeError(type);
  }
  return mapped;
}

/**
 * Emit a v2 AgentEvent to the production events table.
 * The seq is allocated atomically (claim-row + UNIQUE arbitration), and the
 * eventId is preserved so replay/afterSeq stay consistent.
 *
 * 默认宽松：失败仅 warn 并返回 null（orchestration 不应因 events 表写入失败而中断）。
 * critical=true（P0-11）：关键生命周期事件（run.started / run.created / task.started
 * 等）写入失败时抛错 —— 调用方必须捕获并补偿（标记 run 失败 / 传播错误），
 * 避免"run 已经跑了但事件库里没有起点"的假稳定状态。
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
  critical?: boolean;
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
    if (input.critical) {
      // P0-11: 关键事件失败必须显式暴露，由调用方补偿
      console.error('[EventStoreRuntime] critical emitV2Event failed:', err instanceof Error ? err.message : String(err));
      throw err;
    }
    // 非关键事件：记录但不中断主流程
    console.warn('[EventStoreRuntime] emitV2Event failed:', err instanceof Error ? err.message : String(err));
    return null;
  }
}

/**
 * Ensure a runs row exists for the given runId (idempotent).
 * P0-05 收口：内部统一走 RunLifecycleManager 状态机（created → running），
 * 不再直接插入 status='running' 绕过 created→running 状态机。
 * 本函数保留为 migration compatibility（测试/旧调用方），生产新代码应直接使用
 * RunLifecycleManager。
 */
export function ensureRunRow(
  db: Db,
  runId: string,
  conversationId?: string,
  mode: 'normal' | 'super' | 'workflow' | 'background' = 'normal',
): void {
  const lifecycle = new RunLifecycleManager(db);
  const existing = db.select({ id: schema.runs.id }).from(schema.runs).where(eq(schema.runs.id, runId)).get();
  if (existing) return;
  lifecycle.createAndStart({
    runId,
    conversationId: conversationId ?? null,
    mode,
  });
}

/**
 * Write terminal status + token usage back to the runs row.
 * P0-05 收口：内部统一走 RunLifecycleManager 状态机（RUN-001 校验 + 终态写入）。
 * 保留为 migration compatibility；生产新代码应直接使用 RunLifecycleManager。
 */
export function finalizeRunTokens(
  db: Db,
  runId: string,
  status: 'completed' | 'failed' | 'cancelled',
  tokens: { inputTokens?: number; outputTokens?: number; totalTokens?: number },
  error?: string,
): void {
  const lifecycle = new RunLifecycleManager(db);
  const action = status === 'completed' ? 'complete' : status === 'failed' ? 'fail' : 'cancel';
  lifecycle.transition(runId, action, {
    inputTokens: tokens.inputTokens,
    outputTokens: tokens.outputTokens,
    totalTokens: tokens.totalTokens,
    error: error ?? undefined,
    endReason: status === 'cancelled' ? 'cancelled' : status === 'failed' ? 'error' : 'completed',
  });
}