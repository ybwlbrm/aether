/**
 * Aether 2.0 Run API（P2）— Run 生命周期与查询
 *
 * 状态机：created → running ⇄ waiting → completed | failed | cancelled | interrupted（终态吸收）
 * 存储：drizzle sql-js 同步 API；每次写入后 saveDb(config) 触发 debounce 落盘。
 * metadata 以 JSON 文本落库（metadata 列），响应时统一经 rowToJson 解析为对象。
 */
import type { FastifyInstance } from 'fastify';
import type { BackendConfig } from '../../config/index.js';
import { getDb, saveDb } from '../../db/client.js';
import { runs } from '../../db/schema/index.js';
import { and, desc, eq, sql, type SQL } from 'drizzle-orm';
import type { SQLJsDatabase } from 'drizzle-orm/sql-js';
import * as schema from '../../db/schema/index.js';
import { AppError } from '@pacc/shared';
import { randomUUID } from 'node:crypto';
// P0-01/P0-02: Run-scoped cancellation registry
import { runCancellationRegistry } from '../../lib/run-cancellation-registry.js';

type Db = SQLJsDatabase<typeof schema>;
type RunRow = typeof runs.$inferSelect;
type RunInsert = typeof runs.$inferInsert;
type RunStatus = RunRow['status'];
type RunMode = RunRow['mode'];

const RUN_STATUSES = ['created', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'interrupted'] as const;
const RUN_MODES = ['normal', 'super', 'workflow', 'background'] as const;

function isRunStatus(value: unknown): value is RunStatus {
  return typeof value === 'string' && (RUN_STATUSES as readonly string[]).includes(value);
}

function isRunMode(value: unknown): value is RunMode {
  return typeof value === 'string' && (RUN_MODES as readonly string[]).includes(value);
}

/** metadata 列是 JSON 文本（可为 null），解析失败时回退为空对象 */
function parseMetadata(raw: string | null | undefined): Record<string, unknown> {
  if (!raw) return {};
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return {};
  }
}

/** 查询参数中的整数约束：非法/负数回退到 fallback，超过 max 时截断 */
function toBoundedInt(raw: string | undefined, fallback: number, max: number | null): number {
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 0) return fallback;
  return max === null ? n : Math.min(n, max);
}

