import { randomUUID } from 'node:crypto';
import type { AgentEventEnvelope, AgentEventType } from '@pacc/shared';
import { getNextSeq } from './types.js';
import type { EventBus } from './types.js';

/** 便捷工厂：无 DB 时的内存版（测试/预览使用） */
export function createMemoryEventBus(sseSend?: (event: string, data: string) => void): EventBus {
  const events = new Map<string, AgentEventEnvelope[]>();
  const memoryBus: EventBus = {
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
      if (sseSend) sseSend(eventType, JSON.stringify(env));
      const list = events.get(sessionId) ?? [];
      if (!events.has(sessionId)) events.set(sessionId, list);
      if (!list.some(e => e.eventId === env.eventId)) list.push(env);
      return env;
    },
    listEvents(sessionId) {
      return [...(events.get(sessionId) ?? [])].sort((a, b) => a.seq - b.seq);
    },
    listEventsAfter(sessionId, afterSeq, limit = 1000) {
      return memoryBus.listEvents(sessionId).filter(e => e.seq > afterSeq).slice(0, limit);
    },
  };
  return memoryBus;
}