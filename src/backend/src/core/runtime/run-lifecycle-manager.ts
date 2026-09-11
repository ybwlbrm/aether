/**
 * RunLifecycleManager — Aether 2.0 统一 Run 生命周期管理器（P0-05 收口）
 *
 * 唯一负责 runs 表状态写入的入口。所有模块（orchestration / chat / workflow /
 * background / remote command / runs API）只能请求 transition(runId, action)，
 * 禁止直接 db.update(runs) / db.insert(runs) 绕过状态机。
 *
 * 状态机：created → running ⇄ waiting → completed | failed | cancelled | interrupted（终态吸收）
 * 每次转换先过 isValidRunTransition 校验；非法转换抛 RuntimeError(INVALID_RUN_TRANSITION)。
 *
 * Transport-agnostic：仅依赖 drizzle sql-js 同步 API，无 Fastify/SSE/React。
 */

import type { SQLJsDatabase } from 'drizzle-orm/sql-js';
import { eq, sql } from 'drizzle-orm';
import * as schema from '../../db/schema/index.js';
import {
  isValidRunTransition,
  type RunMode,
  type RunStatus,
} from './run.js';
import { RuntimeError } from '../errors/index.js';
import { getDb } from '../../db/client.js';

type Db = SQLJsDatabase<typeof schema>;
type RunRow = typeof schema.runs.$inferSelect;

/** 生命周期动作（transition 的第二参数） */
export type RunAction =
  | 'create'
  | 'start'
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'complete'
  | 'fail'
  | 'recover';

/** create 动作的输入 */
export interface CreateRunInput {
  runId: string;
  conversationId?: string | null;
  mode?: RunMode;
  rootAgentId?: string | null;
  metadata?: Record<string, unknown>;
}

/** transition 动作的可选载荷（token 统计 / 错误信息） */
export interface TransitionOptions {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  error?: string;
  endReason?: string;
}

/** 动作 → 允许的起始状态集合 */
const ACTION_FROM: Record<RunAction, readonly RunStatus[]> = {
  create: ['created'], // create 仅用于空行预插（幂等）；真正的 created→running 由 start 完成
  start: ['created'],
  pause: ['running'],
  resume: ['waiting'],
  cancel: ['running', 'waiting'],
  complete: ['running', 'waiting'],
  fail: ['running', 'waiting'],
  recover: ['running', 'waiting'],
};

/** 动作 → 目标状态 */
const ACTION_TO: Record<RunAction, RunStatus> = {
  create: 'created',
  start: 'running',
  pause: 'waiting',
  resume: 'running',
  cancel: 'cancelled',
  complete: 'completed',
  fail: 'failed',
  recover: 'interrupted',
};

/**
 * RunLifecycleManager — 唯一 Run 状态写入入口。
 *
 * 用法：
 *   const lm = new RunLifecycleManager(getDb());
 *   lm.create({ runId, conversationId, mode: 'super' });  // 幂等
 *   lm.transition(runId, 'start');
 *   ...
 *   lm.transition(runId, 'complete', { inputTokens, outputTokens, totalTokens });
 */
export class RunLifecycleManager {
  #db: Db;

  constructor(db: Db) {
    this.#db = db;
  }

  /** 读取 run 行（不存在返回 undefined） */
  get(runId: string): RunRow | undefined {
    return this.#db
      .select()
      .from(schema.runs)
      .where(eq(schema.runs.id, runId))
      .get() as RunRow | undefined;
  }

  /**
   * create — 以 created 状态创建 run 行（幂等：已存在则忽略）。
   * 禁止绕过状态机直接插入 running（P0-05）。
   */
  create(input: CreateRunInput): RunRow {
    const existing = this.get(input.runId);
    if (existing) return existing;
    const now = new Date().toISOString();
    this.#db
      .insert(schema.runs)
      .values({
        id: input.runId,
        conversationId: input.conversationId ?? null,
        status: 'created',
        mode: input.mode ?? 'normal',
        rootAgentId: input.rootAgentId ?? null,
        metadata: input.metadata ? JSON.stringify(input.metadata) : null,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        createdAt: now,
      })
      .run();
    const row = this.get(input.runId);
    if (!row) {
      throw new RuntimeError(`run 创建后回读失败: ${input.runId}`, {
        code: 'RUN_NOT_FOUND',
        retryable: false,
        context: { runId: input.runId },
      });
    }
    return row;
  }

