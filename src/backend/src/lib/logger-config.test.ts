/**
 * SEC-003: 日志脱敏配置
 *
 * 背景：默认 pino 配置无 redact，若生产日志记录了请求头/请求体/错误对象，
 * API Key、Password、Token 等敏感字段可能泄露到日志文件。
 * 本模块提供统一的 redact 配置（Fastify logger），确保：
 * - Authorization 头整体脱敏
 * - 常见密钥字段（apiKey/api_key/password/secret/token）按路径脱敏
 * - 通配路径（*.apiKey 等）覆盖嵌套对象
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { LOGGER_REDACT, buildLoggerConfig } from './logger-config.js';

describe('logger redact config (SEC-003)', () => {
  test('redact paths 包含 Authorization 头与密钥字段', () => {
    assert.ok(LOGGER_REDACT.paths.includes('req.headers.authorization'));
    assert.ok(LOGGER_REDACT.paths.includes('req.body.apiKey'));
    assert.ok(LOGGER_REDACT.paths.includes('req.body.password'));
    assert.ok(LOGGER_REDACT.paths.includes('*.apiKey'));
    assert.ok(LOGGER_REDACT.paths.includes('*.token'));
  });

  test('censor 使用不可逆占位符', () => {
    assert.equal(LOGGER_REDACT.censor, '[REDACTED]');
  });

  test('production 配置启用 redact', () => {
    const cfg = buildLoggerConfig('production');
    assert.ok(typeof cfg === 'object' && 'redact' in cfg);
    assert.ok(!('transport' in cfg));
  });

  test('development 配置同时启用 redact 与 pretty transport', () => {
    const cfg = buildLoggerConfig('development');
    assert.ok(typeof cfg === 'object' && 'redact' in cfg);
    assert.ok('transport' in cfg);
  });
});