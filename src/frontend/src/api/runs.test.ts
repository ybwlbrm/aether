// allow: SIZE_OK — 1:1 契约镜像文件：每个 describe 段对应 runsApi 的一个端点组，
// 拆分只会割裂「端点 → 断言」的映射。单一职责（runs 客户端契约），无第二种关注点。
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { AgentEvent, RunStatus } from '@pacc/shared';
import { RunsApiError, runsApi, type RunDto } from './runs';
import type { ApiResult } from './contract';

/**
 * Runs REST API 客户端契约测试（mock fetch 模式对齐 api/client.test.ts）。
 * 锁定三条不变量：8 端点的 URL/query/body 形状（含 id 走 metadata.runId）；
 * 认证不对称（GET 无 Authorization，POST 必带 Bearer + X-Requested-With）；双层级错误语义。
 */

const TEST_TOKEN = 'tok-runs-test';
const AUTH_PATH = '/api/auth/token';

type FetchCall = [string, RequestInit];

/** RunDto 夹具：其字面量形状即编译期契约校验（status 必须是 @pacc/shared 的 RunStatus）。 */
const RUN: RunDto = {
  id: 'run-1',
  conversationId: 'c-1',
  status: 'running',
  mode: 'super',
  rootAgentId: 'agent-1',
  startedAt: '2026-01-01T00:00:00.000Z',
  completedAt: null,
  endReason: null,
  inputTokens: 10,
  outputTokens: 20,
  totalTokens: 30,
  error: null,
  metadata: { runId: 'run-1' },
  createdAt: '2026-01-01T00:00:00.000Z',
};

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/** 后端统一错误体：{ error: { code, message } }（见 backend/plugins/error-handler.ts） */
function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse({ error: { code, message } }, status);
}

/**
 * 装 fetch mock。认证引导请求（/api/auth/token）由 mock 自行应答，
 * 使测试与「token 是否已被前序用例缓存」无关（与执行顺序解耦）。
 */
function stubFetch(handler: (url: string, init: RequestInit) => Response): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url === AUTH_PATH) return jsonResponse({ token: TEST_TOKEN });
    return handler(url, init ?? {});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** 取最后一次真实业务请求（跳过认证引导调用），并把 headers 归一为普通对象。 */
function lastApiCall(fetchMock: ReturnType<typeof vi.fn>): {
  url: string;
  method: string;
  body: string | undefined;
  headers: Record<string, string>;
} {
  const calls = (fetchMock.mock.calls as FetchCall[]).filter(([url]) => url !== AUTH_PATH);
  const call = calls.at(-1);
  if (!call) throw new Error('未捕获到业务请求');
  const [url, init] = call;
  const headers = (init.headers ?? {}) as Record<string, string>;
  return {
    url,
    method: init.method ?? 'GET',
    body: init.body === undefined ? undefined : String(init.body),
    headers,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('listRuns — GET /api/runs（query 透传）', () => {
  it('把 conversationId / status / limit / offset 透传为 query，并返回 { runs, total }', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ runs: [RUN], total: 1 }));

    const res = await runsApi.result.listRuns({ conversationId: 'c-1', status: 'running', limit: 10, offset: 5 });

    expect(lastApiCall(fetchMock).url).toBe('/api/runs?conversationId=c-1&status=running&limit=10&offset=5');
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.data.total).toBe(1);
    expect(res.data.runs).toEqual([RUN]);
  });

  it('status 接受 @pacc/shared 的 11 态联合（非 running 态也合法）', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ runs: [], total: 0 }));
    const status: RunStatus = 'retry_waiting';

    await runsApi.result.listRuns({ status });

    expect(lastApiCall(fetchMock).url).toBe('/api/runs?status=retry_waiting');
  });

  it('无过滤条件时不追加任何 query（不产生裸 "?"）', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ runs: [], total: 0 }));

    await runsApi.result.listRuns({});

    expect(lastApiCall(fetchMock).url).toBe('/api/runs');
  });

  it('400 → result 层返回 ApiError 而非 throw（空列表绝不伪装成成功）', async () => {
    stubFetch(() => errorResponse(400, 'VALIDATION_ERROR', '无效的 status: nope'));

    const res = await runsApi.result.listRuns({ status: 'running' });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.status).toBe(400);
    expect(res.error.code).toBe('VALIDATION_ERROR');
    expect(res.error.message).toBe('无效的 status: nope');
  });
});

