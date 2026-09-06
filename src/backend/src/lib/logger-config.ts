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

/** pino redact 配置（Fastify logger 直接透传） */
export const LOGGER_REDACT: { paths: string[]; censor: string } = {
  paths: [
    // 请求头
    'req.headers.authorization',
    'res.headers["set-cookie"]',
    'req.headers["x-csrf-token"]',
    'req.headers.cookie',
    // 请求体常见密钥字段
    'req.body.apiKey',
    'req.body.api_key',
    'req.body.password',
    'req.body.secret',
    'req.body.token',
    'req.body.key',
    // 通配：覆盖嵌套/重命名对象
    '*.apiKey',
    '*.api_key',
    '*.password',
    '*.secret',
    '*.token',
    '*.authorization',
  ],
  censor: '[REDACTED]',
};

/**
 * 构建 Fastify logger 配置
 * - production：默认 pino（不依赖 pino-pretty，避免打包崩溃）+ redact
 * - 其他环境：pino-pretty + redact
 *
 * 返回类型标注为 Fastify 接受的 logger 选项联合，避免调用方使用类型压制。
 */
import type { FastifyServerOptions } from 'fastify';

type FastifyLoggerOption = NonNullable<FastifyServerOptions['logger']>;

export function buildLoggerConfig(
  env: string | undefined = process.env.NODE_ENV,
  cwd: string = process.cwd(),
): FastifyLoggerOption {
  if (env === 'production') {
    return { redact: LOGGER_REDACT } as FastifyLoggerOption;
  }
  return {
    transport: {
      target: 'pino-pretty' as const,
      options: { colorize: true, cwd },
    },
    redact: LOGGER_REDACT,
  } as FastifyLoggerOption;
}