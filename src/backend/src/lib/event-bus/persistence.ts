import { randomUUID } from 'node:crypto';
import {
  activityEvents,
} from '../../db/schema/index.js';
import type { SQLJsDatabase } from 'drizzle-orm/sql-js';
import { eq } from 'drizzle-orm';
import type { AgentEventEnvelope, AgentEventType } from '@pacc/shared';
import { flushPacks, setWritePackedRow, unpackRow } from './chunk-packer.js';
import { rowToEnvelope, nextSeq, getNextSeq, pendingPacks, isPackable, queuePack, shouldFlushPack, PACKABLE_EVENT_TYPES, PACK_MAX_CHUNKS, PACK_MAX_BYTES, PackedChunk, EventEmitOptions, ActivityEventRow, createEventBusState, type EventBusState } from './types.js';

/**
 * 初始化序号：从 DB 现有最大 seq 继续（进程重启后不重复）
 * P1-07: 支持实例状态（绑定到 EventBus 实例而非模块全局）
 */
export function initSequences(db: SQLJsDatabase<any>, state?: EventBusState): void {
  const seqMap = state?.nextSeq ?? nextSeq;
  try {
    const rows = (db as any).select({ conversationId: activityEvents.conversationId, seq: activityEvents.seq })
      .from(activityEvents).all() as { conversationId: string; seq: number }[];
    for (const r of rows) {
      seqMap.set(r.conversationId, Math.max(seqMap.get(r.conversationId) ?? 0, r.seq));
    }
  } catch { /* 表不存在时静默（冷启动） */ }
}

/**
 * 写单行（原始事件或打包行）
 * P1-08 修复：不再静默吞错 —— critical 事件写失败抛错（调用方补偿/标记 run 失败），
 * 非 critical 事件记录 error 级日志并继续（best effort）。
 */
export function createWriteRow(db: SQLJsDatabase<any>, saveDbCb?: () => void) {
  return (row: {
    id: string;
    conversationId: string;
    taskId: string;
    agentId: string;
    agentType: string;
    eventType: string;
    seq: number;
    status?: string | null;
    content?: string | null;
    tool?: string | null;
    parentEventId?: string | null;
    metadata?: Record<string, unknown> | null;
    createdAt: string;
    /** P1-08: 关键生命周期事件（task.started/run.started 等）写失败必须显式暴露 */
    critical?: boolean;
  }): void => {
    const isCritical = row.critical === true;
    try {
      (db as any).insert(activityEvents).values({
        id: row.id,
        conversationId: row.conversationId,
        taskId: row.taskId,
        agentId: row.agentId,
        agentType: row.agentType,
        eventType: row.eventType,
        seq: row.seq,
        status: row.status ?? null,
        content: row.content ?? null,
        tool: row.tool ?? null,
        parentEventId: row.parentEventId ?? null,
        metadata: row.metadata ? JSON.stringify(row.metadata) : null,
        createdAt: row.createdAt,
      }).run();
      saveDbCb?.();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      if (isCritical) {
        // 关键事件：fail fast + 显式暴露（调用方负责补偿）
        console.error(`[EventBus] 关键事件落库失败（${row.eventType} seq=${row.seq}）:`, msg);
        throw new Error(`EventBus critical write failed: ${row.eventType} — ${msg}`);
      }
      // 非关键事件：error 级日志 + 继续（best effort）
      console.error(`[EventBus] 事件落库失败（${row.eventType} seq=${row.seq}）:`, msg);
    }
  };
}

/** 持久化单个事件 */
export function createPersist(writeRow: (row: any) => void) {
  return (env: AgentEventEnvelope, opts?: { critical?: boolean }): void => {
    writeRow({
      id: env.eventId,
      conversationId: env.sessionId,
      taskId: env.taskId,
      agentId: env.agentId,
      agentType: env.agentType,
      eventType: env.eventType,
      seq: env.seq,
      status: env.status ?? null,
      content: env.content ?? null,
      tool: env.tool ? JSON.stringify(env.tool) : null,
      parentEventId: env.parentEventId ?? null,
      metadata: env.metadata ?? null,
      createdAt: env.timestamp,
      critical: opts?.critical,
    });
  };
}

// 设置 chunk-packer 的写入函数
setWritePackedRow(createWriteRow({} as any, undefined)); // 临时占位，实际在 createEventBus 中设置

export { flushPacks, unpackRow, isPackable, queuePack, shouldFlushPack, PACKABLE_EVENT_TYPES, PACK_MAX_CHUNKS, PACK_MAX_BYTES, PackedChunk, EventEmitOptions, ActivityEventRow, rowToEnvelope, nextSeq, getNextSeq, pendingPacks };