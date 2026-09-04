/** 展开 {a,b} 花括号形式 → ['*a*', '*b*'] */
export function expandBraces(part: string): string[] {
  const m = part.match(/\{([^{}]+)\}/);
  if (!m || m.index === undefined) return [part];
  const results: string[] = [];
  for (const alt of m[1].split(',')) {
    results.push(...expandBraces(part.slice(0, m.index) + alt + part.slice(m.index + m[0].length)));
  }
  return results;
}

/** 简单通配符转正则：* 匹配任意字符，? 匹配单个字符 */
export function wildcardToRegExp(wildcard: string, caseInsensitive: boolean): RegExp {
  const escaped = wildcard
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*/g, '.*')
    .replace(/\?/g, '.');
  return new RegExp(`^${escaped}$`, caseInsensitive ? 'i' : '');
}

/**
 * 编译 grep 的 include 过滤参数（如 "*.ts" 或 "*.{ts,tsx},*.md"）为文件名匹配器。
 * 返回 null 表示不过滤。
 */
export function compileIncludeFilter(include?: string): ((name: string) => boolean) | null {
  if (!include || !include.trim()) return null;
  const parts = include.split(',').flatMap(p => expandBraces(p.trim())).filter(Boolean);
  if (parts.length === 0) return null;
  const regs = parts.map(p => wildcardToRegExp(p, true));
  return (name: string) => regs.some(r => r.test(name));
}

/**
 * 编译 glob 模式为正则：
 *  - 双星加斜杠（目录通配）匹配零个或多个目录层级；双星匹配任意字符（含分隔符）
 *  - 单星匹配除分隔符外的任意字符；问号匹配单个非分隔符字符
 */
export function globToRegExp(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') {
          re += '(?:.*/)?'; // '**/' 可匹配零层目录
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if ('\\^$.|+()[]{}'.includes(c)) {
      re += '\\' + c;
    } else {
      re += c;
    }
  }
  // Windows 文件名大小写不敏感，统一用 i 标志
  return new RegExp(`^${re}$`, 'i');
}