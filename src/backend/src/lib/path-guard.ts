/**
 * 路径安全守卫（W4-3：统一 files / path-utils / lsp-client / code-review / media / documents / data 的 7 个变体）
 *
 * 统一最强语义（合并自 lib/files.ts 与 lib/search-tools/path-utils.ts）：
 *  1. Level 3（超级）绕过路径限制（保留原设计，允许全局访问）
 *  2. 必须命中 allowedDirs（resolve 后 startsWith(sep) 或相等）
 *  3. 按「路径段」匹配 FORBIDDEN_PATH_PATTERNS（避免误伤合法路径）
 *  4. 阻止访问用户 .config/AppData 配置目录
 *
 * 提供 4 个 API 以兼容现有 7 处调用签名：
 *  - checkPathSafe(): { ok, error? }  — files.ts / path-utils.ts 原签名
 *  - isPathSafe(): boolean            — lsp-client / code-review / media / documents 原签名
 *  - isPathInAllowedDirs(): boolean   — data/utils + data/settings 原签名（仅 allowedDirs 校验）
 *  - isPathAllowed(): boolean         — data/utils 原签名（敏感路径 + allowedDirs）
 */

import { resolve, sep } from 'node:path';
import { homedir } from 'node:os';

/** 敏感路径段（路径按分隔符拆分后逐段匹配） */
const FORBIDDEN_PATH_PATTERNS = [
  'windows', 'program files', 'program files (x86)', 'system32',
  '/etc', '/root', '/boot', '/sbin', '/bin', '/usr/bin',
  '.git',
];

const HOME_DIR = homedir().toLowerCase();

export interface PathCheckResult {
  ok: boolean;
  error?: string;
}

/** 完整校验：allowedDirs 包含性 + 敏感路径段 + 用户配置目录防护 */
export function checkPathSafe(
  targetPath: string,
  allowedDirs?: string[],
  permissionLevel?: number,
): PathCheckResult {
  if (!targetPath) {
    return { ok: false, error: '路径为空' };
  }
  const resolved = resolve(targetPath);

  // Level 3（超级）绕过所有路径限制，允许全局访问
  if (permissionLevel === 3) return { ok: true };

  // 始终校验 allowedDirs
  if (!allowedDirs || allowedDirs.length === 0) {
    return { ok: false, error: '未配置允许访问的目录' };
  }
  const inAllowed = allowedDirs.some(dir => {
    const allowed = resolve(dir);
    // 根目录（盘符根 / Unix /）以 sep 结尾，不再追加；否则追加 sep 防止前缀误匹配（如 C:/workspace-other）
    const prefix = allowed.endsWith(sep) ? allowed : allowed + sep;
    return resolved.startsWith(prefix) || resolved === allowed;
  });
  if (!inAllowed) {
    return { ok: false, error: `路径 "${resolved}" 不在允许的目录内` };
  }

  // 按「路径段」精确匹配敏感目录，避免误伤合法路径（如 my-windows-app）
  const lower = resolved.toLowerCase();
  const segments = lower.split(sep).filter(Boolean);
  for (const fp of FORBIDDEN_PATH_PATTERNS) {
    if (segments.includes(fp)) {
      return { ok: false, error: `禁止访问敏感路径: ${fp}` };
    }
  }

  // 阻止访问任何用户的 AppData/Home 配置目录
  if (lower.startsWith(HOME_DIR + sep + '.config') || lower.startsWith(HOME_DIR + sep + 'appdata')) {
    return { ok: false, error: '禁止访问用户配置目录' };
  }

  return { ok: true };
}

/** boolean 版（full 语义）：供 isPathSafe 调用点使用 */
export function isPathSafe(targetPath: string, allowedDirs?: string[], permissionLevel?: number): boolean {
  return checkPathSafe(targetPath, allowedDirs, permissionLevel).ok;
}

/** 仅 allowedDirs 包含性（data 模块的 isPathInAllowedDirs 语义） */
export function isPathInAllowedDirs(filePath: string, allowedDirs: string[]): boolean {
  if (!filePath) return false;
  if (!allowedDirs || allowedDirs.length === 0) return false;
  const resolved = resolve(filePath);
  return allowedDirs.some(d => {
    const allowed = resolve(d);
    const prefix = allowed.endsWith(sep) ? allowed : allowed + sep;
    return resolved === allowed || resolved.startsWith(prefix);
  });
}

/** 敏感路径 + allowedDirs（data 模块的 isPathAllowed 语义） */
export function isPathAllowed(targetPath: string, allowedDirs: string[]): boolean {
  return checkPathSafe(targetPath, allowedDirs).ok;
}