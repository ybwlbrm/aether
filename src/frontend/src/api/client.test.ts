import { describe, it, expect, vi, afterEach } from 'vitest';
import { requestResult, requestResultVoid, api } from './client';
import { isApiResult, errorMessage, ApiErrorCode, type ApiError, type ApiResult } from './contract';

/**
 * TG-02 / AEX-P1-017 契约测试：每个 API 请求返回 success | ApiError。
 * 核心断言：**空数据 ≠ 错误**。禁止 catch → [] 把失败伪装成空列表。
 */

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

function emptyResponse(status: number): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    text: async () => '',
  } as unknown as Response;
}

function errorResponse(status: number, body: unknown): Response {
  return jsonResponse(body, status);
}

/** fetch 挂起直到 signal abort（用于超时 / 主动取消用例） */
function hangingFetch(): ReturnType<typeof vi.fn> {
  return vi.fn((_url: string, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => {
        const err = new Error('The operation was aborted.');
        err.name = 'AbortError';
        reject(err);
      });
    }),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('requestResult — 成功路径', () => {
  it('200 + JSON → { ok: true, data }（不 throw）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse({ status: 'ok', version: '2.3.0' })));

    const res = await requestResult<{ status: string; version: string }>('/health');

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(res.data).toEqual({ status: 'ok', version: '2.3.0' });
  });

  it('空数组数据 → ok:true 且 data 为空数组（成功但空，绝不等于 error）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([])));

    const res = await requestResult<unknown[]>('/providers');

    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error('unreachable');
    expect(Array.isArray(res.data)).toBe(true);
    expect(res.data).toEqual([]);
  });

  it('POST 写请求附带 Content-Type / X-Requested-With / Authorization', async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(jsonResponse({ token: 'tok-123' }))
      .mockResolvedValue(jsonResponse({ success: true }));
    vi.stubGlobal('fetch', fetchMock);

    const res = await requestResult<{ success: boolean }>('/toolbox/encode', {
      method: 'POST',
      body: JSON.stringify({ op: 'encode-text' }),
    });

    expect(res.ok).toBe(true);
    const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers['Content-Type']).toBe('application/json');
    expect(headers['X-Requested-With']).toBe('XMLHttpRequest');
    expect(headers['Authorization']).toBe('Bearer tok-123');
  });
});

describe('requestResult — 错误路径（统一 ApiError，不 throw Error）', () => {
  it('500 → { ok: false, error.code === "INTERNAL" }，message 取自后端 { error: { message } }', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      errorResponse(500, { error: { message: '服务器内部错误' } }),
    ));

    const res = await requestResult('/anything');

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.code).toBe(ApiErrorCode.Internal);
    expect(res.error.code).toBe('INTERNAL');
    expect(res.error.message).toBe('服务器内部错误');
    expect(res.error.status).toBe(500);
  });

  it('网络错误 → { ok:false, error.code === "NETWORK_ERROR", retryable === true }', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

    const res = await requestResult('/health');

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.code).toBe(ApiErrorCode.NetworkError);
    expect(res.error.code).toBe('NETWORK_ERROR');
    expect(res.error.retryable).toBe(true);
  });

  it('响应体不是合法 JSON → PARSE_ERROR（而非把解析失败当成空数据）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: { get: () => 'text/html' },
      text: async () => '<html>proxy error</html>',
    } as unknown as Response));

    const res = await requestResult('/health');

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.code).toBe(ApiErrorCode.ParseError);
  });

  it('404 → NOT_FOUND 且不标记 retryable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(404, { error: { message: 'not found' } })));

    const res = await requestResult('/nope');

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.code).toBe(ApiErrorCode.NotFound);
    expect(res.error.retryable).not.toBe(true);
  });

  it('429 → RATE_LIMITED 且 retryable === true（可重试语义供 UI 暴露重试入口）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(429, { error: { message: 'slow down' } })));

    const res = await requestResult('/search');

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.code).toBe(ApiErrorCode.RateLimited);
    expect(res.error.retryable).toBe(true);
  });

  it('401 → UNAUTHORIZED，后端未包 error 字段时回退到状态码文案', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(401, {})));

    const res = await requestResult('/settings', { method: 'POST', body: '{}' });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.code).toBe(ApiErrorCode.Unauthorized);
    expect(res.error.message).toContain('401');
  });

  it('后端返回 { error: "字符串" } 形态时也提取为 message', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(400, { error: '参数非法' })));

    const res = await requestResult('/toolbox/convert', { method: 'POST', body: '{}' });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.code).toBe(ApiErrorCode.BadRequest);
    expect(res.error.message).toBe('参数非法');
  });

  it('超时 → TIMEOUT 且 retryable === true', async () => {
    vi.stubGlobal('fetch', hangingFetch());

    const res = await requestResult('/health', { timeout: 5 });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.code).toBe(ApiErrorCode.Timeout);
    expect(res.error.retryable).toBe(true);
  });

  it('调用方主动取消 → ABORTED（控制流，与业务错误区分）', async () => {
    vi.stubGlobal('fetch', hangingFetch());
    const controller = new AbortController();

    const pending = requestResult('/health', { signal: controller.signal });
    controller.abort();
    const res = await pending;

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.code).toBe(ApiErrorCode.Aborted);
  });

  it('原始后端错误体保留在 details，便于 UI 展示字段级错误', async () => {
    const body = { error: { message: '校验失败', fields: { name: '必填' } } };
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(422, body)));

    const res = await requestResult('/providers');

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.details).toEqual(body);
  });

  it('优先采用后端结构化 code（400 VALIDATION_ERROR），而非状态码粗映射', async () => {
    // 对齐 backend/plugins/error-handler.ts 的实际错误体形状
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(400, {
      error: { code: 'VALIDATION_ERROR', message: '请求参数验证失败', details: { field: 'name' } },
    })));

    const res = await requestResult('/providers', { method: 'POST', body: '{}' });

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.code).toBe('VALIDATION_ERROR');
    expect(res.error.message).toBe('请求参数验证失败');
    expect(res.error.status).toBe(400);
  });

  it('后端未给 code 时回退到状态码映射（契约不依赖后端实现细节）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(404, { error: { message: '资源不存在' } })));

    const res = await requestResult('/knowledge/wiki/nope');

    expect(res.ok).toBe(false);
    if (res.ok) throw new Error('unreachable');
    expect(res.error.code).toBe(ApiErrorCode.NotFound);
  });
});

