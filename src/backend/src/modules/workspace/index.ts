import type { FastifyInstance } from 'fastify';
import type { BackendConfig } from '../../config/index.js';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { getWorkspaceContext } from '../../core/workspace/workspace-context.js';

interface FileEntry {
  name: string;
  path: string;
  type: 'file' | 'dir';
  size: number;
  children?: FileEntry[];
}

function scanDir(dirPath: string, maxDepth: number = 2, currentDepth: number = 0): FileEntry[] {
  if (currentDepth > maxDepth) return [];
  try {
    const entries = readdirSync(dirPath);
    const result: FileEntry[] = [];
    for (const name of entries) {
      if (name.startsWith('.') || name === 'node_modules') continue;
      const fullPath = resolve(dirPath, name);
      try {
        const stat = statSync(fullPath);
        if (stat.isDirectory()) {
          result.push({
            name,
            path: fullPath,
            type: 'dir',
            size: 0,
            children: scanDir(fullPath, maxDepth, currentDepth + 1),
          });
        } else {
          result.push({ name, path: fullPath, type: 'file', size: stat.size });
        }
      } catch { continue; }
    }
    return result;
  } catch { return []; }
}

export function registerWorkspaceRoutes(app: FastifyInstance, _config: BackendConfig): void {
  app.get('/api/workspace', {
    schema: { description: '获取工作目录和文件树', tags: ['工作区'] },
  }, async (request, reply) => {
    // 整改计划第 2 章：WorkspaceContext 为唯一来源 ——
    // 不再自行读 settings.allowedDirs/defaultDir，统一 canonical resolved path
    const ctx = await getWorkspaceContext(_config);
    const resolvedDir = ctx.defaultDir;
    const isAllowed = ctx.isWithinAllowed(resolvedDir);
    if (!isAllowed) {
      return reply.code(403).send({ error: `目录 "${resolvedDir}" 不在允许的目录列表内` });
    }
    const tree = scanDir(resolvedDir);
    return { defaultDir: resolvedDir, allowedDirs: ctx.allowedDirs, tree };
  });
}
