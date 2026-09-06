import type { FastifyInstance } from 'fastify';
import type { BackendConfig } from '../../config/index.js';
import { readdirSync, statSync, existsSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { getSettings } from '../../lib/dal.js';

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
    const settings = await getSettings();
    const allowedDirs = settings.allowedDirs || ['./data'];
    const defaultDir = settings.defaultDir || allowedDirs[0] || process.cwd();
    const resolvedDir = resolve(defaultDir);
    // P1-3 修复：校验 defaultDir 必须在 allowedDirs 内，防止扫描泄露整个文件系统
    // （settings.json 若被篡改为 C:\ 或 C:\Windows 等，将递归泄露全盘目录树）
    // B4 修复：路径比较统一 toLowerCase()（Windows 大小写不敏感，避免 D:\gongzuo vs d:\gongzuo 误判 403）
    const resolvedLower = resolvedDir.toLowerCase();
    const isAllowed = allowedDirs.some((d: string) => {
      const abs = resolve(d).toLowerCase();
      return resolvedLower === abs || resolvedLower.startsWith(abs + sep);
    });
    if (!isAllowed) {
      return reply.code(403).send({ error: `目录 "${resolvedDir}" 不在允许的目录列表内` });
    }
    const tree = scanDir(resolvedDir);
    return { defaultDir: resolvedDir, allowedDirs, tree };
  });
}
