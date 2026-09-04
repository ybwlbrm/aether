import type { FastifyInstance } from 'fastify';
import { getLocalAuthToken } from '../../lib/auth-token.js';

export function registerAuthRoutes(app: FastifyInstance): void {
  // 获取本地认证 token（仅同源可读，受 Host 校验 + CSRF header + CORS 保护）
  app.get('/api/auth/token', {
    schema: {
      description: '获取本地认证 token（前端初始化时调用，用于后续敏感端点的 Authorization header）',
      tags: ['认证'],
      response: {
        200: {
          type: 'object',
          properties: {
            token: { type: 'string', description: '32 字节十六进制随机 token' },
          },
        },
        500: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
      },
    },
  }, async (_request, reply) => {
    const token = getLocalAuthToken();
    if (!token) {
      return reply.code(500).send({ error: 'Auth token not initialized' });
    }
    return { token };
  });
}