import { homedir } from 'node:os';
import { isAbsolute, resolve, sep } from 'node:path';
import { FORBIDDEN_PATH_PATTERNS } from './constants.js';

/** 输出截断：超过上限时保留头部并标注原始长度 */
export function truncateOutput(text: string, maxChars: number = 50000): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n...[输出过长已截断，原始长度 ${text.length} 字符]`;
}

/**
 * 工作目录解析：
 *  - 显式指定时，绝对路径直接用；相对路径基于 defaultDir（或进程 cwd）解析
 *  - 未指定时依次回退：allowedDirs[0] → defaultDir → 进程 cwd
 */
export function resolveWorkdir(workdir: string | undefined, allowedDirs: string[] | undefined, defaultDir: string | undefined): string {
  const raw = (workdir || '').trim();
  if (raw) {
    if (isAbsolute(raw)) return resolve(raw);
    return resolve(defaultDir || process.cwd(), raw);
  }
  if (allowedDirs && allowedDirs.length > 0) return resolve(allowedDirs[0]);
  if (defaultDir) return resolve(defaultDir);
  return process.cwd();
}

/** 工作目录安全校验：allowedDirs 约束 + 敏感路径段 + 用户配置目录 */
export function isWorkdirSafe(targetDir: string, allowedDirs: string[] | undefined, permissionLevel?: number): { ok: boolean; error?: string } {
  const resolved = resolve(targetDir);

  // Level 3（超级）绕过所有路径限制
  if (permissionLevel === 3) return { ok: true };

  // 必须位于 allowedDirs 内
  if (!allowedDirs || allowedDirs.length === 0) {
    return { ok: false, error: '未配置允许访问的目录' };
  }
  const inAllowed = allowedDirs.some(dir => {
    const allowed = resolve(dir);
    return resolved.startsWith(allowed + sep) || resolved === allowed;
  });
  if (!inAllowed) {
    return { ok: false, error: `工作目录 "${resolved}" 不在允许的目录内` };
  }

  // 敏感路径段检查：按分隔符拆分后精确匹配，避免子串误伤合法目录名
  const lower = resolved.toLowerCase();
  const segments = lower.split(sep).filter(Boolean);
  for (const fp of FORBIDDEN_PATH_PATTERNS) {
    if (segments.includes(fp)) {
      return { ok: false, error: `禁止访问敏感路径: ${fp}` };
    }
  }
  // 阻止访问用户配置目录
  const home = homedir().toLowerCase();
  if (lower.startsWith(home + sep + '.config') || lower.startsWith(home + sep + 'appdata')) {
    return { ok: false, error: '禁止访问用户配置目录' };
  }
  return { ok: true };
}