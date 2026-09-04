import { readdirSync, readFileSync, existsSync, statSync, lstatSync } from 'node:fs';
import { resolve, sep } from 'node:path';
import {
  GREP_SKIP_DIRS,
  GREP_MAX_DEPTH,
  GREP_MAX_FILE_SIZE,
  GREP_HARD_LIMIT,
  GREP_LINE_PREVIEW,
} from './constants.js';
import { isPathSafe, resolveSearchPath } from './path-utils.js';
import { compileIncludeFilter } from './glob-utils.js';
import { isTextFile } from './text-utils.js';

/**
 * grep — 使用正则表达式递归搜索文件内容
 * 返回格式：`filepath:line: matched text`
 */
export function executeGrep(
  pattern: string,
  path?: string,
  include?: string,
  maxResults?: number,
  allowedDirs?: string[],
  permissionLevel?: number,
  defaultDir?: string,
): string {
  try {
    if (!pattern || !pattern.trim()) return '错误: 请提供正则表达式模式';

    const rootDir = resolveSearchPath(path, defaultDir);
    const check = isPathSafe(rootDir, allowedDirs, permissionLevel);
    if (!check.ok) return `错误: ${check.error}`;
    if (!existsSync(rootDir)) return `错误: 路径不存在: ${rootDir}`;

    // smart-case：模式含大写字母时区分大小写，否则忽略大小写（与 ripgrep 惯例一致）
    let regex: RegExp;
    try {
      regex = new RegExp(pattern, /[A-Z]/.test(pattern) ? '' : 'i');
    } catch (e: unknown) {
      return `错误: 无效的正则表达式: ${(e instanceof Error ? e.message : String(e))}`;
    }

    const limit = Math.max(1, Math.min(maxResults ?? 50, GREP_HARD_LIMIT));
    const includeMatcher = compileIncludeFilter(include);

    const matches: string[] = [];
    let truncated = false;

    /** 在单个文件中执行正则匹配 */
    const searchFile = (fullPath: string): void => {
      if (truncated) return;
      if (includeMatcher && !includeMatcher(fullPath.split(sep).pop() || '')) return;
      if (!isTextFile(fullPath.split(sep).pop() || '')) return;
      let stat;
      try { stat = statSync(fullPath); } catch { return; }
      if (!stat.isFile() || stat.size > GREP_MAX_FILE_SIZE) return;
      try {
        const content = readFileSync(fullPath, 'utf-8');
        if (content.includes('\u0000')) return; // 二进制文件，跳过
        const lines = content.split('\n');
        for (let i = 0; i < lines.length; i++) {
          regex.lastIndex = 0;
          if (regex.test(lines[i])) {
            matches.push(`${fullPath}:${i + 1}: ${lines[i].trim().slice(0, GREP_LINE_PREVIEW)}`);
            if (matches.length >= limit) { truncated = true; return; }
          }
        }
      } catch { /* 读取失败（权限/编码），跳过 */ }
    };

    // 根路径本身是文件时，只搜该文件
    let rootStat;
    try { rootStat = statSync(rootDir); } catch { return `错误: 无法读取路径: ${rootDir}`; }
    if (rootStat.isFile()) {
      searchFile(rootDir);
      return matches.length > 0
        ? `找到 ${matches.length} 处匹配 "${pattern}":\n${matches.join('\n')}`
        : `未找到匹配 "${pattern}" 的内容`;
    }
    if (!rootStat.isDirectory()) return `错误: 不是有效的目录或文件: ${rootDir}`;

    /** 递归遍历目录（最大深度 5，跳过 node_modules/.git/dist 与符号链接） */
    const walk = (dir: string, depth: number): void => {
      if (depth > GREP_MAX_DEPTH || truncated) return;
      let entries: string[];
      try { entries = readdirSync(dir); } catch { return; }
      for (const name of entries) {
        if (truncated) return;
        if (GREP_SKIP_DIRS.has(name)) continue;
        const fullPath = resolve(dir, name);
        let lst;
        try { lst = lstatSync(fullPath); } catch { continue; }
        if (lst.isSymbolicLink()) continue; // 不跟随符号链接，防止逃逸出允许目录
        if (lst.isDirectory()) {
          walk(fullPath, depth + 1);
        } else if (lst.isFile()) {
          searchFile(fullPath);
        }
      }
    };

    walk(rootDir, 0);

    if (matches.length === 0) return `未找到匹配 "${pattern}" 的内容`;
    const header = `找到 ${matches.length}${truncated ? '+（已达上限，结果被截断）' : ''} 处匹配 "${pattern}":`;
    return `${header}\n${matches.join('\n')}`;
  } catch (e: unknown) {
    return `工具执行错误: ${(e instanceof Error ? e.message : String(e))}`;
  }
}