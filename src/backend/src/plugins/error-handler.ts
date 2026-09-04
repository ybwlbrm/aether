import type { FastifyInstance, FastifyError } from 'fastify';
import { AppError } from '@pacc/shared';

export function registerErrorHandler(app: FastifyInstance): void {
  app.setErrorHandler((error: FastifyError | AppError | Error, _request, reply) => {
    if (error instanceof AppError) {
      return reply.status(error.statusCode).send({
        error: {
          code: error.code,
          message: error.message,
          details: error.details,
        },
      });
    }

    // Fastify validation errors
    const fastifyError = error as FastifyError;
    if (fastifyError.validation) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_ERROR',
          message: '请求参数验证失败',
          details: fastifyError.validation,
        },
      });
    }

    // Fastify 已知错误：保留原始状态码（400/404/415 等），不要一律转成 500
    if (fastifyError.statusCode && fastifyError.statusCode >= 400 && fastifyError.statusCode < 500) {
      return reply.status(fastifyError.statusCode).send({
        error: {
          code: fastifyError.code || 'BAD_REQUEST',
          message: fastifyError.message || '请求错误',
        },
      });
    }

    // 未知错误
    console.error('未处理的错误:', error);
    return reply.status(500).send({
      error: {
        code: 'INTERNAL_ERROR',
        message: '服务器内部错误',
      },
    });
  });
}