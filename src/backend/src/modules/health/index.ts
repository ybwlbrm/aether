import type { FastifyInstance } from 'fastify';

/** 当前 Aether 版本（与根 package.json / Android versionName 同步维护） */
export const AETHER_VERSION = '2.1.0';

/** 健康载荷（纯函数，供路由与测试复用） */
export function buildHealthPayload(): {
  status: string;
  app: string;
  name: string;
  version: string;
  timestamp: string;
} {
  return {
    status: 'ok',
    // E1-001 (P0 要求): 明确的 Aether 身份标识 —— 供 Electron/诊断判断
    // "3000 上跑的确实是 Aether 后端"（而非任意占用该端口的服务）
    app: 'aether',
    name: 'Aether',
    version: AETHER_VERSION,
    timestamp: new Date().toISOString(),
  };
}

export function registerHealthRoutes(app: FastifyInstance): void {
  app.get('/api/health', {
    schema: {
      description: '健康检查（含 Aether 身份标识，供 Electron 判定"这是 Aether"）',
      tags: ['系统'],
      response: {
        200: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            app: { type: 'string' },
            name: { type: 'string' },
            version: { type: 'string' },
            timestamp: { type: 'string' },
          },
        },
      },
    },
  }, async () => {
    return buildHealthPayload();
  });
}