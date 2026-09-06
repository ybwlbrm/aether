import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildHealthPayload, AETHER_VERSION } from './modules/health/index.js';

describe('backend health (E1-001: Aether identity)', () => {
  it('returns an explicit aether identity (Electron 不再猜端口占用即成功)', () => {
    const p = buildHealthPayload();
    assert.equal(p.status, 'ok');
    assert.equal(p.app, 'aether', '必须暴露 Aether 应用标识');
    assert.ok(/aether/i.test(p.name), 'name 应含 aether');
  });

  it('version 与根版本一致（2.1.0）', () => {
    assert.equal(AETHER_VERSION, '2.1.0');
    assert.match(buildHealthPayload().version, /^\d+\.\d+\.\d+$/);
  });

  it('timestamp 为合法 ISO 字符串', () => {
    const ts = buildHealthPayload().timestamp;
    assert.ok(!Number.isNaN(Date.parse(ts)), `timestamp 非法: ${ts}`);
  });
});