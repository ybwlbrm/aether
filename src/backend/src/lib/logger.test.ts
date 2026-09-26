/**
 * AEX-P2-005: 后端结构化日志（lib/logger.ts）
 *
 * 锁定的行为：
 * 1. 日志级别解析（默认 info / 大小写不敏感 / 非法值回落）
 * 2. 与 Fastify logger 共用 LOGGER_REDACT，换 logger 不会泄漏密钥
 * 3. 输出形态为结构化 JSON：自定义字段 + msg 同时落盘
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { Writable } from 'node:stream';
import pino from 'pino';
import { LOGGER_REDACT } from './logger-config.js';
import { buildLoggerOptions, resolveLogLevel } from './logger.js';

function captureLogger(level: string) {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      lines.push(chunk.toString());
      callback();
    },
  });
  return { log: pino(buildLoggerOptions({ LOG_LEVEL: level }), stream), lines };
}

describe('AEX-P2-005 resolveLogLevel', () => {
  test('未设置 LOG_LEVEL 时回落到 info', () => {
    assert.equal(resolveLogLevel(undefined), 'info');
  });

  test('合法级别大小写不敏感', () => {
    assert.equal(resolveLogLevel('DEBUG'), 'debug');
    assert.equal(resolveLogLevel('Warn'), 'warn');
    assert.equal(resolveLogLevel('silent'), 'silent');
  });

  test('非法级别回落到 info 而不是抛错', () => {
    assert.equal(resolveLogLevel('verbose'), 'info');
    assert.equal(resolveLogLevel(''), 'info');
  });
});

describe('AEX-P2-005 buildLoggerOptions', () => {
  test('复用 LOGGER_REDACT 脱敏路径', () => {
    assert.deepEqual(buildLoggerOptions().redact, LOGGER_REDACT);
  });

  test('带 service 标识便于多进程日志区分', () => {
    const base = buildLoggerOptions().base;
    assert.equal(typeof base === 'object' && base !== null ? base.service : undefined, 'aether-backend');
  });
});

describe('AEX-P2-005 结构化输出', () => {
  test('自定义字段与消息同时落盘为单行 JSON', () => {
    const { log, lines } = captureLogger('info');
    log.info({ runId: 'run-1', taskId: 'task-1', attempt: 2, event: 'retry_scheduled' }, '安排执行重试');

    assert.equal(lines.length, 1);
    const entry: Record<string, unknown> = JSON.parse(lines[0]!);
    assert.equal(entry.runId, 'run-1');
    assert.equal(entry.taskId, 'task-1');
    assert.equal(entry.attempt, 2);
    assert.equal(entry.event, 'retry_scheduled');
    assert.equal(entry.msg, '安排执行重试');
  });

  test('silent 级别不产生任何输出', () => {
    const { log, lines } = captureLogger('silent');
    log.error({ event: 'should_be_suppressed' }, '不应出现');
    assert.equal(lines.length, 0);
  });

  test('R13: 实际输出中 apiKey/authorization/token 被脱敏（端到端 redact 有效性）', () => {
    const { log, lines } = captureLogger('info');
    const secretKey = 'sk-this-is-a-super-secret-key-value-123456';
    log.info(
      {
        runId: 'run-1',
        providerId: 'p1',
        // *.apiKey 通配（单级嵌套）
        provider: { apiKey: secretKey, name: 'deepseek' },
        // req.headers.authorization 显式路径（Fastify 风格）
        req: { headers: { authorization: `Bearer ${secretKey}` } },
        // 顶层裸 token
        token: secretKey,
      },
      '调用模型',
    );

    assert.equal(lines.length, 1);
    const raw = lines[0]!;
    // 关键断言：真实密钥绝不出现
    assert.ok(!raw.includes(secretKey), '真实密钥不得出现在日志输出中');
    // 且对应位置出现脱敏占位符
    assert.ok(raw.includes('[REDACTED]'), '脱敏占位符应出现');
  });
});