describe('requestResultVoid — 无响应体端点（204）', () => {
  it('204 空响应体 → { ok: true }（无 undefined as T 的类型谎言）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(emptyResponse(204)));

    const res = await requestResultVoid('/sync/disconnect', { method: 'POST', body: '{}' });

    expect(res.ok).toBe(true);
  });
});

describe('向后兼容：既有 api.*（throw Error）行为不变（特征测试，锁定 AEX-P1-017 纯增量）', () => {
  it('api.getProviders 在 2xx 时直接返回解析后的 JSON（不返回 ApiResult 包装）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(jsonResponse([{ id: 'p1' }])));

    await expect(api.getProviders()).resolves.toEqual([{ id: 'p1' }]);
  });

  it('api.getProviders 在非 2xx 时仍 reject Error，并带后端 message（旧调用点 catch 逻辑不受影响）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(500, { error: { message: '服务器内部错误' } })));

    await expect(api.getProviders()).rejects.toThrow('服务器内部错误');
  });

  it('api.getProviders 在网络错误时原样抛出 fetch 异常（旧调用点可继续判 name === "AbortError"）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('fetch failed')));

    await expect(api.getProviders()).rejects.toThrow('fetch failed');
  });

  it('api.result.providers 与 api.getProviders 打同一个端点，但错误表达不同（契约并存）', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(errorResponse(503, { error: { message: '服务暂时不可用' } })));

    const legacy = await api.getProviders().catch(() => 'legacy-threw');
    const structured = await api.result.providers();

    expect(legacy).toBe('legacy-threw');
    expect(structured.ok).toBe(false);
    if (structured.ok) throw new Error('unreachable');
    expect(structured.error.code).toBe(ApiErrorCode.ServiceUnavailable);
    expect(structured.error.retryable).toBe(true);
  });
});

describe('ApiResult / ApiError 判别与工具', () => {  it('isApiResult 正确区分成功与错误（含空数组成功）', () => {
    const emptyOk: ApiResult<unknown[]> = { ok: true, data: [] };
    const failed: ApiResult<unknown[]> = { ok: false, error: { code: 'INTERNAL', message: 'x' } };
    expect(isApiResult(emptyOk)).toBe(true);
    expect(isApiResult(failed)).toBe(true);
    expect(isApiResult(null)).toBe(false);
    expect(isApiResult(undefined)).toBe(false);
    expect(isApiResult({ data: [] })).toBe(false);
  });

  it('errorMessage 对 Error / ApiError / 未知值都有稳定文案', () => {
    expect(errorMessage(new Error('boom'))).toBe('boom');
    expect(errorMessage({ code: 'INTERNAL', message: '服务器内部错误' })).toBe('服务器内部错误');
    expect(errorMessage('裸字符串')).toBe('裸字符串');
    expect(errorMessage(undefined)).toBe('未知错误');
  });

  it('ApiError 是结构化契约：code + message 必填，status/retryable/details 可选', () => {
    const minimal: ApiError = { code: 'UNKNOWN', message: 'x' };
    expect(minimal.retryable).toBeUndefined();
    const full: ApiError = { code: 'INTERNAL', message: 'x', status: 500, retryable: true, details: { a: 1 } };
    expect(full.retryable).toBe(true);
  });
});