describe('getRun — GET /api/runs/:runId（404 → RUN_NOT_FOUND）', () => {
  it('result 层：404 归一为 code=RUN_NOT_FOUND / status=404', async () => {
    stubFetch(() => errorResponse(404, 'RUN_NOT_FOUND', 'run missing 未找到'));

    const res = await runsApi.result.getRun('missing');

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.code).toBe('RUN_NOT_FOUND');
    expect(res.error.status).toBe(404);
  });

  it('throw 层：同一 404 抛 RunsApiError，并保留结构化 error 与 message', async () => {
    stubFetch(() => errorResponse(404, 'RUN_NOT_FOUND', 'run missing 未找到'));

    const thrown: unknown = await runsApi.getRun('missing').catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(RunsApiError);
    if (!(thrown instanceof RunsApiError)) throw new Error('unreachable');
    expect(thrown.error.code).toBe('RUN_NOT_FOUND');
    expect(thrown.error.status).toBe(404);
    expect(thrown.message).toContain('未找到');
  });

  it('成功路径：透传 RunDto（含 null 可空字段）', async () => {
    stubFetch(() => jsonResponse(RUN));

    const run = await runsApi.getRun('run-1');

    expect(run.status).toBe('running');
    expect(run.mode).toBe('super');
    expect(run.metadata).toEqual({ runId: 'run-1' });
  });
});

describe('状态转移端点 — start / pause / resume / cancel（无请求体）', () => {
  const TRANSITIONS: ReadonlyArray<{ name: string; call: () => Promise<ApiResult<RunDto>>; path: string }> = [
    { name: 'startRun', call: () => runsApi.result.startRun('run-1'), path: '/api/runs/run-1/start' },
    { name: 'pauseRun', call: () => runsApi.result.pauseRun('run-1'), path: '/api/runs/run-1/pause' },
    { name: 'resumeRun', call: () => runsApi.result.resumeRun('run-1'), path: '/api/runs/run-1/resume' },
    { name: 'cancelRun', call: () => runsApi.result.cancelRun('run-1'), path: '/api/runs/run-1/cancel' },
  ];

  it.each(TRANSITIONS)('$name 发出无 body / 无 Content-Type 的 POST', async ({ call, path }) => {
    const fetchMock = stubFetch(() => jsonResponse(RUN));

    const res = await call();

    expect(res.ok).toBe(true);
    const sent = lastApiCall(fetchMock);
    expect(sent.url).toBe(path);
    expect(sent.method).toBe('POST');
    expect(sent.body).toBeUndefined();
    // Fastify 对空 JSON body 会报 400/415，因此 Content-Type 必须不出现
    expect(sent.headers['Content-Type']).toBeUndefined();
  });

  it('resumeRun 409 → result 层返回 code=INVALID_TRANSITION / status=409', async () => {
    stubFetch(() => errorResponse(409, 'INVALID_TRANSITION', '状态 running 不允许操作 resume（非法状态转移）'));

    const res = await runsApi.result.resumeRun('run-1');

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.code).toBe('INVALID_TRANSITION');
    expect(res.error.status).toBe(409);
  });

  it('resumeRun 409 → throw 层抛 RunsApiError（状态机冲突不得被 catch 成空值）', async () => {
    stubFetch(() => errorResponse(409, 'INVALID_TRANSITION', '状态 running 不允许操作 resume（非法状态转移）'));

    const thrown: unknown = await runsApi.resumeRun('run-1').catch((e: unknown) => e);

    expect(thrown).toBeInstanceOf(RunsApiError);
    if (!(thrown instanceof RunsApiError)) throw new Error('unreachable');
    expect(thrown.error.code).toBe('INVALID_TRANSITION');
  });
});

describe('createRun — POST /api/runs（201，id 走 metadata.runId）', () => {
  it('发出全部 4 个可选字段，且 runId 只经 metadata 嵌套传入（服务端约定）', async () => {
    const fetchMock = stubFetch(() => jsonResponse(RUN, 201));

    const res = await runsApi.result.createRun({
      conversationId: 'c-1',
      mode: 'super',
      rootAgentId: 'agent-1',
      metadata: { runId: 'run-1', source: 'test' },
    });

    const sent = lastApiCall(fetchMock);
    expect(sent.url).toBe('/api/runs');
    expect(sent.method).toBe('POST');
    expect(sent.headers['Content-Type']).toBe('application/json');
    expect(JSON.parse(sent.body ?? 'null')).toEqual({
      conversationId: 'c-1',
      mode: 'super',
      rootAgentId: 'agent-1',
      metadata: { runId: 'run-1', source: 'test' },
    });
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.data.id).toBe('run-1');
  });

  it('只传 metadata 时不补齐缺失键（不发送 undefined 字段）', async () => {
    const fetchMock = stubFetch(() => jsonResponse(RUN, 201));

    await runsApi.createRun({ metadata: { runId: 'run-9' } });

    expect(JSON.parse(lastApiCall(fetchMock).body ?? 'null')).toEqual({ metadata: { runId: 'run-9' } });
  });
});

