/**
 * RetryPolicy — Model Runtime 重试策略（P0-10 收口）
 *
 * 旧系统 fetchWithRetry 的能力（429/5xx/Retry-After/jitter/abortable sleep）
 * 收编为 ModelRuntime 的组成部分。Transport-agnostic，无 Fastify/SSE 依赖。
 *
 * 语义：
 * - 429 → retry（尊重 Retry-After，缺省指数退避 + jitter）
 * - 5xx → retry（指数退避 + jitter）
 * - 其他 → 不重试
 * - abortable sleep：AbortSignal 中止时立即停止等待（Run Cancel 生效）
 */

export interface RetryPolicyOptions {
  /** 最大重试次数（默认 3，即最多 4 次尝试） */
  maxRetries?: number;
  /** 基础退避毫秒（默认 1000） */
  baseDelayMs?: number;
  /** 最大退避毫秒（默认 10000） */
  maxDelayMs?: number;
  /** jitter 比例 0-1（默认 0.3，乘性抖动） */
  jitter?: number;
}

/** 判断是否可重试的判定函数（默认：429/5xx/网络错误） */
export type RetryablePredicate = (err: unknown) => boolean;

export interface RetryPolicy {
  /** 是否允许重试（第 attempt 次失败后，attempt 从 0 开始） */
  shouldRetry(attempt: number, err: unknown): boolean;
  /** 计算本次重试前的等待时间（含 jitter），毫秒 */
  delayMs(attempt: number, retryAfterMs?: number): number;
  /** 可中止的等待 */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
}

/** 从错误中提取 Retry-After（毫秒）；无效返回 undefined */
export function extractRetryAfterMs(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined;
  const e = err as Record<string, unknown>;
  const retryAfter = e.retryAfterMs ?? (e as { retryAfter?: unknown }).retryAfter;
  if (typeof retryAfter === 'number' && Number.isFinite(retryAfter) && retryAfter > 0) {
    return retryAfter;
  }
  return undefined;
}

/** 默认可重试判定：429 / 5xx / 网络错误（ModelError.retryable） */
export function defaultRetryable(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;
  const e = err as { code?: string; statusCode?: number; retryable?: boolean };
  if (typeof e.retryable === 'boolean') return e.retryable;
  if (typeof e.statusCode === 'number') {
    return e.statusCode === 429 || e.statusCode >= 500;
  }
  if (typeof e.code === 'string') {
    return ['RATE_LIMIT', 'PROVIDER_UNAVAILABLE', 'NETWORK_ERROR', 'STREAM_CLOSED'].includes(e.code);
  }
  return false;
}

export function createRetryPolicy(opts: RetryPolicyOptions = {}): RetryPolicy {
  const maxRetries = opts.maxRetries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 1000;
  const maxDelayMs = opts.maxDelayMs ?? 10_000;
  const jitter = opts.jitter ?? 0.3;

  const shouldRetry: RetryPolicy['shouldRetry'] = (attempt, err) => {
    if (attempt >= maxRetries) return false;
    return defaultRetryable(err);
  };

  const delayMs: RetryPolicy['delayMs'] = (attempt, retryAfterMs) => {
    if (retryAfterMs !== undefined && Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
      return Math.min(retryAfterMs, maxDelayMs);
    }
    // 指数退避：base * 2^attempt，乘性 jitter
    const exp = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
    const jittered = exp * (1 - jitter + Math.random() * 2 * jitter);
    return Math.min(Math.max(Math.round(jittered), 10), maxDelayMs);
  };

  const sleep: RetryPolicy['sleep'] = (ms, signal) =>
    new Promise<void>((resolve, reject) => {
      // §15 修复：abort 必须 reject AbortError（与 fetch-retry.ts 一致），
      // 供 ExecutionLoop 识别为 CANCELLED → Run 正确结束。
      // 禁止 abort 后 sleep resolve 导致继续下一次 Retry。
      if (signal?.aborted) {
        reject(new DOMException('Aborted', 'AbortError'));
        return;
      }
      const onAbort = () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      const timer = setTimeout(() => {
        signal?.removeEventListener('abort', onAbort);
        resolve();
      }, ms);
      signal?.addEventListener('abort', onAbort, { once: true });
    });

  return { shouldRetry, delayMs, sleep };
}
