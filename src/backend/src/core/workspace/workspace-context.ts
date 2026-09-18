/**
 * WorkspaceContext — 工作区唯一事实来源（整改计划第 2 章，P0/P1）。
 *
 * 原则：
 * - 启动时规范化 allowedDirs / defaultDir：realpath + Windows 大小写归一化 + junction/symlink 检查
 * - 所有工具/模块只接收 WorkspaceContext，不再自行回退到 allowedDirs[0] / process.cwd()
 * - canonicalResolve() 返回唯一 canonical resolved path（大小写归一 + 物理路径解析）
 */
import { resolve, sep } from 'node:path';
import { realpathSync } from 'node:fs';
import { getSettings } from '../../lib/dal.js';
import type { BackendConfig } from '../../config/index.js';

/** Windows 大小写归一化（其余平台原样） */
export function normalizeCase(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/** 解析物理路径（symlink/junction/reparse point 后）；不存在时回退解析父目录 */
export function physicalPath(targetPath: string): string {
  const resolved = resolve(targetPath);
  try {
    return realpathSync.native(resolved);
  } catch {
    try {
      const parent = resolve(resolved, '..');
      const base = resolved.split(/[\\/]/).filter(Boolean).pop() ?? '';
      return resolve(realpathSync.native(parent), base);
    } catch {
      return resolved;
    }
  }
}

export interface WorkspaceContext {
  /** 规范化后的允许目录（物理路径，Windows 大小写归一） */
  allowedDirs: string[];
  /** 规范化后的默认工作目录（物理路径） */
  defaultDir: string;
  /** 权限级别（1 只读 / 2 完全 / 3 超级） */
  permissionLevel: number;

  /**
   * 返回 canonical resolved path：
   * - resolve → physical（junction/symlink 解析）→ Windows 大小写归一
   * 两个指向同一物理目录的写法返回同一字符串，可用于一致性比较与去重。
   */
  canonicalResolve(p: string): string;

  /** 判断 target 是否在 allowedDirs 内（canonical 前缀匹配，防前缀误匹配） */
  isWithinAllowed(target: string): boolean;

  /** 判断 target 是否就是默认工作目录（或其子目录） */
  isWithinDefault(target: string): boolean;

  /** 规范化一个候选目录：必须是 allowedDirs 内，返回 canonical 路径；否则 null */
  normalizeDir(candidate: string): string | null;

  /** 当前默认工作目录（工具未指定路径时的统一回退，绝不回退 process.cwd()） */
  get cwd(): string;
}

/** 前缀匹配（盘符根以 sep 结尾，其余追加 sep 防 C:/workspace-other 误匹配） */
function isWithin(physical: string, allowed: string): boolean {
  const prefix = allowed.endsWith(sep) ? allowed : allowed + sep;
  return physical === allowed || physical.startsWith(prefix);
}

/** 从 settings 构造 WorkspaceContext（整改后：唯一入口，调用方禁止自行读 settings.allowedDirs[0]） */
export async function createWorkspaceContext(config?: BackendConfig): Promise<WorkspaceContext> {
  const settings = await getSettings();
  const rawAllowed = (Array.isArray(settings.allowedDirs) && settings.allowedDirs.length > 0)
    ? settings.allowedDirs
    : [resolve(config?.dataDir ?? './data')];
  const rawDefault = settings.defaultDir && settings.defaultDir.trim() !== ''
    ? settings.defaultDir
    : rawAllowed[0];

  // 规范化：physical + 大小写归一
  const allowedSet = new Set<string>();
  const allowedPhysical: string[] = [];
  for (const dir of rawAllowed) {
    try {
      const phys = physicalPath(dir);
      const canon = normalizeCase(phys);
      if (!allowedSet.has(canon)) {
        allowedSet.add(canon);
        allowedPhysical.push(canon);
      }
    } catch {
      /* 目录不可访问则跳过 */
    }
  }
  if (allowedPhysical.length === 0) {
    const fallback = normalizeCase(physicalPath(process.cwd()));
    allowedPhysical.push(fallback);
    allowedSet.add(fallback);
  }

  // defaultDir 必须落在 allowedDirs 内；否则回退第一个 allowedDir
  let defaultPhys = normalizeCase(physicalPath(rawDefault));
  if (!allowedSet.has(defaultPhys) && !allowedPhysical.some((a) => isWithin(defaultPhys, a))) {
    defaultPhys = allowedPhysical[0];
  }

  const permissionLevel = settings.permissionLevel ?? 2;

  const ctx: WorkspaceContext = {
    allowedDirs: [...allowedPhysical],
    defaultDir: defaultPhys,
    permissionLevel,

    canonicalResolve(p: string): string {
      return normalizeCase(physicalPath(p));
    },

    isWithinAllowed(target: string): boolean {
      const canon = ctx.canonicalResolve(target);
      return ctx.allowedDirs.some((a) => isWithin(canon, a));
    },

    isWithinDefault(target: string): boolean {
      return isWithin(ctx.canonicalResolve(target), ctx.defaultDir);
    },

    normalizeDir(candidate: string): string | null {
      if (!candidate || candidate.trim() === '') return null;
      const canon = ctx.canonicalResolve(candidate);
      if (!ctx.allowedDirs.some((a) => isWithin(canon, a))) return null;
      return canon;
    },

    get cwd(): string {
      return ctx.defaultDir;
    },
  };

  return ctx;
}

/** 轻量同步版（已有 canonical 缓存时；设置变更后应重新 create） */
export function createWorkspaceContextSync(opts: {
  allowedDirs: string[];
  defaultDir?: string;
  permissionLevel?: number;
}): WorkspaceContext {
  const allowedSet = new Set<string>();
  const allowedPhysical: string[] = [];
  for (const dir of opts.allowedDirs) {
    try {
      const canon = normalizeCase(physicalPath(dir));
      if (!allowedSet.has(canon)) {
        allowedSet.add(canon);
        allowedPhysical.push(canon);
      }
    } catch { /* skip */ }
  }
  if (allowedPhysical.length === 0) {
    const fallback = normalizeCase(physicalPath(process.cwd()));
    allowedPhysical.push(fallback);
    allowedSet.add(fallback);
  }
  let defaultPhys = opts.defaultDir && opts.defaultDir.trim() !== ''
    ? normalizeCase(physicalPath(opts.defaultDir))
    : allowedPhysical[0];
  if (!allowedPhysical.some((a) => isWithin(defaultPhys, a))) {
    defaultPhys = allowedPhysical[0];
  }

  const permissionLevel = opts.permissionLevel ?? 2;

  const ctx: WorkspaceContext = {
    allowedDirs: [...allowedPhysical],
    defaultDir: defaultPhys,
    permissionLevel,

    canonicalResolve(p: string): string {
      return normalizeCase(physicalPath(p));
    },

    isWithinAllowed(target: string): boolean {
      const canon = ctx.canonicalResolve(target);
      return ctx.allowedDirs.some((a) => isWithin(canon, a));
    },

    isWithinDefault(target: string): boolean {
      return isWithin(ctx.canonicalResolve(target), ctx.defaultDir);
    },

    normalizeDir(candidate: string): string | null {
      if (!candidate || candidate.trim() === '') return null;
      const canon = ctx.canonicalResolve(candidate);
      if (!ctx.allowedDirs.some((a) => isWithin(canon, a))) return null;
      return canon;
    },

    get cwd(): string {
      return ctx.defaultDir;
    },
  };

  return ctx;
}

/** 模块级缓存：app 启动时设置一次，运行期读取（设置变更需显式重置） */
let cachedContext: WorkspaceContext | null = null;

/** 获取缓存的 WorkspaceContext；未初始化时惰性创建 */
export async function getWorkspaceContext(config?: BackendConfig): Promise<WorkspaceContext> {
  if (!cachedContext) {
    cachedContext = await createWorkspaceContext(config);
  }
  return cachedContext;
}

/** 显式设置（app 启动时/设置变更后调用） */
export function setWorkspaceContext(ctx: WorkspaceContext | null): void {
  cachedContext = ctx;
}

/** 重置缓存（设置变更后强制重建） */
export function resetWorkspaceContext(): void {
  cachedContext = null;
}
