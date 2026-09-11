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

  it('abortable sleep：signal 中止立即返回（不等满 delay）', async () => {
    const p = createRetryPolicy();
    const ac = new AbortController();
    const started = Date.now();
    const sleepPromise = p.sleep(5000, ac.signal);
    ac.abort();
    await sleepPromise;
    assert.ok(Date.now() - started < 1000, 'abort 后 sleep 应即时返回');
  });
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
