/**
 * Aether 2.0 Run Events（P3-06）— 断线恢复 / 增量回放端点
 *
 * GET /api/runs/:runId/events?afterSeq=N&limit=1000
 *
 * 返回该 run 在 seq > afterSeq 之后的全部 v2 事件（升序）。配合 SSE 的
 * Last-Event-ID（即 event.seq），客户端断线后可从最后收到的 seq 续传，
 * 保证不丢、不重复。limit 默认 1000，最大 5000。
 */
import type { FastifyInstance } from 'fastify';
import type { BackendConfig } from '../../config/index.js';
import { getDb } from '../../db/client.js';
import { events, runs } from '../../db/schema/index.js';
import { and, eq, gt } from 'drizzle-orm';
import * as schema from '../../db/schema/index.js';
import type { SQLJsDatabase } from 'drizzle-orm/sql-js';
import { AppError } from '@pacc/shared';

type Db = SQLJsDatabase<typeof schema>;

function toBoundedInt(raw: string | undefined, fallback: number, max: number | null): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return fallback;
  return max === null ? n : Math.min(n, max);
}

export function registerRunEventsRoutes(app: FastifyInstance, _config: BackendConfig): void {
  app.get('/api/runs/:runId/events', {
    schema: {
      description: '按 seq 增量读取某 run 的 v2 事件（断线恢复 / 回放）',
      tags: ['Runs'],
      params: { type: 'object', properties: { runId: { type: 'string' } }, required: ['runId'] },
      querystring: {
        type: 'object',
        properties: {
          afterSeq: { type: 'string' },
          limit: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const db: Db = getDb();
    const { runId } = request.params as { runId: string };
    const query = request.query as { afterSeq?: string | number; limit?: string | number };

    // 404：run 不存在
    const run = db.select({ id: runs.id }).from(runs).where(eq(runs.id, runId)).get();
    if (!run) {
      return reply.code(404).send({ error: { message: `run ${runId} 未找到`, code: 'RUN_NOT_FOUND' } });
    }

    const afterSeq = toBoundedInt(String(query.afterSeq ?? ''), 0, null);
    const limit = toBoundedInt(String(query.limit ?? ''), 1000, 5000);

    const rows = db
      .select({
        id: events.id,
        runId: events.runId,
        seq: events.seq,
        eventType: events.eventType,
        eventVersion: events.eventVersion,
        payload: events.payload,
        metadata: events.metadata,
        createdAt: events.createdAt,
      })
      .from(events)
      .where(and(eq(events.runId, runId), gt(events.seq, afterSeq)))
      .orderBy(events.seq)
      .limit(limit)
      .all();

    // payload 是完整 AgentEvent v2 的 JSON —— 直接透传事件对象
    const parsedEvents = rows
      .map((row) => {
        try {
          return JSON.parse(row.payload) as unknown;
        } catch {
          return null;
        }
      })
      .filter((e): e is object => e !== null && typeof e === 'object');

    return { events: parsedEvents, nextSeq: parsedEvents.length > 0 ? (parsedEvents.at(-1) as { seq?: number }).seq ?? afterSeq : afterSeq };
  });
}