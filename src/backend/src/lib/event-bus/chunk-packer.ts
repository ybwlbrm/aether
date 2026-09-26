import { pendingPacks, PackedChunk, shouldFlushPack, isPackable, queuePack, getNextSeq, type EventBusState } from './types.js';
import type { AgentEventType, AgentEventEnvelope, EventStatus, ToolEventPayload } from '@pacc/shared';

/** 冲刷某会话某类型的打包缓冲为一行（存储行 ≠ 会话事件；回放时解包）（P1-07: 实例状态） */
export function flushPacks(sessionId: string, stopType?: AgentEventType, state?: EventBusState): void {
  const packMap = state?.pendingPacks ?? pendingPacks;
  const byType = packMap.get(sessionId);
  if (!byType) return;
  let finished = false;
  for (const [type, chunks] of Array.from(byType.entries())) {
    if (finished) break;
    if (stopType && type === stopType) continue; // 当前类型不冲刷（由 emit 继续聚合）
    if (chunks.length === 0) { byType.delete(type); continue; }
    // P1-09: 用首 chunk（打包行代表事件族）的归属元数据，不再硬编码 ''/main/conversation
    const first = chunks[0];
    if (chunks.length === 1) {
      // 单条无需打包，原样写
      const c = chunks[0];
      writePackedRow({
        id: c.eventId,
        conversationId: sessionId,
        taskId: c.taskId ?? (first.taskId as string) ?? '',
        agentId: c.agentId ?? 'main',
        agentType: c.agentType ?? 'conversation',
        eventType: type,
        seq: c.seq,
        content: c.content,
        metadata: c.metadata,
        createdAt: c.createdAt,
        parentEventId: c.parentEventId,
      });
    } else {
      // 多天打包：metadata.packedChunks 保留每条的完整信封，取最后 seq 为行 seq
      writePackedRow({
        id: `pack-${type}-${chunks[0].eventId}`,
        conversationId: sessionId,
        taskId: first.taskId ?? '',
        agentId: first.agentId ?? 'main',
        agentType: first.agentType ?? 'conversation',
        eventType: type,
        seq: chunks[chunks.length - 1].seq,
        content: null,
        metadata: { packedChunks: chunks },
        createdAt: chunks[0].createdAt,
      });
    }
    byType.delete(type);
    if (stopType) finished = true;
  }
  if (byType.size === 0) packMap.delete(sessionId);
}

/** 解包：打包行 → 完整事件序列；普通行 → 单条 */
export function unpackRow(row: {
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
}): AgentEventEnvelope[] {
  let meta: Record<string, unknown> | null = null;
  if (row.metadata) {
    try { meta = JSON.parse(row.metadata) as Record<string, unknown>; } catch { meta = null; }
  }
  const chunks = meta?.packedChunks as PackedChunk[] | undefined;
  if (Array.isArray(chunks) && chunks.length > 0) {
    // P1-09 修复：从每个 chunk 恢复完整归属（agentId/agentType/taskId/parentEventId/metadata），
    // 而不是统一回退到 row 上的 ''/main/conversation —— 复杂多 Agent 场景事件归属不再错乱；
    // 老数据（chunk 无归属字段）回退到 row 值保持兼容。
    return chunks.map(c => ({
      eventId: c.eventId,
      sessionId: row.conversationId,
      taskId: c.taskId ?? (row.taskId || c.eventId),
      agentId: c.agentId ?? row.agentId,
      agentType: c.agentType ?? row.agentType,
      eventType: row.eventType as AgentEventType,
      timestamp: c.createdAt,
      seq: c.seq,
      content: c.content,
      ...(c.parentEventId ? { parentEventId: c.parentEventId } : {}),
      ...(c.metadata ? { metadata: c.metadata } : {}),
    }));
  }
  // 这里需要导入 rowToEnvelope，但为了避免循环依赖，我们直接内联
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
  return [env];
}

// 这里需要 writeRow 函数，但为了避免循环依赖，我们将在 persistence.ts 中定义
// 这里先声明类型，实际实现由 persistence.ts 提供
interface PackedRow {
  id: string;
  conversationId: string;
  taskId: string;
  agentId: string;
  agentType: string;
  eventType: string;
  seq: number;
  content?: string | null;
  parentEventId?: string | null;
  metadata?: Record<string, unknown> | null;
  createdAt: string;
}

let writePackedRow: (row: PackedRow) => void = () => {};

// 供 persistence.ts 调用设置实际的写入函数
export function setWritePackedRow(fn: (row: PackedRow) => void): void {
  writePackedRow = fn;
}

// Re-export symbols from types.ts for bus-core.ts
export { isPackable, queuePack, shouldFlushPack, getNextSeq, pendingPacks };