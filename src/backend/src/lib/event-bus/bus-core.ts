import { randomUUID } from 'node:crypto';
import {
  activityEvents,
} from '../../db/schema/index.js';
import type { SQLJsDatabase } from 'drizzle-orm/sql-js';
import type { AgentEventEnvelope, AgentEventType } from '@pacc/shared';
import { eq } from 'drizzle-orm';
import { initSequences, createWriteRow, createPersist } from './persistence.js';
import { flushPacks, unpackRow, setWritePackedRow, isPackable, queuePack, shouldFlushPack, getNextSeq } from './chunk-packer.js';
import { createEventBusState, type EventBusState, type EventBus } from './types.js';

export function createEventBus(
  db: SQLJsDatabase<any>,
  sseSend?: (event: string, data: string) => void,
  saveDbCb?: () => void,
): EventBus {
  // P1-07 收口：实例状态（SequenceAllocator + EventBuffer 绑定到实例，
  // 不再使用模块级全局 nextSeq/pendingPacks —— 多 DB / 热重载 / 测试重置不残留）
  const state: EventBusState = createEventBusState();

  // 初始化序号（读 DB 现有最大 seq，避免重启后重复）
  initSequences(db, state);

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
        seq: options.seq ?? getNextSeq(sessionId, state),
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

      // P1-08: critical 事件（关键生命周期）写失败必须显式抛错——调用方补偿
      const critical = options.critical === true;
      // chunk-rows：高频 delta 聚合打包；非打包类型先冲洗该类缓冲再原样落库
      if (isPackable(eventType, true)) {
        queuePack(sessionId, eventType, env, state);
        const byType = state.pendingPacks.get(sessionId);
        const chunks = byType?.get(eventType) ?? [];
        if (shouldFlushPack(chunks)) flushPacks(sessionId, eventType, state);
      } else {
        flushPacks(sessionId, undefined, state);
        persist(env, { critical });
        if (critical) {
          // critical 事件写入后立即落盘（防丢失）
          try { saveDbCb?.(); } catch { /* 落盘失败由 db/client 日志暴露 */ }
        }
      }
      return env;
    },

    listEvents(sessionId) {
      // 先冲刷该会话未落库的打包缓冲（保证数据完整，单条/批量均落库）
      flushPacks(sessionId, undefined, state);
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
      flushPacks(sessionId, undefined, state);
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