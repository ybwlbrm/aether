/**
 * CircuitBreaker — Model Runtime 熔断器（P0-10 收口）
 *
 * 旧系统 fetchWithRetry 的 circuit breaker 能力收编为 ModelRuntime 的组成部分。
 * 状态机：CLOSED（正常）→ OPEN（熔断，快速失败）→ HALF_OPEN（探测）→ CLOSED/OPEN
 *
 * Transport-agnostic，无 Fastify/SSE 依赖。
 */

export type CircuitState = 'closed' | 'open' | 'half-open';

export interface CircuitBreakerOptions {
  /** 触发熔断的连续失败次数（默认 5） */
  failureThreshold?: number;
  /** 熔断开启时长（毫秒，默认 30s） */
  openTimeoutMs?: number;
  /** 半开探测成功后恢复到关闭所需连续成功次数（默认 1） */
  successThreshold?: number;
}

export interface CircuitBreaker {
  readonly state: CircuitState;
  /** 是否允许请求通过（CLOSED/HALF_OPEN 且未超过失败阈值） */
  allowRequest(): boolean;
  /** 记录成功 */
  recordSuccess(): void;
  /** 记录失败（达到阈值 → OPEN） */
  recordFailure(): void;
  /** 手动重置为 CLOSED（测试/运维） */
  reset(): void;
  /** 当前连续失败数 */
  readonly consecutiveFailures: number;
}

export function createCircuitBreaker(opts: CircuitBreakerOptions = {}): CircuitBreaker {
  const failureThreshold = opts.failureThreshold ?? 5;
  const openTimeoutMs = opts.openTimeoutMs ?? 30_000;
  const successThreshold = opts.successThreshold ?? 1;

  let state: CircuitState = 'closed';
  let consecutiveFailures = 0;
  let openedAt = 0;
  let consecutiveSuccesses = 0;

  const allowRequest = (): boolean => {
    if (state === 'closed') return true;
    if (state === 'open') {
      // 熔断超时 → 半开探测
      if (Date.now() - openedAt >= openTimeoutMs) {
        state = 'half-open';
        return true;
      }
      return false;
    }
    // half-open：允许探测请求
    return true;
  };

  const recordSuccess = (): void => {
    consecutiveFailures = 0;
    if (state === 'half-open') {
      consecutiveSuccesses += 1;
      if (consecutiveSuccesses >= successThreshold) {
        state = 'closed';
        consecutiveSuccesses = 0;
      }
    }
  };

  const recordFailure = (): void => {
    consecutiveFailures += 1;
    if (state === 'half-open') {
      // 探测失败 → 重新熔断
      state = 'open';
      openedAt = Date.now();
      return;
    }
    if (state === 'closed' && consecutiveFailures >= failureThreshold) {
      state = 'open';
      openedAt = Date.now();
    }
  };

  const reset = (): void => {
    state = 'closed';
    consecutiveFailures = 0;
    consecutiveSuccesses = 0;
    openedAt = 0;
  };

  return {
    get state() { return state; },
    get consecutiveFailures() { return consecutiveFailures; },
    allowRequest,
    recordSuccess,
    recordFailure,
    reset,
  };
}
