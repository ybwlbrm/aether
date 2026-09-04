import { resolve } from 'node:path';
import { checkPathSafe } from '../path-guard.js';

// W4-3: 路径校验统一至 lib/path-guard.ts（以 {ok,error} 形状 re-export，保持调用方兼容）

/** 路径解析：相对路径基于 defaultDir（默认 cwd），与 lib/files.ts 保持一致 */
export function resolveSearchPath(p: string | undefined, defaultDir?: string): string {
  if (!p || p.trim() === '') {
    // 未指定路径时，使用默认工作目录
    return resolve(defaultDir || process.cwd());
  }
  if (p.startsWith('./') || p.startsWith('.\\') || (!p.includes(':') && !p.startsWith('/'))) {
    return resolve(defaultDir || process.cwd(), p);
  }
  return resolve(p);
}

export { checkPathSafe as isPathSafe };