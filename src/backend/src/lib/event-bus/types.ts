import type { AgentEventEnvelope, AgentEventType, EventStatus, ToolEventPayload } from '@pacc/shared';

/** 会话内下一序号 */
export const nextSeq = new Map<string, number>();

export function getNextSeq(sessionId: string): number {
  const next = (nextSeq.get(sessionId) ?? 0) + 1;
  nextSeq.set(sessionId, next);
  return next;
}

export interface EventEmitOptions {
  /** 覆盖会话内序号（重放/补发场景） */
  seq?: number;
  /** 是否也落库（默认 true；纯展示类事件可跳过） */
  persist?: boolean;
}

export interface ActivityEventRow {
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
  metadata?: string | null;
  createdAt: string;
}

/** chunk-rows：可打包的高频 delta 事件类型（对齐 harness 的 running-pack 语义） */
export const PACKABLE_EVENT_TYPES = new Set<AgentEventType>([
  'agent.reasoning.delta',
  'agent.message.delta',
  'agent.output.delta',
]);

/** 打包行阈值：单包最多 96 条或 24KB 内容 */
export const PACK_MAX_CHUNKS = 96;
export const PACK_MAX_BYTES = 24 * 1024;

/** 待打包缓冲：sessionId -> type -> chunks */
export const pendingPacks = new Map<string, Map<string, Array<{ seq: number; eventId: string; content: string; createdAt: string }>>>();

export interface PackedChunk {
  seq: number;
  eventId: string;
  content: string;
  createdAt: string;
}

export interface EventBus {
  /** 发射一个事件：内置 envelope 赋值 + 序号分配 + SSE 推送 + 落库 */
  emit(
    sessionId: string,
    eventType: AgentEventType,
    fields?: Partial<Omit<AgentEventEnvelope, 'eventId' | 'sessionId' | 'eventType' | 'seq' | 'timestamp'>>,
    options?: EventEmitOptions,
  ): AgentEventEnvelope;
  /** 读取某会话的全部事件（按 seq 升序） */
  listEvents(sessionId: string): AgentEventEnvelope[];
  /** 回放某会话 afterSeq 之后的事件 */
  listEventsAfter(sessionId: string, afterSeq: number, limit?: number): AgentEventEnvelope[];
}

/** 判断事件是否应聚合打包 */
export function isPackable(type: AgentEventType, persist: boolean): boolean {
  return persist && PACKABLE_EVENT_TYPES.has(type);
}

/** 追加 chunk 到打包缓冲 */
export function queuePack(
  sessionId: string,
  type: AgentEventType,
  env: AgentEventEnvelope,
): void {
  let byType = pendingPacks.get(sessionId);
  if (!byType) { byType = new Map(); pendingPacks.set(sessionId, byType); }
  const chunks = byType.get(type) ?? [];
  chunks.push({ seq: env.seq, eventId: env.eventId, content: env.content ?? '', createdAt: env.timestamp });
  byType.set(type, chunks);
}

/** 检查某类缓冲是否达到打包阈值 */
export function shouldFlushPack(chunks: PackedChunk[]): boolean {
  const bytes = chunks.reduce((s, c) => s + c.content.length, 0);
  return chunks.length >= PACK_MAX_CHUNKS || bytes >= PACK_MAX_BYTES;
}

/**
 * 把 DB 行转换为 AgentEventEnvelope（用于回放）
 */
export function rowToEnvelope(row: ActivityEventRow): AgentEventEnvelope {
  const env: AgentEventEnvelope = {
    eventId: row.id,
    sessionId: row.conversationId,
    taskId: row.taskId,
    agentId: row.agentId,
    agentType: row.agentType,
    eventType: row.eventType as AgentEventType,
    timestamp: row.createdAt,
    seq: row.seq,
  };
  if (row.status) env.status = row.status as EventStatus;
  if (row.content != null) env.content = row.content;
  if (row.tool) {
    try { env.tool = JSON.parse(row.tool) as ToolEventPayload; } catch { /* 忽略坏 JSON */ }
  }
  if (row.parentEventId) env.parentEventId = row.parentEventId;
  if (row.metadata) {
    try { env.metadata = JSON.parse(row.metadata) as Record<string, unknown>; } catch { /* 忽略坏 JSON */ }
  }
  return env;
}