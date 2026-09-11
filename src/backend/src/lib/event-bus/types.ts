import type { AgentEventEnvelope, AgentEventType, EventStatus, ToolEventPayload } from '@pacc/shared';

/**
 * P1-07 修复：EventBus 状态实例化。
 * 旧实现用模块级全局 Map（nextSeq/pendingPacks），在数据库重建、测试环境
 * 重置、多 DB、热重载时会残留旧内存状态。现在 createEventBus 创建自己的
 * EventBusState（SequenceAllocator + EventBuffer 绑定到实例），
 * 模块级默认状态仅保留给测试/兼容路径。
 */
export interface EventBusState {
  /** 会话内下一序号分配器（绑定实例） */
  nextSeq: Map<string, number>;
  /** 待打包缓冲：sessionId -> type -> chunks（绑定实例） */
  pendingPacks: Map<string, Map<string, PackedChunk[]>>;
}

/** 创建全新实例状态 */
export function createEventBusState(): EventBusState {
  return {
    nextSeq: new Map<string, number>(),
    pendingPacks: new Map<string, Map<string, PackedChunk[]>>(),
  };
}

/** 模块级默认状态（兼容旧测试/直接导入；生产走实例状态） */
const defaultState = createEventBusState();

/** 会话内下一序号（P1-07: 可传入实例状态，缺省用模块级兼容） */
export const nextSeq = defaultState.nextSeq;

export function getNextSeq(sessionId: string, state?: EventBusState): number {
  const seqMap = state?.nextSeq ?? nextSeq;
  const next = (seqMap.get(sessionId) ?? 0) + 1;
  seqMap.set(sessionId, next);
  return next;
}

export interface EventEmitOptions {
  /** 覆盖会话内序号（重放/补发场景） */
  seq?: number;
  /** 是否也落库（默认 true；纯展示类事件可跳过） */
  persist?: boolean;
  /** P1-08: 关键生命周期事件（task.started 等）—— 写失败显式抛错，调用方补偿 */
  critical?: boolean;
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

/** 待打包缓冲：sessionId -> type -> chunks（P1-07: 生产走实例状态；此导出兼容旧测试） */
export const pendingPacks = defaultState.pendingPacks;

/**
 * P1-09 修复：PackedChunk 保存完整最小 Event Envelope。
 * 旧实现仅保留 seq/eventId/content/createdAt，flushPacks 解包时会把
 * 所有事件恢复为 taskId=''/agentId='main'/agentType='conversation'，
 * 复杂多 Agent 场景下事件归属错误。现在保留 agentId/agentType/taskId/
 * parentEventId/metadata，解包即还原归属。
 */
export interface PackedChunk {
  seq: number;
  eventId: string;
  content: string;
  createdAt: string;
  /** P1-09: 事件归属元数据（多 Agent 场景关键） */
  agentId?: string;
  agentType?: string;
  taskId?: string;
  parentEventId?: string;
  metadata?: Record<string, unknown> | null;
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

/** 追加 chunk 到打包缓冲（P1-07: 可传入实例状态） */
export function queuePack(
  sessionId: string,
  type: AgentEventType,
  env: AgentEventEnvelope,
  state?: EventBusState,
): void {
  const packMap = state?.pendingPacks ?? pendingPacks;
  let byType = packMap.get(sessionId);
  if (!byType) { byType = new Map(); packMap.set(sessionId, byType); }
  const chunks = byType.get(type) ?? [];
  chunks.push({
    seq: env.seq,
    eventId: env.eventId,
    content: env.content ?? '',
    createdAt: env.timestamp,
    // P1-09: 保留完整最小 Event Envelope（归属元数据）
    agentId: env.agentId,
    agentType: env.agentType,
    taskId: env.taskId,
    parentEventId: env.parentEventId,
    metadata: env.metadata,
  });
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