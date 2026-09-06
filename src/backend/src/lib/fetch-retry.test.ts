/**
 * fetch-retry 修复测试（Wave0-FR）：
 * - 404 不再同时是 Retryable 与 Non-Retryable（必须直接 throw，不触发重试）
 * - Retry-After 支持 delta-seconds 与 HTTP-date，非法值安全兜底
 * - retry sleep 支持 AbortSignal（取消立即结束等待）
 * - options 类型化为 RequestInit
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseRetryAfter, sleep, fetchWithRetry } from './fetch-retry.js';

describe('parseRetryAfter（Wave0-FR）', () => {
  test('delta-seconds 数字', () => {
    assert.equal(parseRetryAfter('30'), 30000);
    assert.equal(parseRetryAfter('0'), 0);
  });

  test('超过 120s 上限被夹紧', () => {
    assert.equal(parseRetryAfter('999'), 120000);
  });

  test('HTTP-date 格式差值（0~120s 夹紧）', () => {
    const future = new Date(Date.now() + 5000).toUTCString(); // 5 秒后的 UTC 日期
    const d = parseRetryAfter(future);
    assert.ok(d !== null && d > 0 && d <= 120000, `HTTP-date 应解析为等待毫秒，得到 ${d}`);
    // 过去的日期 → 0
    const past = new Date(Date.now() - 5000).toUTCString();
    assert.equal(parseRetryAfter(past), 0);
  });

  test('非法值 → null（走默认延迟，不做 setTimeout(NaN)）', () => {
    assert.equal(parseRetryAfter('garbage'), null);
    assert.equal(parseRetryAfter(''), null);
    assert.equal(parseRetryAfter(null), null);
  });
});

describe('sleep 可中断（Wave0-FR）', () => {
  test('abort 后立即 reject AbortError（不等完整个 delay）', async () => {
    const ctrl = new AbortController();
    const p = sleep(60_000, ctrl.signal);
    setTimeout(() => ctrl.abort(), 50);
    await assert.rejects(p, (e: unknown) => (e as Error).name === 'AbortError');
  });

  test('正常等待后 resolve', async () => {
    const t0 = Date.now();
    await sleep(30);
    assert.ok(Date.now() - t0 >= 20);
  });

  test('已 aborted 的 signal 立即 reject', async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    await assert.rejects(sleep(1000, ctrl.signal), /AbortError|aborted/i);
  });
});

describe('fetchWithRetry 状态码语义（Wave0-FR）', () => {
  test('REGRESSION-FIX: 404 直接 throw，不再走 retry（sseSend 不收到 retry 事件）', async () => {
    const retried: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => new Response('not found', { status: 404 });
    try {
      await assert.rejects(
        fetchWithRetry('http://x.test/v1/chat/completions', { method: 'POST' }, (ev, data) => { retried.push(`${ev}:${data}`); }, 3),
        /404/,
      );
      assert.equal(retried.length, 0, '404 不得触发 retry 事件');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('429 + Retry-After:0 → 立即重试并成功；sseSend 收到一次 retry', async () => {
    let calls = 0;
    const retried: string[] = [];
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async () => {
      calls++;
      if (calls === 1) return new Response(null, { status: 429, headers: { 'Retry-After': '0' } });
      return new Response('ok', { status: 200 });
    };
    try {
      const res = await fetchWithRetry('http://x.test/v1/chat/completions', { method: 'POST' }, (ev, data) => { retried.push(`${ev}:${data}`); }, 3);
      assert.equal(res.status, 200);
      assert.equal(calls, 2, '应重试一次');
      assert.equal(retried.length, 1);
      assert.ok(retried[0].startsWith('retry:'));
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});