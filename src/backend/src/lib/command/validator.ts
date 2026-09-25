import { homedir } from 'node:os';
import { isAbsolute, resolve, sep } from 'node:path';
import { FORBIDDEN_PATH_PATTERNS } from './constants.js';
import { checkPathSafe } from '../path-guard.js';

/** 输出截断：超过上限时保留头部并标注原始长度 */
export function truncateOutput(text: string, maxChars: number = 50000): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...[输出过长已截断，原始长度 ${text.length} 字符]`;
}

/**
 * 工作目录解析：
 *  - 显式指定时，绝对路径直接用；相对路径基于 defaultDir（或进程 cwd）解析
 *  - 未指定时依次回退：defaultDir → allowedDirs[0] → 进程 cwd
 *
 * P0-2 修复（审计）：defaultDir 是用户在 UI 中显式设置的"默认工作目录"，
 * 应优先于 allowedDirs[0]（仅是"允许访问的目录列表"的首项，不一定是用户想要的
 * 默认工作目录）。defaultDir 保存时已被 settings.ts 校验必须存在于 allowedDirs，
 * 因此 defaultDir 优先不会破坏路径安全。
 */
export function resolveWorkdir(workdir: string | undefined, allowedDirs: string[] | undefined, defaultDir: string | undefined): string {
  const raw = (workdir || '').trim();
  if (raw) {
    if (isAbsolute(raw)) return resolve(raw);
    return resolve(defaultDir || process.cwd(), raw);
  }
  if (defaultDir) return resolve(defaultDir);
  if (allowedDirs && allowedDirs.length > 0) return resolve(allowedDirs[0]);
  return process.cwd();
}

/**
 * 工作目录安全校验：统一走 path-guard.ts 的唯一实现（P1-23 收口）。
 *
 * 旧实现是第二套路径校验（resolve + startsWith + 自身敏感段列表），
 * 且 Level 3 直接 return { ok: true } 绕过敏感路径检查（可访问
 * system32/.git/.config）。新实现复用统一 PathGuard：
 * - realpath 解析物理路径（防 junction/symlink 逃逸）
 * - Level 3 仍拒绝敏感路径段与用户配置目录
 * - allowedDirs 前缀匹配（防 C:/workspace-other 误匹配）
 */
export function isWorkdirSafe(targetDir: string, allowedDirs: string[] | undefined, permissionLevel?: number): { ok: boolean; error?: string } {
  if (!targetDir) {
    return { ok: false, error: '工作目录为空' };
  }
  const result = checkPathSafe(targetDir, allowedDirs, permissionLevel);
  if (!result.ok) return { ok: false, error: result.error };
  return { ok: true };
}

/** 保留 FORBIDDEN_PATH_PATTERNS 导出以兼容旧引用（实际校验已走 path-guard） */
export { FORBIDDEN_PATH_PATTERNS };