describe('recoverStaleRuns — POST /api/runs/recover（无 body 无 query）', () => {
  it('打到 /api/runs/recover，无请求体、无 query，返回 { recovered, message }', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ recovered: 3, message: '已标记 3 个崩溃遗留 Run 为 interrupted' }));

    const res = await runsApi.result.recoverStaleRuns();

    const sent = lastApiCall(fetchMock);
    expect(sent.url).toBe('/api/runs/recover');
    expect(sent.method).toBe('POST');
    expect(sent.body).toBeUndefined();
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.data).toEqual({ recovered: 3, message: '已标记 3 个崩溃遗留 Run 为 interrupted' });
  });
});

describe('fetchRunEvents — GET /api/runs/:runId/events（增量回放）', () => {
  it('afterSeq 缺省为 0，且透传 nextSeq', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ events: [{ seq: 1 }, { seq: 2 }], nextSeq: 2 }));

    const res = await runsApi.result.fetchRunEvents('run-1');

    expect(lastApiCall(fetchMock).url).toBe('/api/runs/run-1/events?afterSeq=0');
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    // 编译期证明 events 元素类型即 @pacc/shared 的 AgentEvent
    const events: AgentEvent[] = res.data.events;
    expect(events).toHaveLength(2);
    expect(res.data.nextSeq).toBe(2);
  });

  it('显式 afterSeq / limit 透传为 query', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ events: [], nextSeq: 12 }));

    await runsApi.result.fetchRunEvents('run-1', { afterSeq: 12, limit: 50 });

    expect(lastApiCall(fetchMock).url).toBe('/api/runs/run-1/events?afterSeq=12&limit=50');
  });

  it('无新增事件时 nextSeq 回退为请求的 afterSeq（断线续传游标不前进）', async () => {
    stubFetch(() => jsonResponse({ events: [], nextSeq: 12 }));

    const res = await runsApi.result.fetchRunEvents('run-1', { afterSeq: 12 });

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.data).toEqual({ events: [], nextSeq: 12 });
  });
});

describe('认证不对称 —— GET 不带 Authorization，POST 必带 Bearer + X-Requested-With', () => {
  it('GET 端点（listRuns / getRun / fetchRunEvents）不携带 Authorization', async () => {
    const fetchMock = stubFetch(() => jsonResponse({ runs: [], total: 0 }));

    await runsApi.result.listRuns();
    await runsApi.result.getRun('run-1');
    await runsApi.result.fetchRunEvents('run-1');

    for (const call of (fetchMock.mock.calls as FetchCall[]).filter(([url]) => url !== AUTH_PATH)) {
      const headers = (call[1].headers ?? {}) as Record<string, string>;
      expect(headers['Authorization']).toBeUndefined();
      // CSRF 头所有请求都带（含 GET）
      expect(headers['X-Requested-With']).toBe('XMLHttpRequest');
    }
  });

  it('POST 端点（createRun / 4 个转移 / recover）携带 Bearer 与 X-Requested-With', async () => {
    const fetchMock = stubFetch(() => jsonResponse(RUN, 201));

    await runsApi.createRun({ metadata: { runId: 'run-1' } });
    await runsApi.startRun('run-1');
    await runsApi.pauseRun('run-1');
    await runsApi.resumeRun('run-1');
    await runsApi.cancelRun('run-1');
    await runsApi.recoverStaleRuns();

    const posts = (fetchMock.mock.calls as FetchCall[]).filter(
      ([url, init]) => url !== AUTH_PATH && (init.method ?? 'GET') === 'POST',
    );
    expect(posts).toHaveLength(6);
    for (const [, init] of posts) {
      const headers = (init.headers ?? {}) as Record<string, string>;
      expect(headers['Authorization']).toBe(`Bearer ${TEST_TOKEN}`);
      expect(headers['X-Requested-With']).toBe('XMLHttpRequest');
    }
  });
});
