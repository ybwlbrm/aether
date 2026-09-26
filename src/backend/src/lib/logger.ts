/**
 * AEX-P2-005: 后端结构化日志入口（pino）
 *
 * 规范要求生产代码不出现 console.*（由 eslint.config.js 的 no-console 强制），
 * 统一改走本模块的结构化日志：
 *
 *   logger.info({ runId, taskId, attempt, event: 'retry_scheduled' }, '安排执行重试')
 *
 * 设计约束：
 * - 与 Fastify 内建 logger 共用同一份脱敏配置（LOGGER_REDACT），
 *   避免「改用 logger」反而让 API Key / Token 泄漏到日志。
 * - 不挂 pino-pretty transport：transport 会额外起 worker 线程，
 *   在单测与 electron 打包产物里容易残留句柄；结构化 JSON 才是本模块的目标形态。
 * - 级别非法时回落到默认级别：日志配置写错不该让进程起不来。
 */

import pino, { type Logger, type LoggerOptions } from 'pino';
import { LOGGER_REDACT } from './logger-config.js';

/** pino 支持的日志级别（含 silent，用于本地临时静音） */
const LOG_LEVELS = ['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

/** 默认 info：生产足够可追溯又不刷屏；排障用 LOG_LEVEL=debug 打开。 */
const DEFAULT_LOG_LEVEL: LogLevel = 'info';

/** 解析日志级别，大小写不敏感；未设置或非法值一律回落到默认级别。 */
export function resolveLogLevel(raw: string | undefined): LogLevel {
  if (raw === undefined) return DEFAULT_LOG_LEVEL;
  const match = LOG_LEVELS.find((level) => level === raw.toLowerCase());
  return match ?? DEFAULT_LOG_LEVEL;
}

/** 构建 pino 选项：与 Fastify logger 一致的脱敏 + 统一 service 标识。 */
export function buildLoggerOptions(env: NodeJS.ProcessEnv = process.env): LoggerOptions {
  return {
    level: resolveLogLevel(env.LOG_LEVEL),
    base: { service: 'aether-backend' },
    redact: LOGGER_REDACT,
  };
}

/** 后端结构化日志单例。 */
export const logger: Logger = pino(buildLoggerOptions());

export default logger;
