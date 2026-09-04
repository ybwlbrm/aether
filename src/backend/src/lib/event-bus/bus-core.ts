import { randomUUID } from 'node:crypto';
import {
  activityEvents,
} from '../../db/schema/index.js';
import type { SQLJsDatabase } from 'drizzle-orm/sql-js';
import type { AgentEventEnvelope, AgentEventType } from '@pacc/shared';
import { eq } from 'drizzle-orm';
import { initSequences, createWriteRow, createPersist } from './persistence.js';
import { flushPacks, unpackRow, setWritePackedRow, isPackable, queuePack, shouldFlushPack, getNextSeq, pendingPacks } from './chunk-packer.js';
import type { EventBus } from './types.js';

export function createEventBus(
  db: SQLJsDatabase<any>,
  sseSend?: (event: string, data: string) => void,
  saveDbCb?: () => void,
): EventBus {
  // 初始化序号
  initSequences(db);

  // 创建写入函数
  const writeRow = createWriteRow(db, saveDbCb);
  const persist = createPersist(writeRow);

  // 更新 chunk-packer 的写入函数
  setWritePackedRow(writeRow);

  return {
    emit(sessionId, eventType, fields = {}, options = {}) {
      const now = new Date().toISOString();
      const env: AgentEventEnvelope = {
        eventId: randomUUID(),
        sessionId,
        taskId: fields.taskId ?? sessionId,
        agentId: fields.agentId ?? 'main',
        agentType: fields.agentType ?? 'conversation',
        eventType,
        timestamp: now,
        seq: options.seq ?? getNextSeq(sessionId),
        ...fields,
      };
      // SSE 事件名 = eventType（前端判别联合直接消费）— 打包只在落库层，实时性不受影响
      if (sseSend) {
        try {
          sseSend(eventType, JSON.stringify(env));
        } catch { /* 客户端已断开 */ }
      }
      const shouldPersist = options.persist !== false;
      if (!shouldPersist) return env;

      // chunk-rows：高频 delta 聚合打包；非打包类型先冲洗该类缓冲再原样落库
      if (isPackable(eventType, true)) {
        queuePack(sessionId, eventType, env);
        const byType = pendingPacks.get(sessionId);
        const chunks = byType?.get(eventType) ?? [];
        if (shouldFlushPack(chunks)) flushPacks(sessionId, eventType);
      } else {
        flushPacks(sessionId);
        persist(env);
      }
      return env;
    },

    listEvents(sessionId) {
      // 先冲刷该会话未落库的打包缓冲（保证数据完整，单条/批量均落库）
      flushPacks(sessionId);
      try {
        const rows = (db as any).select().from(activityEvents)
          .where(eq(activityEvents.conversationId, sessionId))
          .orderBy(activityEvents.seq).all() as any[];
        return rows
          .flatMap(unpackRow)
          .sort((a, b) => a.seq - b.seq);
      } catch {
        return [];
      }
    },

    listEventsAfter(sessionId, afterSeq, limit = 1000) {
      // 读前冲刷，避免缓冲中事件被 afterSeq 增量读取遗漏
      flushPacks(sessionId);
      try {
        const rows = (db as any).select().from(activityEvents)
          .where(eq(activityEvents.conversationId, sessionId))
          .orderBy(activityEvents.seq)
          .all() as any[];
        return rows
          .flatMap(unpackRow)
          .filter(r => r.seq > afterSeq)
          .slice(0, limit);
      } catch {
        return [];
      }
    },
  };
}