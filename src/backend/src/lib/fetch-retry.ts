// 可重试的状态码
const RETRYABLE_STATUSES = [404, 429, 500, 502, 503, 504];

// 非重试但需显式抛出的状态码（认证/授权/未找到/语义错误）
const NON_RETRYABLE_THROW_STATUSES = [401, 403, 404, 422];

// 熔断器状态：记录每个 provider endpoint 连续失败次数
const circuitBreakerState = new Map<string, { count: number; lastFailure: number }>();
const CIRCUIT_BREAKER_THRESHOLD = 3; // 连续 3 次 429/5xx 触发熔断
const CIRCUIT_BREAKER_WINDOW_MS = 60000; // 60 秒窗口内

/**
 * 带重试的 fetch — 每次重试创建新的 AbortSignal，避免复用已过期的 signal
 * 支持：抖动、Retry-After 头、熔断器（连续 3 次 429/5xx 快速失败）
 */
const RETRY_DELAYS = [3000, 5000, 10000, 30000, 45000]; // 429 专用：3s, 5s, 10s, 30s, 45s

export async function fetchWithRetry(
  url: string,
  options: any,
  sseSend?: (event: string, data: string) => void,
  maxRetries = 5,
): Promise<Response> {
  // 提取 provider endpoint 用于熔断器
  let providerEndpoint = '';
  try {
    const u = new URL(url);
    providerEndpoint = `${u.protocol}//${u.host}`;
  } catch { /* ignore */ }

  // 检查熔断器状态
  const cbState = circuitBreakerState.get(providerEndpoint);
  if (cbState && cbState.count >= CIRCUIT_BREAKER_THRESHOLD) {
    const timeSinceLastFailure = Date.now() - cbState.lastFailure;
    if (timeSinceLastFailure < CIRCUIT_BREAKER_WINDOW_MS) {
      const err = new Error(`熔断器开启：${providerEndpoint} 连续 ${cbState.count} 次失败，快速失败`);
      (err as any).circuitBreaker = true;
      (err as any).providerEndpoint = providerEndpoint;
      throw err;
    } else {
      // 窗口过期，重置计数
      circuitBreakerState.delete(providerEndpoint);
    }
  }

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // P0-5: 保留调用方 signal（客户端断连取消），叠加 120s timeout
      const retryOptions = { ...options };
      if (options.signal) {
        if (typeof (AbortSignal as any).any === 'function') {
          retryOptions.signal = (AbortSignal as any).any([options.signal, AbortSignal.timeout(120000)]);
        } else {
          const combined = new AbortController();
          const onAbort = () => combined.abort();
          options.signal.addEventListener('abort', onAbort, { once: true });
          const to = setTimeout(() => { combined.abort(); }, 120000);
          combined.signal.addEventListener('abort', () => clearTimeout(to), { once: true });
          retryOptions.signal = combined.signal;
        }
      } else {
        retryOptions.signal = AbortSignal.timeout(120000);
      }
      const response = await fetch(url, retryOptions);
      if (response.ok) {
        // 成功时重置熔断器
        if (cbState) circuitBreakerState.delete(providerEndpoint);
        return response;
      }

      // 非 ok 响应处理
      const status = response.status;
      const isRetryable = RETRYABLE_STATUSES.includes(status);
      const isNonRetryableThrow = NON_RETRYABLE_THROW_STATUSES.includes(status);

      if (isNonRetryableThrow) {
        // BE-04b: 非重试但需显式抛出的状态码（401/403/404/422）— 抛出带 provider/status 详情的错误
        const errText = await response.text().catch(() => '');
        const err = new Error(`AI API 请求失败 (${status}): ${errText.slice(0, 200)}`);
        (err as any).status = status;
        (err as any).providerEndpoint = providerEndpoint;
        (err as any).responseBody = errText;
        throw err;
      }

      if (isRetryable) {
        if (attempt >= maxRetries) {
          // 记录熔断器状态（429 或 5xx）
          if (status === 429 || (status >= 500 && status < 600)) {
            const newCount = (cbState?.count || 0) + 1;
            circuitBreakerState.set(providerEndpoint, { count: newCount, lastFailure: Date.now() });
          }
          return response;
        }

        // 计算延迟：优先使用 Retry-After 头，其次预设延迟，最后指数退避
        let delay: number;
        if (status === 429) {
          const retryAfter = response.headers.get('Retry-After');
          delay = retryAfter ? parseInt(retryAfter) * 1000 : (RETRY_DELAYS[attempt] || 45000);
        } else {
          delay = Math.min(1000 * Math.pow(2, attempt), 30000);
        }

        // PF-03: 添加抖动 (±25%)
        const jitter = delay * 0.25 * (Math.random() * 2 - 1);
        delay = Math.max(0, Math.round(delay + jitter));

        if (sseSend) sseSend('retry', JSON.stringify({ attempt: attempt + 1, maxRetries, status, delay: Math.round(delay) }));
        await new Promise(r => setTimeout(r, delay));
        continue;
      }

      // 其他非 ok 状态码：返回响应让调用方处理
      return response;
    } catch (e: unknown) {
      if (e instanceof Error && e.name === 'AbortError') throw e;
      lastError = e instanceof Error ? e : new Error(String(e));
      if (attempt >= maxRetries) throw e;

      // 网络错误等异常：指数退避 + 抖动
      const delay = Math.min(1000 * Math.pow(2, attempt), 30000) + Math.random() * 1000;
      if (sseSend) sseSend('retry', JSON.stringify({ attempt: attempt + 1, maxRetries, status: 0, delay: Math.round(delay), error: (e instanceof Error ? e.message : String(e)) }));
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastError || new Error('Max retries exceeded');
}