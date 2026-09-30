/**
 * Aether 2.4.0 —— Runs REST API 客户端（8 个端点全覆盖）。
 *
 * 传输层复用 `api/client.ts`：`requestResult`。本文件**不持有任何 fetch 封装**，
 * 因此自动继承其统一行为，无需在此重复实现：
 *   - Base `/api`、30s 超时、`X-Requested-With: XMLHttpRequest`（CSRF）
 *   - 认证不对称：非 GET 端点先 `await ensureAuthToken()`，再由传输层统一附
 *     `Authorization: Bearer <token>`（即 `authHeaders()` 的效果 —— 传输层在 spread
 *     options.headers 之后覆写该键，此处再传一遍是可证明的 no-op，故不复写）；
 *     GET 不附 Bearer（`/runs*` 不在传输层的 sensitiveReadPaths 白名单内）
 *   - 错误归一：HTTP 失败 → ApiError，优先取后端 `error.code`
 *     （`RUN_NOT_FOUND` / `INVALID_TRANSITION` / `VALIDATION_ERROR` …）
 *
 * 双层级由**同一份实现**派生（`orThrow`），两层签名不可能漂移：
 *   - `runsApi.*`         throw 风格：失败抛 `RunsApiError`（Error 子类，带结构化 `error`）
 *   - `runsApi.result.*`  永不 throw：返回 `ApiResult<T>`，调用点必须判别 `ok`
 *
 * 注：`client.ts` 的 `request`（throw 风格原语）是模块私有、未导出；throw 层因此
 * 由 `requestResult` + `orThrow` 组合，传输层仍只有一层。
 */
import type { AgentEvent, RunStatus } from '@pacc/shared';
import { requestResult, type ApiRequestOptions } from './client';
import type { ApiError, ApiResult } from './contract';

// ---------- DTO（与 backend/src/modules/runs/routes.ts 的 RunDto 逐字段对齐） ----------

/** Run 执行模式（后端 RUN_MODES 的镜像）。 */
export type RunMode = 'normal' | 'super' | 'workflow' | 'background';

