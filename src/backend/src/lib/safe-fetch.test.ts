/**
 * SSRF IPv6/DNS 修复测试（Wave0-SS / P0-12/P0-13/P0-14）
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { isSafeFetchUrl, resolveAndValidateUrl } from './safe-fetch.js';
import { isSafeFetchUrl as searchIsSafe } from './search-tools/ssrf.js';

describe('safe-fetch IPv6（Wave0-SS：IPv6 字面量一律拒绝）', () => {
  test('REGRESSION-FIX: [::1] 回环被拒绝（此前 parseIpv4 不识别 IPv6 而放行）', () => {
    assert.equal(isSafeFetchUrl('http://[::1]:3000/api/export/all'), false);
  });

  test('REGRESSION-FIX: ::ffff:127.0.0.1（IPv4-mapped loopback）被拒绝', () => {
    assert.equal(isSafeFetchUrl('http://[::ffff:127.0.0.1]:3000/'), false);
  });

  test('REGRESSION-FIX: ::ffff:169.254.169.254（IPv4-mapped 云元数据）被拒绝', () => {
    assert.equal(isSafeFetchUrl('http://[::ffff:169.254.169.254]/latest/meta-data/'), false);
  });

  test('REGRESSION-FIX: fc00::/7（ULA 私网）被拒绝', () => {
    assert.equal(isSafeFetchUrl('http://[fc00::1]/'), false);
    assert.equal(isSafeFetchUrl('http://[fd12:3456:7890::1]/'), false);
  });

  test('REGRESSION-FIX: fe80::/10（link-local）被拒绝', () => {
    assert.equal(isSafeFetchUrl('http://[fe80::1]/'), false);
  });

  test('公网 IPv6 字面量也拒绝（保守策略：合法场景罕见，避免绕过面）', () => {
    assert.equal(isSafeFetchUrl('http://[2001:db8::1]/'), false);
  });

  test('IPv4 正常行为不受影响（本地 provider 字面量仍允许）', () => {
    assert.equal(isSafeFetchUrl('http://127.0.0.1:11434/v1'), true);
    assert.equal(isSafeFetchUrl('http://169.254.169.254/latest/meta-data/'), false);
  });
});

describe('resolveAndValidateUrl（Wave0-SS：DNS rebinding 防护）', () => {
  test('字面量 URL 直接判定（不触发 DNS lookup）', async () => {
    await assert.rejects(resolveAndValidateUrl('http://169.254.169.254/latest/meta-data/'), /SSRF/);
    // 本地 provider 字面量合法 → 通过
    await resolveAndValidateUrl('http://127.0.0.1:11434/v1');
  });

  test('元数据域名被字符串级拒绝', async () => {
    await assert.rejects(resolveAndValidateUrl('http://metadata.google.internal/computeMetadata/v1/'), /SSRF/);
  });

  test('非 http(s) 协议拒绝', async () => {
    await assert.rejects(resolveAndValidateUrl('file:///etc/passwd'), /SSRF|协议/i);
  });
});

describe('search-tools/ssrf 已统一复用 safe-fetch（Wave0-SS：单一基础设施）', () => {
  test('搜索模块的 isSafeFetchUrl 与 lib 版本行为一致（IPv6 也拒绝）', () => {
    assert.equal(searchIsSafe('http://[::1]:3000/'), false);
    assert.equal(searchIsSafe('http://[::ffff:169.254.169.254]/'), false);
    assert.equal(searchIsSafe('http://169.254.169.254/'), false);
    assert.equal(searchIsSafe('https://example.com/x'), true);
  });
});

describe('P1-24/25: publicOnly DNS 校验（公网抓取场景，provider 场景分离安全策略）', () => {
  test('P1-24: publicOnly 拒绝回环字面量（provider 允许、公网抓取拒绝）', async () => {
    const { assertPublicResolve } = await import('./safe-fetch.js');
    // provider 场景：本地 Ollama 合法（旧行为不变）
    await resolveAndValidateUrl('http://127.0.0.1:11434/v1');
    // 公网抓取场景：回环拒绝
    await assert.rejects(assertPublicResolve('http://127.0.0.1:3000/x'), /SSRF/);
    await assert.rejects(assertPublicResolve('http://localhost:3000/x'), /SSRF/);
  });

  test('P1-24: publicOnly 拒绝私网字面量（10.x / 172.16-31 / 192.168 / 0.0.0.0）', async () => {
    const { assertPublicResolve } = await import('./safe-fetch.js');
    await assert.rejects(assertPublicResolve('http://10.0.0.1/'), /SSRF/);
    await assert.rejects(assertPublicResolve('http://172.16.0.1/'), /SSRF/);
    await assert.rejects(assertPublicResolve('http://192.168.1.1/'), /SSRF/);
    await assert.rejects(assertPublicResolve('http://0.0.0.0/'), /SSRF/);
  });

  test('P1-24: publicOnly 允许公网 URL（安全基线不破坏）', async () => {
    const { assertPublicResolve } = await import('./safe-fetch.js');
    // 公网字面量直接通过（不触发 DNS）
    await assertPublicResolve('http://8.8.8.8/x');
    await assertPublicResolve('http://1.1.1.1/x');
  });
});