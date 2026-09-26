import type { FastifyInstance } from 'fastify';
import type { BackendConfig } from '../../config/index.js';
import { exportDir } from './utils.js';
import { existsSync, readFileSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
// AEX-P0-29: 统一 path-guard —— realpath 解析后校验仍落在 exportDir 内，
// 防 exportDir 内 junction/symlink 指向外部目录的读取逃逸（替代自建 relative 判断）
import { resolvePhysicalPath } from '../../lib/path-guard.js';

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
    // AEX-P0-29: 物理路径解析校验（realpath 防 junction/symlink 逃逸），替换自建 relative 判断
    if (!existsSync(filePath)) {
      return reply.code(404).send({ error: '文件不存在' });
    }
    const physical = resolvePhysicalPath(filePath);
    const basePhysical = resolvePhysicalPath(baseDir);
    const basePrefix = basePhysical.endsWith(sep) ? basePhysical : basePhysical + sep;
    if (!physical.startsWith(basePrefix) && physical !== basePhysical) {
      return reply.code(403).send({ error: '路径不在允许目录内' });
    }
    reply.header('Content-Disposition', `attachment; filename="${filename}"`);
    reply.type('application/octet-stream');
    return readFileSync(physical);
  });
}