  /**
   * transition — 状态转移的唯一入口。
   * 校验起始状态合法 + 状态机转移合法；非法抛 INVALID_RUN_TRANSITION。
   */
  transition(runId: string, action: RunAction, opts?: TransitionOptions): RunRow {
    const row = this.get(runId);
    if (!row) {
      throw new RuntimeError(`run 不存在: ${runId}`, {
        code: 'RUN_NOT_FOUND',
        retryable: false,
        context: { runId },
      });
    }

    const from = row.status as RunStatus;
    const allowedFrom = ACTION_FROM[action];
    if (!allowedFrom.includes(from)) {
      throw new RuntimeError(`非法状态转移: ${from} 不允许执行 ${action}`, {
        code: 'INVALID_RUN_TRANSITION',
        retryable: false,
        context: { runId, from, action },
      });
    }
    const to = ACTION_TO[action];
    if (!isValidRunTransition(from, to)) {
      throw new RuntimeError(`非法状态转移: ${from} → ${to}`, {
        code: 'INVALID_RUN_TRANSITION',
        retryable: false,
        context: { runId, from, to, action },
      });
    }

    const now = new Date().toISOString();
    const patch: Partial<typeof schema.runs.$inferInsert> = { status: to };
    if (to === 'running' && !row.startedAt) patch.startedAt = now;
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(to)) {
      patch.completedAt = now;
    }
    // 终态默认 endReason（调用方未显式指定时按动作给出）
    const defaultEndReason: Partial<Record<RunAction, string>> = {
      cancel: 'cancelled',
      fail: 'error',
      complete: 'completed',
      recover: 'crashed',
    };
    if (['completed', 'failed', 'cancelled', 'interrupted'].includes(to)) {
      patch.endReason = opts?.endReason ?? defaultEndReason[action] ?? null;
    } else if (opts?.endReason) {
      patch.endReason = opts.endReason;
    }
    if (opts?.error !== undefined) patch.error = opts.error;
    // token 累计：终态写入快照；totalTokens 缺省时按 input+output 计算
    const inputTokens = (row.inputTokens ?? 0) + (opts?.inputTokens ?? 0);
    const outputTokens = (row.outputTokens ?? 0) + (opts?.outputTokens ?? 0);
    const totalTokens = (row.totalTokens ?? 0) + (opts?.totalTokens ?? inputTokens + outputTokens);
    if (opts?.inputTokens !== undefined || opts?.outputTokens !== undefined || opts?.totalTokens !== undefined) {
      patch.inputTokens = inputTokens;
      patch.outputTokens = outputTokens;
      patch.totalTokens = totalTokens;
    }

    this.#db
      .update(schema.runs)
      .set(patch as never)
      .where(eq(schema.runs.id, runId))
      .run();

    const updated = this.get(runId);
    if (!updated) {
      throw new RuntimeError(`run 转移后回读失败: ${runId}`, {
        code: 'RUN_NOT_FOUND',
        retryable: false,
        context: { runId },
      });
    }
    return updated;
  }

  /** 便捷：create → start 一步到位（幂等，兼容旧 ensureRunRow 语义但严格走状态机） */
  createAndStart(input: CreateRunInput): RunRow {
    this.create(input);
    const row = this.get(input.runId);
    if (row && (row.status as RunStatus) === 'created') {
      return this.transition(input.runId, 'start');
    }
    return row as RunRow;
  }

  /** Crash Recovery：把所有遗留 running/waiting Run 标记为 interrupted（幂等） */
  recoverStale(): number {
    const stale = this.#db
      .select()
      .from(schema.runs)
      .where(sql`${schema.runs.status} IN ('running', 'waiting')`)
      .all() as RunRow[];
    let marked = 0;
    for (const run of stale) {
      try {
        this.transition(run.id, 'recover', { endReason: 'crashed' });
        marked += 1;
      } catch (err) {
        // 单 run 恢复失败不影响其他 run
        console.warn(`[RunLifecycleManager] recover ${run.id} 失败:`,
          err instanceof Error ? err.message : String(err));
      }
    }
    return marked;
  }
}

/** 全局共享实例（应用启动后由 initDb 后创建；测试可自行构造） */
let shared: RunLifecycleManager | null = null;

export function getRunLifecycleManager(db?: Db): RunLifecycleManager {
  if (!shared || db) {
    shared = new RunLifecycleManager(db ?? getDb());
  }
  return shared;
}

export function resetRunLifecycleManager(): void {
  shared = null;
}
