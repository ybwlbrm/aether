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
import { realpathSync } from 'node:fs';

/**
 * PATH-001 (SEC/P0-22): 解析 symlink/junction/reparse point 后的最终物理路径。
 * 仅靠 resolve() 无法识破 allowedDirs 内的 junction/symlink 指向外部目录的逃逸。
 * realpathSync.native 在 Windows 下可解析 junction 与 reparse point。
 * 路径不存在（即将创建）时回退：解析父目录的物理路径再拼接文件名。
 */
export function resolvePhysicalPath(targetPath: string): string {
  const resolved = resolve(targetPath);
  try {
    return realpathSync.native(resolved);
  } catch {
    // 目标不存在：尝试解析其父目录（父目录可能是 junction）
    try {
      const parent = resolve(resolved, '..');
      const base = resolved.split(/[\\/]/).filter(Boolean).pop() ?? '';
      return resolve(realpathSync.native(parent), base);
    } catch {
      return resolved;
    }
  }
}

/** 敏感路径段（路径按分隔符拆分后逐段匹配；Wave0-PG: Unix 系统目录用段名，不再用带斜杠全串） */
const FORBIDDEN_PATH_SEGMENTS = [
  'windows', 'program files', 'program files (x86)', 'system32',
  'etc', 'root', 'boot', 'sbin',
  '.git',
];

/**
 * Wave0-PG: 系统敏感路径检测。
 * - 段名整段匹配（etc / root / boot / sbin / windows / system32 / .git 等）
 * - /usr/bin 用「usr+bin」相邻段对检测（避免 bin 段误伤合法项目 build/bin 目录）
 * - Unix 顶层 /bin 仅在第一个段为 bin 时拦截（win32 C:\bin 不属于系统目录）
 */
function hasSystemSensitiveSegments(segments: string[]): boolean {
  for (const fp of FORBIDDEN_PATH_SEGMENTS) {
    if (segments.includes(fp)) return true;
  }
  if (segments[0] === 'bin') return true; // Unix 顶层 /bin
  for (let i = 0; i < segments.length - 1; i++) {
    if (segments[i] === 'usr' && segments[i + 1] === 'bin') return true; // /usr/bin
  }
  return false;
}

const HOME_DIR = homedir().toLowerCase();

export interface PathCheckResult {
  ok: boolean;
  error?: string;
}

/** 敏感路径段检测（Level 3 也执行，防止超级权限访问 system32/.git/.config 等） */
function checkForbiddenSegments(resolved: string, lower: string): string | null {
  const segments = lower.split(sep).filter(Boolean);
  if (hasSystemSensitiveSegments(segments)) {
    return '禁止访问敏感路径（windows/system32/etc/root/boot/sbin/usr-bin/.git 等）';
  }
  if (lower.startsWith(HOME_DIR + sep + '.config') || lower.startsWith(HOME_DIR + sep + 'appdata')) {
    return '禁止访问用户配置目录';
  }
  return null;
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
  // PATH-001: 用 realpath 解析后的物理路径做边界/敏感判断，杜绝 junction/symlink 逃逸
  const physical = resolvePhysicalPath(resolved);
  const lower = physical.toLowerCase();

  // Level 3（超级）：绕过 allowedDirs（允许全局访问），但仍拒绝敏感路径段与用户配置目录
  // SEC-004 修复：原来 L3 直接 return ok:true，可访问 system32/.git/.config —— 危险面过大
  if (permissionLevel === 3) {
    const forbidden = checkForbiddenSegments(physical, lower);
    if (forbidden) return { ok: false, error: forbidden };
    return { ok: true };
  }

  // 始终校验 allowedDirs
  if (!allowedDirs || allowedDirs.length === 0) {
    return { ok: false, error: '未配置允许访问的目录' };
  }
  const inAllowed = allowedDirs.some(dir => {
    const allowed = resolvePhysicalPath(resolve(dir));
    // 根目录（盘符根 / Unix /）以 sep 结尾，不再追加；否则追加 sep 防止前缀误匹配（如 C:/workspace-other）
    const prefix = allowed.endsWith(sep) ? allowed : allowed + sep;
    return physical.startsWith(prefix) || physical === allowed;
  });
  if (!inAllowed) {
    return { ok: false, error: `路径 "${physical}" 不在允许的目录内` };
  }

  // 按「路径段」精确匹配敏感目录，避免误伤合法路径（如 my-windows-app）
  const forbidden = checkForbiddenSegments(physical, lower);
  if (forbidden) {
    return { ok: false, error: forbidden };
  }

  return { ok: true };
}

/** boolean 版（full 语义）：供 isPathSafe 调用点使用 */
export function isPathSafe(targetPath: string, allowedDirs?: string[], permissionLevel?: number): boolean {
  return checkPathSafe(targetPath, allowedDirs, permissionLevel).ok;
}

/** 仅 allowedDirs 包含性（data 模块的 isPathInAllowedDirs 语义）—— Wave0-PG: 统一走 physical path */
export function isPathInAllowedDirs(filePath: string, allowedDirs: string[]): boolean {
  if (!filePath) return false;
  if (!allowedDirs || allowedDirs.length === 0) return false;
  const resolved = resolvePhysicalPath(filePath);
  return allowedDirs.some(d => {
    const allowed = resolvePhysicalPath(resolve(d));
    const prefix = allowed.endsWith(sep) ? allowed : allowed + sep;
    return resolved === allowed || resolved.startsWith(prefix);
  });
}

/** 敏感路径 + allowedDirs（data 模块的 isPathAllowed 语义） */
export function isPathAllowed(targetPath: string, allowedDirs: string[]): boolean {
  return checkPathSafe(targetPath, allowedDirs).ok;
}