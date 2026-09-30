import type { FastifyInstance } from 'fastify';
import type { BackendConfig } from '../../config/index.js';
import { exportDir } from './utils.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';

/** 下载转换结果端点 */
export function registerDownloadRoutes(app: FastifyInstance, config: BackendConfig): void {
  app.get('/api/toolbox/download/:filename', {
    schema: { description: '下载转换后的文件', tags: ['工具箱'] },
  }, async (request, reply) => {
    const { filename } = request.params as { filename: string };
    const baseDir = exportDir(config);
    // P1-11 修复：文件名必须是服务端生成的 UUID.ext 格式，防任意路径/文件读取
    if (!/^[0-9a-f-]{36}\.[a-zA-Z0-9]{2,8}$/.test(filename)) {
      return reply.code(400).send({ error: '非法文件名' });
    }
    const filePath = resolve(baseDir, filename);
    if (relative(baseDir, filePath).startsWith('..') || !existsSync(filePath)) {
      return reply.code(404).send({ error: '文件不存在' });
    }
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    reply.type('application/octet-stream');
    return readFileSync(filePath);
  });
}