/** 对外响应 DTO：metadata 已从 JSON 文本解析为对象 */
export interface RunDto {
  id: string;
  conversationId: string | null;
  status: RunStatus;
  mode: RunMode;
  rootAgentId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  endReason: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  error: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

function rowToJson(row: RunRow): RunDto {
  return {
    id: row.id,
    conversationId: row.conversationId,
    status: row.status,
    mode: row.mode,
    rootAgentId: row.rootAgentId ?? null,
    startedAt: row.startedAt ?? null,
    completedAt: row.completedAt ?? null,
    endReason: row.endReason ?? null,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    totalTokens: row.totalTokens,
    error: row.error ?? null,
    metadata: parseMetadata(row.metadata),
    createdAt: row.createdAt,
  };
}

const RUN_ID_PARAMS_SCHEMA = {
  type: 'object',
  properties: { runId: { type: 'string' } },
  required: ['runId'],
};

function invalidTransition(status: RunStatus, action: string): { code: string; message: string } {
  return { code: 'INVALID_TRANSITION', message: `状态 ${status} 不允许操作 ${action}（非法状态转移）` };
}

function runNotFound(id: string): { code: string; message: string } {
  return { code: 'RUN_NOT_FOUND', message: `run ${id} 未找到` };
}

/**
 * 注册 Run 管理路由（Aether 2.0 P2）
 */
export function registerRunRoutes(app: FastifyInstance, config: BackendConfig): void {
  const db = getDb();

  // POST /api/runs/recover — Crash Recovery（P1-16）
  // 后端/Electron crash 后重新启动时，把遗留的 running/waiting Run 标记为 interrupted。
  // 无活跃执行进程的 Run 不可能继续，必须进入终态而不是永久卡在 running。
  app.post('/api/runs/recover', {
    schema: {
      description: 'Crash Recovery：把遗留 running/waiting 的 Run 标记为 interrupted',
      tags: ['runs'],
    },
  }, async (_request, reply) => {
    const stale = db
      .select()
      .from(runs)
      .where(sql`${runs.status} IN ('running', 'waiting')`)
      .all();
    const now = new Date().toISOString();
    let marked = 0;
    for (const run of stale) {
      db.update(runs)
        .set({ status: 'interrupted', completedAt: now, endReason: 'crashed' })
        .where(eq(runs.id, run.id))
        .run();
      marked += 1;
    }
    if (marked > 0) saveDb(config);
    return { recovered: marked, message: marked > 0 ? `已标记 ${marked} 个崩溃遗留 Run 为 interrupted` : '无遗留 Run' };
  });

  // POST /api/runs — 创建 Run（status=created，createdAt=now）
  app.post('/api/runs', {
    schema: {
      description: '创建 Run',
      tags: ['runs'],
      body: {
        type: 'object',
        properties: {
          conversationId: { type: 'string' },
          mode: { type: 'string', enum: ['normal', 'super', 'workflow', 'background'] },
          rootAgentId: { type: 'string' },
          metadata: { type: 'object' },
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body as { conversationId?: string; mode?: unknown; rootAgentId?: string; metadata?: Record<string, unknown> };
    const id = randomUUID();
    const now = new Date().toISOString();
    const values: RunInsert = {
      id,
      status: 'created',
      mode: body.mode === undefined || !isRunMode(body.mode) ? 'normal' : body.mode,
      rootAgentId: body.rootAgentId ?? null,
      createdAt: now,
    };
    if (body.conversationId !== undefined) values.conversationId = body.conversationId;
    if (body.metadata !== undefined) values.metadata = JSON.stringify(body.metadata);
    db.insert(runs).values(values).run();
    saveDb(config);
    const created = db.select().from(runs).where(eq(runs.id, id)).get();
    if (!created) throw new Error('预期外：Run 插入后回读为空');
    return reply.code(201).send(rowToJson(created));
  });

  // 通用状态转移端点（start / pause / resume / cancel）：
  // run 不存在 → 404 RUN_NOT_FOUND；当前状态不在 allowed 内（含终态吸收）→ 409 INVALID_TRANSITION
  // after 回调（Wave0-CX）：状态转移成功后执行（如 cancel 时真正 abort 执行流）
  const registerTransition = (
    path: string,
    action: string,
    allowed: readonly RunStatus[],
    patch: (now: string) => Partial<RunInsert>,
    after?: (runId: string) => void,
  ) => {
    app.post(path, {
      schema: {
        description: `Run 状态转移：${action}`,
        tags: ['runs'],
        params: RUN_ID_PARAMS_SCHEMA,
      },
    }, async (request, reply) => {
      const { runId } = request.params as { runId: string };
      const run = db.select().from(runs).where(eq(runs.id, runId)).get();
      if (!run) return reply.code(404).send({ error: runNotFound(runId) });
      if (!allowed.includes(run.status)) {
        return reply.code(409).send({ error: invalidTransition(run.status, action) });
      }
      db.update(runs).set(patch(new Date().toISOString())).where(eq(runs.id, runId)).run();
      saveDb(config);
      const updated = db.select().from(runs).where(eq(runs.id, runId)).get();
      if (!updated) return reply.code(404).send({ error: runNotFound(runId) });
      after?.(runId);
      return rowToJson(updated);
    });
  };

  registerTransition('/api/runs/:runId/start', 'start', ['created'], (now) => ({ status: 'running', startedAt: now }));
  registerTransition('/api/runs/:runId/pause', 'pause', ['running'], () => ({ status: 'waiting' }));
  registerTransition('/api/runs/:runId/resume', 'resume', ['waiting'], () => ({ status: 'running' }));
  // Wave0-CX: cancel 除状态机转移外，真正 abort 执行流（runCancellationRegistry，幂等）
  registerTransition('/api/runs/:runId/cancel', 'cancel', ['running', 'waiting'], (now) => ({ status: 'cancelled', completedAt: now, endReason: 'cancelled' }), (runId) => {
    runCancellationRegistry.cancel(runId);
  });

  // GET /api/runs/:runId — 获取单个 Run
  app.get('/api/runs/:runId', {
    schema: {
      description: '获取 Run 详情',
      tags: ['runs'],
      params: RUN_ID_PARAMS_SCHEMA,
    },
  }, async (request, reply) => {
    const { runId } = request.params as { runId: string };
    const run = db.select().from(runs).where(eq(runs.id, runId)).get();
    if (!run) return reply.code(404).send({ error: runNotFound(runId) });
    return rowToJson(run);
  });

  // GET /api/runs — 列表（conversationId / status 过滤 + limit/offset 分页）
  app.get('/api/runs', {
    schema: {
      description: '列出 Runs',
      tags: ['runs'],
      querystring: {
        type: 'object',
        properties: {
          conversationId: { type: 'string' },
          status: { type: 'string' },
          limit: { type: 'string' },
          offset: { type: 'string' },
        },
      },
    },
  }, async (request) => {
    const query = request.query as { conversationId?: string; status?: string; limit?: string; offset?: string };
    const statusFilter = query.status;
    if (statusFilter !== undefined && !isRunStatus(statusFilter)) {
      throw AppError.validation(`无效的 status: ${statusFilter}`);
    }
    const limit = toBoundedInt(query.limit, 50, 200);
    const offset = toBoundedInt(query.offset, 0, null);

    const conditions: SQL[] = [];
    if (query.conversationId !== undefined) conditions.push(eq(runs.conversationId, query.conversationId));
    if (statusFilter !== undefined) conditions.push(eq(runs.status, statusFilter));
    const where = conditions.length > 0 ? and(...conditions) : undefined;

    const total = db.select({ count: sql<number>`count(*)` }).from(runs).where(where).get()?.count ?? 0;
    const rows = db.select().from(runs).where(where).orderBy(desc(runs.createdAt)).limit(limit).offset(offset).all();
    return { runs: rows.map(rowToJson), total };
  });
}