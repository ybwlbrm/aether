import { readdirSync, existsSync, statSync, lstatSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import {
  GLOB_SKIP_DIRS,
  GLOB_HARD_LIMIT,
} from './constants.js';
import { isPathSafe, resolveSearchPath } from './path-utils.js';
import { globToRegExp } from './glob-utils.js';

/**
 * glob — 按文件名/glob 模式递归搜索文件
 * 返回换行分隔的匹配文件绝对路径列表
 */
export function executeGlob(
  pattern: string,
  path?: string,
  allowedDirs?: string[],
  permissionLevel?: number,
  defaultDir?: string,
): string {
  try {
    if (!pattern || !pattern.trim()) return '错误: 请提供 glob 模式';

    const rootDir = resolveSearchPath(path, defaultDir);
    const check = isPathSafe(rootDir, allowedDirs, permissionLevel);
    if (!check.ok) return `错误: ${check.error}`;
    if (!existsSync(rootDir)) return `错误: 目录不存在: ${rootDir}`;

    let rootStat;
    try { rootStat = statSync(rootDir); } catch { return `错误: 无法读取目录: ${rootDir}`; }
    if (!rootStat.isDirectory()) return `错误: 不是有效的目录: ${rootDir}`;

    const normalizedPattern = pattern.trim().replace(/\\/g, '/');
    const pathRegex = globToRegExp(normalizedPattern);
    // 不含 '/' 的纯文件名模式（如 *.ts）：额外按 basename 在所有层级匹配
    const matchBasename = !normalizedPattern.includes('/');
    const basenameRegex = matchBasename ? globToRegExp(normalizedPattern.split('/').pop() || normalizedPattern) : null;

    const results: string[] = [];
    let truncated = false;

    const walk = (dir: string, depth: number): void => {
      if (truncated) return;
      let entries: string[];
      try { entries = readdirSync(dir); } catch { return; }
      for (const name of entries) {
        if (GLOB_SKIP_DIRS.has(name)) continue;
        const fullPath = resolve(dir, name);
        let lst;
        try { lst = lstatSync(fullPath); } catch { continue; }
        if (lst.isSymbolicLink()) continue; // 不跟随符号链接，防止逃逸出允许目录
        if (lst.isDirectory()) {
          walk(fullPath, depth + 1);
        } else if (lst.isFile()) {
          // 以 '/' 分隔的相对路径参与匹配（跨平台统一）
          const relPath = relative(rootDir, fullPath).split(sep).join('/');
          if (pathRegex.test(relPath) || (basenameRegex && basenameRegex.test(name))) {
            results.push(fullPath);
            if (results.length >= GLOB_HARD_LIMIT) { truncated = true; return; }
          }
        }
      }
    };

    walk(rootDir, 0);

    if (results.length === 0) return `未找到匹配 "${pattern}" 的文件`;
    const header = `找到 ${results.length}${truncated ? '+（已达上限，结果被截断）' : ''} 个匹配 "${pattern}" 的文件:`;
    return `${header}\n${results.join('\n')}`;
  } catch (e: unknown) {
    return `工具执行错误: ${(e instanceof Error ? e.message : String(e))}`;
  }
}