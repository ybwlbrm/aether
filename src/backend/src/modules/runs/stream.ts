/**
 * Aether 2.0 Run SSE Stream（P3-05/P3-06）— v2 事件实时流 + 断线恢复
 *
 * GET /api/runs/:runId/stream
 *
 * Server-Sent Events 端点，把某 run 的 v2 AgentEvent 实时推送给客户端：
 * - 连接时读取 `Last-Event-ID` HTTP header（即最后收到的 seq），从 afterSeq
 *   续传历史事件（不丢、不重复），然后实时推送后续事件。
 * - SSE 帧格式：`event: <type>\ndata: <json>\nid: <seq>\n\n`（与 core 的
 *   SseTransport 一致，id=seq 供 Last-Event-ID 重连）。
 * - 每 30s 发一次 keep-alive 注释行防止代理断连。
 *
 * 实现说明：后端是全内存 sql.js，事件在进程内写入 events 表。端点用
 * 固定间隔轮询新事件（seq 游标推进）——足够满足本地优先的个人场景，
 * 也是当前架构下与 SQLite 同步 API 最匹配的实时方案。
 */

import type { FastifyInstance } from 'fastify';
import type { BackendConfig } from '../../config/index.js';
import { getDb } from '../../db/client.js';
import { events, runs } from '../../db/schema/index.js';
import { and, eq, gt } from 'drizzle-orm';
import * as schema from '../../db/schema/index.js';
import type { SQLJsDatabase } from 'drizzle-orm/sql-js';
import { formatSseEvent } from '../../core/events/index.js';
import type { AgentEvent } from '@pacc/shared';

type Db = SQLJsDatabase<typeof schema>;

/** Poll interval between event fetches (ms) */
const POLL_MS = 1000;
/** Keep-alive comment every N polls (30s) */
const HEARTBEAT_EVERY = 30;

function toSeq(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return fallback;
  return n;
}

/** Read events with seq > afterSeq (raw v2 payload JSONs) — exported for tests */
export function readEvents(db: Db, runId: string, afterSeq: number): Array<{ seq: number; type: string; payload: string }> {
  const rows = db
    .select({ seq: events.seq, eventType: events.eventType, payload: events.payload })
    .from(events)
    .where(and(eq(events.runId, runId), gt(events.seq, afterSeq)))
    .orderBy(events.seq)
    .all();
  return rows.map((r) => ({ seq: r.seq, type: r.eventType, payload: r.payload }));
}

export function registerRunStreamRoutes(app: FastifyInstance, _config: BackendConfig): void {
  app.get('/api/runs/:runId/stream', {
    schema: {
      description: 'v2 事件实时 SSE 流（支持 Last-Event-ID 断线恢复）',
      tags: ['Runs'],
      params: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] },
      headers: {
        type: 'object',
        properties: {
          'last-event-id': { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const db: Db = getDb();
    const { runId } = request.params as { runId: string };

    // 404：run 不存在
    const run = db.select({ id: runs.id }).from(runs).where(eq(runs.id, runId)).get();
    if (!run) {
      return reply.code(404).send({ error: { message: `run ${runId} 未找到`, code: 'RUN_NOT_FOUND' } });
    }

    // SSE 响应头
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    // Last-Event-ID header — 断线恢复的起点（不丢、不重复）
    const headers = request.headers as Record<string, string | undefined>;
    const lastEventId = headers['last-event-id'];
    let cursor = toSeq(lastEventId, 0);
    void lastEventId;

    // 立即续传历史事件（seq > cursor）
    try {
      for (const row of readEvents(db, runId, cursor)) {
        try {
          const event = JSON.parse(row.payload) as AgentEvent & { type: string };
          reply.raw.write(formatSseEvent(event));
          cursor = row.seq;
        } catch {
          // 跳过坏 payload
        }
      }
    } catch (err) {
      console.warn('[RunStream] initial replay failed:', err instanceof Error ? err.message : String(err));
    }

    // 轮询新事件 + 心跳
    const replyRaw = reply.raw;
    let pollCount = 0;
    const timer = setInterval(() => {
      // 客户端断开 → 清理
      const socket = (replyRaw as unknown as { socket?: { destroyed?: boolean } }).socket;
      if (socket?.destroyed) {
        clearInterval(timer);
        return;
      }

      try {
        const fresh = readEvents(db, runId, cursor);
        for (const row of fresh) {
          try {
            const event = JSON.parse(row.payload) as AgentEvent & { type: string };
            replyRaw.write(formatSseEvent(event));
            cursor = row.seq;
          } catch {
            // 跳过坏 payload
          }
        }
      } catch (err) {
        console.warn('[RunStream] poll failed:', err instanceof Error ? err.message : String(err));
      }

      // 心跳：每 30 次轮询（30s）发一个注释行保活
      pollCount += 1;
      if (pollCount % HEARTBEAT_EVERY === 0) {
        try { replyRaw.write(': keep-alive\n\n'); } catch { /* 客户端可能已断开 */ }
      }
    }, POLL_MS);

    // 客户端关闭时清理定时器
    request.raw.on('close', () => clearInterval(timer));
    return reply;
  });
}