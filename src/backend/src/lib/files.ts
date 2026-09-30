/**
 * 文件操作工具 — 供 AI Agent 通过 function calling 操控本地文件
 * 安全限制：只能在 allowedDirs 目录内操作，禁止访问敏感路径
 * P0-7: 始终校验 allowedDirs（Level 2 不再跳过），FORBIDDEN_PATHS 通用化
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, unlinkSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { checkPathSafe as isPathSafe } from './path-guard.js';

// W4-3: isPathSafe 已统一至 lib/path-guard.ts（checkPathSafe），签名完全一致

export const fileTools = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取文件内容（文本文件）',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径（绝对路径或相对路径）' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '写入文件内容（会覆盖已有文件）',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件路径' },
          content: { type: 'string', description: '文件内容' },
        },
        required: ['path', 'content'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_files',
      description: '列出目录中的文件和子目录',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '目录路径' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: '删除文件（注意：此操作不可恢复）',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '要删除的文件路径' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'create_directory',
      description: '创建目录（包括父目录）',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '要创建的目录路径' },
        },
        required: ['path'],
      },
    },
  },
];

// 文件读取缓存 — 防止 AI 在同一轮对话中重复读取同一文件
const readFileCache = new Set<string>();

export function clearReadFileCache(): void {
  readFileCache.clear();
}

export async function executeFileTool(name: string, args: any, allowedDirs: string[], defaultDir?: string, permissionLevel?: number): Promise<string> {
  try {
    // 权限检查：Level 1 只允许读操作
    if (permissionLevel === 1) {
      const readOnlyOps = ['read_file', 'list_files'];
      if (!readOnlyOps.includes(name)) {
        return `权限不足：当前为 Level 1（只读）模式，不允许执行 "${name}" 操作。请切换到 Level 2 以允许写操作。`;
      }
    }

    // 路径解析：所有 Level 都受 allowedDirs 限制（P0-7 已修复）
    const resolvePath = (p: string) => {
      if (!p || p.trim() === '') {
        throw new Error(`请指定文件路径。默认工作目录: ${defaultDir || '未设置'}`);
      }
      if (p.startsWith('./') || p.startsWith('.\\') || (!p.includes(':') && !p.startsWith('/'))) {
        return resolve(defaultDir || process.cwd(), p);
      }
      return resolve(p);
    };

    switch (name) {
      case 'read_file': {
        const fullPath = resolvePath(args.path);
        const check = isPathSafe(fullPath, allowedDirs, permissionLevel);
        if (!check.ok) return `错误: ${check.error}`;
        if (!existsSync(fullPath)) return `错误: 文件不存在: ${fullPath}`;
        // 重复读取检测：同一轮对话中已读过的文件不再返回全文，避免 AI 反复读取
        if (readFileCache.has(fullPath)) {
          return `[文件已读取] ${fullPath} 已在上一轮读取过，内容不变，请直接基于已有内容分析。`;
        }
        readFileCache.add(fullPath);
        const content = readFileSync(fullPath, 'utf-8');
        return `文件内容 (${fullPath}):\n\`\`\`\n${content}\n\`\`\``;
      }
      case 'write_file': {
        const fullPath = resolvePath(args.path);
        const check = isPathSafe(fullPath, allowedDirs, permissionLevel);
        if (!check.ok) return `错误: ${check.error}`;
        const dir = resolve(fullPath, '..');
        if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
        writeFileSync(fullPath, args.content, 'utf-8');
        return `文件已写入: ${fullPath} (${Buffer.byteLength(args.content, 'utf-8')} 字节)`;
      }
      case 'list_files': {
        const fullPath = resolvePath(args.path);
        const check = isPathSafe(fullPath, allowedDirs, permissionLevel);
        if (!check.ok) return `错误: ${check.error}`;
        if (!existsSync(fullPath)) return `错误: 目录不存在: ${fullPath}`;
        const items = readdirSync(fullPath);
        // 输出 markdown 表格格式，方便 Streamdown 渲染为表格
        const rows = items.map(name => {
          const full = resolve(fullPath, name);
          try {
            const s = statSync(full);
            const isDir = s.isDirectory();
            const ext = isDir ? '📁' : name.includes('.') ? name.split('.').pop()!.toUpperCase() : '-';
            const size = s.isFile() ? (s.size < 1024 ? `${s.size} B` : (s.size / 1024).toFixed(1) + ' KB') : '-';
            return `| ${name} | ${ext} | ${size} |`;
          } catch { return `| ${name} | - | - |`; }
        });
        const header = '| 文件名 | 类型 | 大小 |\n| --- | --- | --- |';
        return `目录 ${fullPath} 的内容:\n${header}\n${rows.join('\n')}`;
      }
      case 'delete_file': {
        const fullPath = resolvePath(args.path);
        const check = isPathSafe(fullPath, allowedDirs, permissionLevel);
        if (!check.ok) return `错误: ${check.error}`;
        if (!existsSync(fullPath)) return `错误: 文件不存在: ${fullPath}`;
        unlinkSync(fullPath);
        return `文件已删除: ${fullPath}`;
      }
      case 'create_directory': {
        const fullPath = resolvePath(args.path);
        const check = isPathSafe(fullPath, allowedDirs, permissionLevel);
        if (!check.ok) return `错误: ${check.error}`;
        mkdirSync(fullPath, { recursive: true });
        return `目录已创建: ${fullPath}`;
      }
      default:
        return `未知工具: ${name}`;
    }
  } catch (e: unknown) {
    return `工具执行错误: ${(e instanceof Error ? e.message : String(e))}`;
  }
}