export interface RunDto {
  id: string;
  conversationId: string | null;
  /** 状态取值一律来自 @pacc/shared 的 11 态 canonical 集合，禁止手写字符串。 */
  status: RunStatus;
  mode: RunMode;
  rootAgentId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  endReason: string | null;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  error: unknown | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/** GET /api/runs 列表响应。 */
export interface RunListDto {
  runs: RunDto[];
  total: number;
}

/** POST /api/runs/recover 响应（Crash Recovery 结果）。 */
export interface RunRecoverDto {
  recovered: number;
  message: string;
}

/** GET /api/runs/:runId/events 增量回放响应。 */
export interface RunEventsDto {
  events: AgentEvent[];
  /** 续传游标：无新增事件时回退为请求的 afterSeq。 */
  nextSeq: number;
}

// ---------- 入参 ----------

export interface ListRunsParams {
  conversationId?: string;
  status?: RunStatus;
  limit?: number;
  offset?: number;
}

export interface CreateRunInput {
  conversationId?: string;
  mode?: RunMode;
  rootAgentId?: string;
  /**
   * 服务端约定：**run 的 id 经 `metadata.runId` 嵌套传入**（不是顶层字段），
   * 缺省时后端自行 randomUUID。见 routes.ts `body.metadata?.runId`。
   */
  metadata?: Record<string, unknown>;
}

export interface FetchRunEventsParams {
  /** 缺省 0（从头回放）。 */
  afterSeq?: number;
  limit?: number;
}

// ---------- 内部工具 ----------

/** 只拼接已定义的过滤项，避免产生 `?` 尾巴或 `undefined` 字面量。 */
function query(entries: ReadonlyArray<readonly [string, string | undefined]>): string {
  const parts = entries.filter(([, v]) => v !== undefined);
  return parts.length === 0 ? '' : `?${parts.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')}`;
}

function runPath(runId: string, suffix = ''): string {
  return `/runs/${encodeURIComponent(runId)}${suffix}`;
}

/** 无请求体的 POST 选项：必须省略 body，否则传输层会设 Content-Type 并让 Fastify 报 400/415。 */
const NO_BODY_POST: ApiRequestOptions = { method: 'POST' };

// ---------- result 层（永不 throw）—— 唯一实现 ----------

const result = {
  /** GET /api/runs —— 列表（conversationId / status 过滤 + limit/offset 分页） */
  listRuns: (params: ListRunsParams = {}): Promise<ApiResult<RunListDto>> =>
    requestResult<RunListDto>(`/runs${query([
      ['conversationId', params.conversationId],
      ['status', params.status],
      ['limit', params.limit === undefined ? undefined : String(params.limit)],
      ['offset', params.offset === undefined ? undefined : String(params.offset)],
    ])}`),

  /** GET /api/runs/:runId —— 详情（404 → RUN_NOT_FOUND） */
  getRun: (runId: string): Promise<ApiResult<RunDto>> => requestResult<RunDto>(runPath(runId)),

  /** POST /api/runs —— 创建（201）；runId 经 metadata.runId 传入 */
  createRun: (input: CreateRunInput): Promise<ApiResult<RunDto>> =>
    requestResult<RunDto>('/runs', { method: 'POST', body: JSON.stringify(input) }),

  /** POST /api/runs/:runId/start —— created → running */
  startRun: (runId: string): Promise<ApiResult<RunDto>> => requestResult<RunDto>(runPath(runId, '/start'), NO_BODY_POST),

  /** POST /api/runs/:runId/pause —— running → waiting */
  pauseRun: (runId: string): Promise<ApiResult<RunDto>> => requestResult<RunDto>(runPath(runId, '/pause'), NO_BODY_POST),

  /** POST /api/runs/:runId/resume —— waiting → running（409 → INVALID_TRANSITION） */
  resumeRun: (runId: string): Promise<ApiResult<RunDto>> => requestResult<RunDto>(runPath(runId, '/resume'), NO_BODY_POST),

  /** POST /api/runs/:runId/cancel —— 5 态（running/waiting/retry_waiting/retrying/verifying）→ cancelled */
  cancelRun: (runId: string): Promise<ApiResult<RunDto>> => requestResult<RunDto>(runPath(runId, '/cancel'), NO_BODY_POST),

  /** POST /api/runs/recover —— Crash Recovery：无 body 无 query */
  recoverStaleRuns: (): Promise<ApiResult<RunRecoverDto>> => requestResult<RunRecoverDto>('/runs/recover', NO_BODY_POST),

  /** GET /api/runs/:runId/events —— 断线续传增量回放（afterSeq 缺省 0） */
  fetchRunEvents: (runId: string, params: FetchRunEventsParams = {}): Promise<ApiResult<RunEventsDto>> =>
    requestResult<RunEventsDto>(
      runPath(runId, `/events${query([
        ['afterSeq', String(params.afterSeq ?? 0)],
        ['limit', params.limit === undefined ? undefined : String(params.limit)],
      ])}`),
    ),
};

// ---------- throw 层（由 result 层派生） ----------

/** throw 风格端点失败时抛出的错误：既是 Error（老调用点 `.message` 照常可用），又携带结构化 ApiError。 */
export class RunsApiError extends Error {
  readonly error: ApiError;

  constructor(error: ApiError) {
    super(error.message);
    this.name = 'RunsApiError';
    this.error = error;
  }
}

function orThrow<A extends unknown[], R>(
  fn: (...args: A) => Promise<ApiResult<R>>,
): (...args: A) => Promise<R> {
  return async (...args: A) => {
    const res = await fn(...args);
    if (res.ok) return res.data;
    throw new RunsApiError(res.error);
  };
}

export const runsApi = {
  listRuns: orThrow(result.listRuns),
  getRun: orThrow(result.getRun),
  createRun: orThrow(result.createRun),
  startRun: orThrow(result.startRun),
  pauseRun: orThrow(result.pauseRun),
  resumeRun: orThrow(result.resumeRun),
  cancelRun: orThrow(result.cancelRun),
  recoverStaleRuns: orThrow(result.recoverStaleRuns),
  fetchRunEvents: orThrow(result.fetchRunEvents),
  /** 永不 throw 层：调用点必须判别 ok，从根上杜绝 catch → [] 把失败伪装成空列表。 */
  result,
};
