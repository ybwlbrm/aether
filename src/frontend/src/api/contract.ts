/**
 * AEX-P1-017 / TG-02：统一 API 错误契约。
 *
 * 规范要求：每个 API 请求返回 `success | ApiError`，禁止在调用点混用
 * `throw Error` / `{ error }` / `[]` / `null` 四种失败表达。
 * 本文件只放**类型与纯函数**（零 IO），网络层见 `api/client.ts`。
 */

/** 结构化错误：code 稳定可断言，message 面向用户，retryable 驱动 UI 重试入口。 */
export interface ApiError {
  /** 稳定错误码（见 ApiErrorCode）。取自 HTTP 状态或传输层故障分类。 */
  code: string;
  /** 面向用户的中文文案。 */
  message: string;
  /** HTTP 状态码；传输层故障（网络/超时/解析）无状态码时缺省。 */
  status?: number;
  /** 是否值得让用户重试（网络抖动 / 限流 / 服务端临时故障 = true）。 */
  retryable?: boolean;
  /** 原始后端错误体，供字段级错误展示与日志排查。 */
  details?: unknown;
}

/** 判别联合：成功携带 data，失败携带 error —— 调用点必须先判别 ok 再取 data。 */
export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: ApiError };

/** 约定错误码常量。`ApiError.code` 保持 `string` 以容纳后端透传的自定义码。 */
export const ApiErrorCode = {
  NetworkError: 'NETWORK_ERROR',
  Timeout: 'TIMEOUT',
  Aborted: 'ABORTED',
  ParseError: 'PARSE_ERROR',
  BadRequest: 'BAD_REQUEST',
  Unauthorized: 'UNAUTHORIZED',
  Forbidden: 'FORBIDDEN',
  NotFound: 'NOT_FOUND',
  Conflict: 'CONFLICT',
  Unprocessable: 'UNPROCESSABLE',
  RateLimited: 'RATE_LIMITED',
  Internal: 'INTERNAL',
  ServiceUnavailable: 'SERVICE_UNAVAILABLE',
  HttpError: 'HTTP_ERROR',
  Unknown: 'UNKNOWN',
} as const;

export type ApiErrorCodeValue = (typeof ApiErrorCode)[keyof typeof ApiErrorCode];

/** HTTP 状态码 → 稳定错误码 */
export function httpErrorCode(status: number): string {
  switch (status) {
    case 400: return ApiErrorCode.BadRequest;
    case 401: return ApiErrorCode.Unauthorized;
    case 403: return ApiErrorCode.Forbidden;
    case 404: return ApiErrorCode.NotFound;
    case 408: return ApiErrorCode.Timeout;
    case 409: return ApiErrorCode.Conflict;
    case 422: return ApiErrorCode.Unprocessable;
    case 429: return ApiErrorCode.RateLimited;
    case 500: return ApiErrorCode.Internal;
    case 502:
    case 503:
    case 504: return ApiErrorCode.ServiceUnavailable;
    default: return ApiErrorCode.HttpError;
  }
}

/** 值得让用户重试的状态码（网络/限流/服务端临时故障）。 */
export function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 425 || status === 429
    || (status >= 500 && status < 600);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * 从后端错误体提取可读文案。兼容三种实际形态：
 * - `{ error: { message } }`（Fastify 应用层统一包装）
 * - `{ error: '字符串' }`（部分旧端点）
 * - `{ message }`（Fastify 默认错误处理器）
 */
export function extractErrorMessage(body: unknown): string | null {
  if (typeof body === 'string') return body.trim() || null;
  if (!isRecord(body)) return null;
  const err = body.error;
  if (typeof err === 'string' && err.trim()) return err;
  if (isRecord(err) && typeof err.message === 'string' && err.message.trim()) return err.message;
  if (typeof body.message === 'string' && body.message.trim()) return body.message;
  return null;
}

/**
 * 后端应用层错误体统一为 `{ error: { code, message, details } }`（见 backend/plugins/error-handler.ts），
 * 其中的 `code` 比 HTTP 状态码映射更精确（如 400 上的 VALIDATION_ERROR、404 上的 AppError.code）。
 * 因此优先采用后端 code，缺失时才回退到状态码映射。
 */
export function extractErrorCode(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const err = body.error;
  if (isRecord(err) && typeof err.code === 'string' && err.code.trim()) return err.code;
  if (typeof body.code === 'string' && body.code.trim()) return body.code;
  return null;
}

/** 由 HTTP 错误响应构造 ApiError（details 保留原始体供字段级展示）。 */
export function fromHttpFailure(status: number, body: unknown): ApiError {
  return {
    code: extractErrorCode(body) ?? httpErrorCode(status),
    message: extractErrorMessage(body) ?? `请求失败: ${status}`,
    status,
    retryable: isRetryableStatus(status),
    details: body,
  };
}

/** 传输层故障构造（网络中断 / 超时 / 取消 / 响应体不可解析）。 */
export function fromTransportFailure(code: string, message: string, details?: unknown): ApiError {
  return { code, message, retryable: code !== ApiErrorCode.Aborted, details };
}

/** 类型守卫：是否为结构化 ApiError。 */
export function isApiError(value: unknown): value is ApiError {
  return isRecord(value) && typeof value.code === 'string' && typeof value.message === 'string';
}

/** 类型守卫：是否为判别联合 ApiResult（成功空数组也是合法成功）。 */
export function isApiResult<T>(value: unknown): value is ApiResult<T> {
  if (!isRecord(value) || typeof value.ok !== 'boolean') return false;
  return value.ok ? 'data' in value : isApiError(value.error);
}

/**
 * 统一错误文案 —— 取代散落各处的
 * `e instanceof Error ? e.message : String(e)`（后者对 ApiError 对象会产出 "[object Object]")。
 */
export function errorMessage(error: unknown): string {
  if (typeof error === 'string' && error.trim()) return error;
  if (isApiError(error)) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return '未知错误';
}
