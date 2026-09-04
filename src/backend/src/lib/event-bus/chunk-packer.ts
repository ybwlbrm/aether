import { pendingPacks, PackedChunk, shouldFlushPack, isPackable, queuePack, getNextSeq } from './types.js';
import type { AgentEventType, AgentEventEnvelope } from '@pacc/shared';

/** 冲刷某会话某类型的打包缓冲为一行（存储行 ≠ 会话事件；回放时解包） */
export function flushPacks(sessionId: string, stopType?: AgentEventType): void {
  const byType = pendingPacks.get(sessionId);
  if (!byType) return;
  let finished = false;
  for (const [type, chunks] of Array.from(byType.entries())) {
    if (finished) break;
    if (stopType && type === stopType) continue; // 当前类型不冲刷（由 emit 继续聚合）
    if (chunks.length === 0) { byType.delete(type); continue; }
    if (chunks.length === 1) {
      // 单条无需打包，原样写
      const c = chunks[0];
      writePackedRow({
        id: c.eventId,
        conversationId: sessionId,
        taskId: '',
        agentId: 'main',
        agentType: 'conversation',
        eventType: type,
        seq: c.seq,
        content: c.content,
        metadata: null,
        createdAt: c.createdAt,
      });
    } else {
      // 多天打包：metadata.packedChunks 保留每条的 seq/eventId/content，取最后 seq 为行 seq
      writePackedRow({
        id: `pack-${type}-${chunks[0].eventId}`,
        conversationId: sessionId,
        taskId: '',
        agentId: 'main',
        agentType: 'conversation',
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
  if (byType.size === 0) pendingPacks.delete(sessionId);
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
    return chunks.map(c => ({
      eventId: c.eventId,
      sessionId: row.conversationId,
      taskId: row.taskId || c.eventId,
      agentId: row.agentId,
      agentType: row.agentType,
      eventType: row.eventType as AgentEventType,
      timestamp: c.createdAt,
      seq: c.seq,
      content: c.content,
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
  if (row.status) env.status = row.status as any;
  if (row.content != null) env.content = row.content;
  if (row.tool) {
    try { env.tool = JSON.parse(row.tool) as any; } catch { /* 忽略坏 JSON */ }
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