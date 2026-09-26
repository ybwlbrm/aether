/**
 * RetryPolicy + CircuitBreaker tests (P0-10: ModelRuntime 重试与熔断收口)
 *
 * RetryPolicy 覆盖：
 * - 429/5xx 可重试，非重试错误不重试
 * - Retry-After 尊重
 * - 指数退避 + jitter 上界
 * - abortable sleep（signal 中止立即返回）
 *
 * CircuitBreaker 覆盖：
 * - 连续失败达到阈值 → OPEN
 * - OPEN 期间 allowRequest=false
 * - 熔断超时 → HALF_OPEN → 成功恢复 CLOSED / 失败重新 OPEN
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRetryPolicy, defaultRetryable, extractRetryAfterMs } from './retry-policy.js';
import { createCircuitBreaker } from './circuit-breaker.js';

describe('core/models/retry-policy', () => {
  it('extractRetryAfterMs：支持秒数字符串/HTTP-date/0，非法值返回 undefined', () => {
    assert.equal(extractRetryAfterMs('5'), 5000, '正数秒 → 毫秒');
    assert.equal(extractRetryAfterMs('0'), 0, '0 表示立即重试');
    assert.equal(extractRetryAfterMs(0), 0, '数字 0 同样表示立即重试');
    assert.equal(extractRetryAfterMs('Wed, 21 Oct 2015 07:28:00 GMT'), 0, '过去的 HTTP-date → 0（立即）');
    const future = new Date(Date.now() + 10_000).toUTCString();
    const futureMs = extractRetryAfterMs(future);
    assert.ok(futureMs !== undefined && futureMs > 0 && futureMs <= 10_000, '未来 HTTP-date → 剩余毫秒');
    assert.equal(extractRetryAfterMs('not-a-date'), undefined, '非法字符串 → undefined');
    assert.equal(extractRetryAfterMs(null), undefined, 'null → undefined');
  });

  it('delayMs：Retry-After 优先，0 不回退指数退避', () => {
    const p = createRetryPolicy({ baseDelayMs: 1000 });
    assert.equal(p.delayMs(0, 0), 0, 'Retry-After=0 → 立即重试');
    assert.equal(p.delayMs(5, 500), 500, 'Retry-After 毫秒优先于退避');
  });

  it('429 可重试，maxRetries 后停止', () => {
    const p = createRetryPolicy({ maxRetries: 2 });
    const rateLimit = { statusCode: 429 };
    assert.equal(p.shouldRetry(0, rateLimit), true);
    assert.equal(p.shouldRetry(1, rateLimit), true);
    assert.equal(p.shouldRetry(2, rateLimit), false, '达到 maxRetries 后不再重试');
  });

  it('5xx 可重试，4xx 其他错误不重试', () => {
    const p = createRetryPolicy();
    assert.equal(p.shouldRetry(0, { statusCode: 500 }), true);
    assert.equal(p.shouldRetry(0, { statusCode: 503 }), true);
    assert.equal(p.shouldRetry(0, { statusCode: 400 }), false);
    assert.equal(p.shouldRetry(0, { statusCode: 401 }), false);
  });

  it('ModelError.retryable 布尔标志优先', () => {
    const p = createRetryPolicy();
    assert.equal(p.shouldRetry(0, { retryable: true, statusCode: 400 }), true, '显式 retryable 优先于状态码');
    assert.equal(p.shouldRetry(0, { retryable: false, statusCode: 500 }), false);
  });

  it('代码级判定：RATE_LIMIT / PROVIDER_UNAVAILABLE / NETWORK_ERROR', () => {
    assert.equal(defaultRetryable({ code: 'RATE_LIMIT' }), true);
    assert.equal(defaultRetryable({ code: 'PROVIDER_UNAVAILABLE' }), true);
    assert.equal(defaultRetryable({ code: 'NETWORK_ERROR' }), true);
    assert.equal(defaultRetryable({ code: 'AUTH_ERROR' }), false);
  });

  it('Retry-After 尊重：delayMs 返回 retryAfter 但不超过 maxDelay', () => {
    const p = createRetryPolicy({ maxDelayMs: 5000 });
    assert.equal(p.delayMs(0, 2000), 2000);
    assert.equal(p.delayMs(0, 99999), 5000, 'Retry-After 超过 maxDelay 时截断');
  });

  it('指数退避：attempt 越大延迟越大，且不超过 maxDelay', () => {
    const p = createRetryPolicy({ baseDelayMs: 100, maxDelayMs: 1000, jitter: 0 });
    const d0 = p.delayMs(0);
    const d1 = p.delayMs(1);
    const d2 = p.delayMs(2);
    assert.equal(d0, 100);
    assert.equal(d1, 200);
    assert.equal(d2, 400);
    assert.ok(p.delayMs(10) <= 1000, '指数退避有上界');
  });

  it('abortable sleep：signal 中止立即返回并 reject AbortError（不等满 delay）', async () => {
    const p = createRetryPolicy();
    const ac = new AbortController();
    const started = Date.now();
    const sleepPromise = p.sleep(5000, ac.signal);
    ac.abort();
    await assert.rejects(sleepPromise, (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal((err as Error).name, 'AbortError');
      return true;
    });
    assert.ok(Date.now() - started < 1000, 'abort 后 sleep 应即时返回');
  });

  it('§15: abort 后 sleep 必须 reject AbortError（而非 resolve 继续下一次 retry）', async () => {
    const p = createRetryPolicy();
    const ac = new AbortController();
    const sleepPromise = p.sleep(5000, ac.signal);
    ac.abort();
    await assert.rejects(sleepPromise, (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal((err as Error).name, 'AbortError', '中止必须抛 AbortError，供 ExecutionLoop 识别为 CANCELLED');
      return true;
    });
  });

  it('§15: 已 aborted 的 signal 调用 sleep 立即 reject AbortError', async () => {
    const p = createRetryPolicy();
    const ac = new AbortController();
    ac.abort();
    await assert.rejects(p.sleep(1000, ac.signal), (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.equal((err as Error).name, 'AbortError', '中止必须抛 AbortError，供 ExecutionLoop 识别为 CANCELLED');
      return true;
    });
  });

  it('默认 maxRetries=5：首次尝试加 5 次重试共 6 次尝试', () => {
    const p = createRetryPolicy({ jitter: 0 })
    const providerError = { statusCode: 503 }

    for (let attempt = 0; attempt < 5; attempt++) {
      assert.equal(p.shouldRetry(attempt, providerError), true)
    }
    assert.equal(p.shouldRetry(5, providerError), false)
  })
});

describe('core/models/circuit-breaker', () => {
  it('初始 CLOSED，allowRequest=true', () => {
    const cb = createCircuitBreaker();
    assert.equal(cb.state, 'closed');
    assert.equal(cb.allowRequest(), true);
  });

  it('连续失败达到阈值 → OPEN，allowRequest=false', () => {
    const cb = createCircuitBreaker({ failureThreshold: 3 });
    cb.recordFailure();
    cb.recordFailure();
    assert.equal(cb.state, 'closed');
    assert.equal(cb.allowRequest(), true);
    cb.recordFailure();
    assert.equal(cb.state, 'open');
    assert.equal(cb.allowRequest(), false, '熔断期间禁止请求');
  });

  it('熔断超时 → HALF_OPEN 放行探测；成功恢复 CLOSED', async () => {
    const cb = createCircuitBreaker({ failureThreshold: 2, openTimeoutMs: 50, successThreshold: 1 });
    cb.recordFailure();
    cb.recordFailure();
    assert.equal(cb.state, 'open');
    assert.equal(cb.allowRequest(), false);
    // 等熔断超时后，首次 allowRequest() 触发 half-open 探测
    await new Promise(r => setTimeout(r, 80));
    assert.equal(cb.allowRequest(), true, '超时后放行探测请求');
    assert.equal(cb.state, 'half-open', '探测请求后进入 half-open');
    cb.recordSuccess();
    assert.equal(cb.state, 'closed', '探测成功恢复 closed');
  });

  it('半开探测失败 → 重新 OPEN', async () => {
    const cb = createCircuitBreaker({ failureThreshold: 2, openTimeoutMs: 30 });
    cb.recordFailure();
    cb.recordFailure();
    await new Promise(r => setTimeout(r, 50));
    // 熔断超时后首次 allowRequest() 触发 half-open 探测
    assert.equal(cb.allowRequest(), true, '超时后放行探测');
    assert.equal(cb.state, 'half-open');
    cb.recordFailure();
    assert.equal(cb.state, 'open', '探测失败重新熔断');
    assert.equal(cb.allowRequest(), false);
  });

  it('reset 手动恢复 CLOSED', () => {
    const cb = createCircuitBreaker({ failureThreshold: 1 });
    cb.recordFailure();
    assert.equal(cb.state, 'open');
    cb.reset();
    assert.equal(cb.state, 'closed');
    assert.equal(cb.consecutiveFailures, 0);
  });
});
