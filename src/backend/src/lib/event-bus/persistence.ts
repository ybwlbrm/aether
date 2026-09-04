import { randomUUID } from 'node:crypto';
import {
  activityEvents,
} from '../../db/schema/index.js';
import type { SQLJsDatabase } from 'drizzle-orm/sql-js';
import { eq } from 'drizzle-orm';
import type { AgentEventEnvelope, AgentEventType } from '@pacc/shared';
import { flushPacks, setWritePackedRow, unpackRow } from './chunk-packer.js';
import { rowToEnvelope, nextSeq, getNextSeq, pendingPacks, isPackable, queuePack, shouldFlushPack, PACKABLE_EVENT_TYPES, PACK_MAX_CHUNKS, PACK_MAX_BYTES, PackedChunk, EventEmitOptions, ActivityEventRow } from './types.js';

/** 初始化序号：从 DB 现有最大 seq 继续（进程重启后不重复） */
export function initSequences(db: SQLJsDatabase<any>): void {
  try {
    const rows = (db as any).select({ conversationId: activityEvents.conversationId, seq: activityEvents.seq })
      .from(activityEvents).all() as { conversationId: string; seq: number }[];
    const maxByConv = new Map<string, number>();
    for (const r of rows) {
      maxByConv.set(r.conversationId, Math.max(maxByConv.get(r.conversationId) ?? 0, r.seq));
    }
    for (const [convId, max] of maxByConv) {
      nextSeq.set(convId, Math.max(nextSeq.get(convId) ?? 0, max));
    }
  } catch { /* 表不存在时静默（冷启动） */ }
}

/** 写单行（原始事件或打包行） */
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
  }): void => {
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
      console.error('[EventBus] 事件落库失败:', e instanceof Error ? e.message : String(e));
    }
  };
}

/** 持久化单个事件 */
export function createPersist(writeRow: (row: any) => void) {
  return (env: AgentEventEnvelope): void => {
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
    });
  };
}

// 设置 chunk-packer 的写入函数
setWritePackedRow(createWriteRow({} as any, undefined)); // 临时占位，实际在 createEventBus 中设置

export { flushPacks, unpackRow, isPackable, queuePack, shouldFlushPack, PACKABLE_EVENT_TYPES, PACK_MAX_CHUNKS, PACK_MAX_BYTES, PackedChunk, EventEmitOptions, ActivityEventRow, rowToEnvelope, nextSeq, getNextSeq, pendingPacks };