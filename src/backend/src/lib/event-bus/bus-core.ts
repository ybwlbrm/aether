/**
 * Legacy EventBus 核心（activity_events 写入路径）— AEX-P0-010 双写关系说明
 *
 * ── 事实来源（canonical source of truth）─────────────────────────────
 * `events` 表（v2 EventStore，src/backend/src/core/events）是**唯一事实源**。
 * 关键 Run 生命周期迁移（created → running → completed/failed/cancelled）
 * 必须以 events 表 + runs 行状态机为准；activity_events 只是兼容读模型。
 *
 * ── 为什么现在还是「双写」────────────────────────────────────────────
 * 现状：编排/工作流等模块在同一个分支里同时调用
 *   eventBus.emit(...)      → 写 activity_events（legacy 投影）
 *   emitV2Event(...)        → 写 events（canonical）
 * 两张表的行由同一次业务决策产生，理论上应完全一致；但 legacy 表缺少
 * runId/seq 唯一约束、缺少 v2 判别联合类型，因此**不得**从 activity_events
 * 反推 Run 状态或事件轨迹。
 *
 * ── 收敛方向（本轮不做，禁止新增写入）───────────────────────────────
 * 收敛路径 = 「只写 events + 由 projector 投影出 activity_events」：
 *   src/backend/src/core/events/event-projector.ts 即为该投影器
 *   （当前生产零引用，属待接线状态）。
 * 因此本文件不做任何行为变更，只固化约定：
 *   1. 新代码禁止直接 emit legacy 事件（见下方 emit() 的 @deprecated 契约）；
 *   2. 关键状态迁移只依赖 events 表 + RunLifecycleManager；
 *   3. 任何新的 activity_events 写入点都必须先评估能否删掉，而不是再加一处。
 */

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
    /**
     * @deprecated 整改计划第 6 章（P1）：legacy EventBus 仅保留为「只读适配器」边界。
     * 新业务禁止直接 emit legacy 事件 —— 统一走 v2 EventStore（src/backend/src/core/events，
     * events 表 + runId/seq 唯一约束 + 单一 projector）。本方法仅供既有模块兼容使用，
     * 所有 SSE/replay/activity/workflow/sync 的读写已收敛到 v2 路径；此处保留双写
     * 仅为平滑过渡（legacy activity_events 表），不得作为新代码的写入入口。
     */
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