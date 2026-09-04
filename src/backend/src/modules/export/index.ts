import type { FastifyInstance } from 'fastify';
import type { BackendConfig } from '../../config/index.js';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { resolve, basename, sep } from 'node:path';
import { randomUUID } from 'node:crypto';

export function registerExportRoutes(app: FastifyInstance, config: BackendConfig): void {
  const exportDir = resolve(config.dataDir, 'export');
  if (!existsSync(exportDir)) mkdirSync(exportDir, { recursive: true });

  // 导出数据
  app.post('/api/export', {
    schema: {
      description: '导出数据（CSV/JSON/Markdown）',
      tags: ['导出'],
      body: {
        type: 'object',
        required: ['format', 'data'],
        properties: {
          format: { type: 'string', enum: ['csv', 'json', 'markdown'] },
          data: { type: 'array' },
          filename: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body as { format: string; data: any[]; filename?: string };
    let content = '';
    // P0-7: filename 路径穿越防护 — 只允许纯 basename，不含路径分隔符或 ..
    const rawFilename = body.filename || `export-${Date.now()}`;
    const safeFilename = basename(rawFilename);
    if (safeFilename !== rawFilename || safeFilename.includes('..')) {
      return reply.code(400).send({ error: '非法文件名' });
    }
    const filename = safeFilename;

    if (body.format === 'json') {
      content = JSON.stringify(body.data, null, 2);
    } else if (body.format === 'csv') {
      if (body.data.length > 0) {
        const headers = Object.keys(body.data[0]);
        content = headers.join(',') + '\n';
        content += body.data.map(row =>
          headers.map(h => {
            const val = row[h]?.toString() || '';
            return val.includes(',') ? `"${val}"` : val;
          }).join(',')
        ).join('\n');
      }
    } else {
      content = body.data.map((item: any) => {
        const title = item.title || item.name || 'Item';
        const url = item.url || '';
        const desc = item.snippet || item.description || '';
        return `## ${title}\n${desc ? desc + '\n' : ''}${url ? `[${url}](${url})\n` : ''}`;
      }).join('\n---\n');
    }

    const outputPath = resolve(exportDir, `${filename}.${body.format}`);
    writeFileSync(outputPath, content, 'utf-8');
    return { success: true, path: `/api/export/download/${filename}.${body.format}` };
  });

  // 下载导出文件
  app.get('/api/export/download/:filename', {
    schema: { description: '下载导出文件', tags: ['导出'] },
  }, async (request, reply) => {
    const { filename } = request.params as { filename: string };
    // SEC-006: 拒绝包含路径分隔符的文件名，防止路径穿越
    if (filename.includes('/') || filename.includes('\\')) {
      return reply.code(403).send({ error: '非法路径' });
    }
    const filePath = resolve(exportDir, filename);
    // SEC-006: 使用 startsWith 校验，替代有缺陷的 relative() 逻辑
    const exportDirResolved = resolve(exportDir);
    if (!filePath.startsWith(exportDirResolved + sep)) {
      return reply.code(403).send({ error: '非法路径' });
    }
    if (!existsSync(filePath)) return reply.code(404).send({ error: '文件不存在' });
    return readFileSync(filePath, 'utf-8');
  });
}