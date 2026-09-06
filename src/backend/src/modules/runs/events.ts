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
import { runs } from '../../db/schema/index.js';
import { eq } from 'drizzle-orm';
import * as schema from '../../db/schema/index.js';
import type { SQLJsDatabase } from 'drizzle-orm/sql-js';
import { SqliteEventStore } from '../../core/events/index.js';

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

    // P0-05: route through the store so packed rows are expanded and the
    // result is filtered by LOGICAL seq (sub-events ≤ afterSeq excluded).
    const store = new SqliteEventStore(getDb());
    const eventsList = await store.listAfter(runId, afterSeq, limit);

    return {
      events: eventsList,
      nextSeq: eventsList.length > 0 ? (eventsList.at(-1)?.seq ?? afterSeq) : afterSeq,
    };
  });
}