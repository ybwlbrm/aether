import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, sep } from 'node:path';
import { isWorkdirSafe } from './validator.js';

/**
 * 原生实现 Windows 内建命令，避免经过 cmd.exe
 */
export async function executeBuiltinCommand(
  cmdName: string,
  args: string[],
  workdir: string,
  allowedDirs: string[] | undefined,
  permissionLevel?: number,
): Promise<string> {
  const lowerCmd = cmdName.toLowerCase();

  switch (lowerCmd) {
    case 'echo': {
      // echo: 返回参数字符串（去除引号已在 tokenizer 处理）
      return args.join(' ') || '';
    }
    case 'pwd': {
      // pwd: 返回当前工作目录
      return workdir;
    }
    case 'cd': {
      // cd: 改变工作目录（仅验证，不实际改变进程 cwd）
      if (args.length === 0) return workdir;
      const target = resolve(workdir, args[0]);
      if (!existsSync(target)) {
        return `错误: 目录不存在: ${target}`;
      }
      const dirCheck = isWorkdirSafe(target, allowedDirs, permissionLevel);
      if (!dirCheck.ok) return `错误: ${dirCheck.error}`;
      // 返回目标目录路径，调用者可选择更新 workdir
      return target;
    }
    case 'dir':
    case 'ls': {
      // dir/ls: 列出目录内容
      const targetDir = args.length > 0 ? resolve(workdir, args[0]) : workdir;
      if (!existsSync(targetDir)) {
        return `错误: 目录不存在: ${targetDir}`;
      }
      const dirCheck = isWorkdirSafe(targetDir, allowedDirs, permissionLevel);
      if (!dirCheck.ok) return `错误: ${dirCheck.error}`;
      try {
        const entries = readdirSync(targetDir, { withFileTypes: true });
        const lines = entries.map(e => {
          const stat = statSync(resolve(targetDir, e.name));
          const size = e.isDirectory() ? '<DIR>' : stat.size.toString();
          const time = stat.mtime.toLocaleString();
          return `${time}  ${size.padStart(12)}  ${e.name}`;
        });
        return lines.join('\n') || '(空目录)';
      } catch (e: unknown) {
        return `错误: 无法读取目录: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    case 'type':
    case 'cat': {
      // type/cat: 读取文件内容
      if (args.length === 0) return '错误: 缺少文件路径';
      const filePath = resolve(workdir, args[0]);
      if (!existsSync(filePath)) {
        return `错误: 文件不存在: ${filePath}`;
      }
      const dirCheck = isWorkdirSafe(filePath, allowedDirs, permissionLevel);
      if (!dirCheck.ok) return `错误: ${dirCheck.error}`;
      try {
        const stat = statSync(filePath);
        if (stat.isDirectory()) return `错误: ${filePath} 是目录，不是文件`;
        if (stat.size > 10 * 1024 * 1024) return `错误: 文件过大 (>10MB)，拒绝读取`;
        return readFileSync(filePath, 'utf-8');
      } catch (e: unknown) {
        return `错误: 无法读取文件: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    case 'mkdir': {
      // mkdir: 创建目录
      if (args.length === 0) return '错误: 缺少目录路径';
      const targetDir = resolve(workdir, args[0]);
      const dirCheck = isWorkdirSafe(targetDir, allowedDirs, permissionLevel);
      if (!dirCheck.ok) return `错误: ${dirCheck.error}`;
      try {
        const { mkdirSync } = await import('node:fs');
        mkdirSync(targetDir, { recursive: true });
        return `目录创建成功: ${targetDir}`;
      } catch (e: unknown) {
        return `错误: 创建目录失败: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    case 'rm': {
      // rm: 删除文件/目录
      if (args.length === 0) return '错误: 缺少路径';
      const targetPath = resolve(workdir, args[0]);
      const dirCheck = isWorkdirSafe(targetPath, allowedDirs, permissionLevel);
      if (!dirCheck.ok) return `错误: ${dirCheck.error}`;
      try {
        const { rmSync } = await import('node:fs');
        const recursive = args.includes('-r') || args.includes('-rf') || args.includes('-fr');
        rmSync(targetPath, { recursive, force: true });
        return `删除成功: ${targetPath}`;
      } catch (e: unknown) {
        return `错误: 删除失败: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    case 'cp': {
      // cp: 复制文件
      if (args.length < 2) return '错误: 用法: cp <源> <目标>';
      const src = resolve(workdir, args[0]);
      const dest = resolve(workdir, args[1]);
      const srcCheck = isWorkdirSafe(src, allowedDirs, permissionLevel);
      if (!srcCheck.ok) return `错误: ${srcCheck.error}`;
      const destCheck = isWorkdirSafe(dest, allowedDirs, permissionLevel);
      if (!destCheck.ok) return `错误: ${destCheck.error}`;
      try {
        const { copyFileSync, mkdirSync } = await import('node:fs');
        const destDir = dest.endsWith(sep) ? dest : resolve(dest, '..');
        mkdirSync(destDir, { recursive: true });
        copyFileSync(src, dest);
        return `复制成功: ${src} -> ${dest}`;
      } catch (e: unknown) {
        return `错误: 复制失败: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    case 'mv': {
      // mv: 移动/重命名
      if (args.length < 2) return '错误: 用法: mv <源> <目标>';
      const src = resolve(workdir, args[0]);
      const dest = resolve(workdir, args[1]);
      const srcCheck = isWorkdirSafe(src, allowedDirs, permissionLevel);
      if (!srcCheck.ok) return `错误: ${srcCheck.error}`;
      const destCheck = isWorkdirSafe(dest, allowedDirs, permissionLevel);
      if (!destCheck.ok) return `错误: ${destCheck.error}`;
      try {
        const { renameSync, mkdirSync } = await import('node:fs');
        const destDir = dest.endsWith(sep) ? dest : resolve(dest, '..');
        mkdirSync(destDir, { recursive: true });
        renameSync(src, dest);
        return `移动成功: ${src} -> ${dest}`;
      } catch (e: unknown) {
        return `错误: 移动失败: ${e instanceof Error ? e.message : String(e)}`;
      }
    }
    case 'where': {
      // where: 查找可执行文件路径
      if (args.length === 0) return '错误: 缺少命令名';
      const pathModule = await import('node:path');
      const { PATH } = process.env;
      if (!PATH) return '错误: PATH 环境变量为空';
      const paths = PATH.split(pathModule.delimiter);
      const results: string[] = [];
      for (const p of paths) {
        const fullPath = resolve(p, args[0]);
        if (existsSync(fullPath)) {
          try {
            const stat = statSync(fullPath);
            if (stat.isFile()) results.push(fullPath);
          } catch { /* ignore */ }
        }
      }
      return results.join('\n') || `未找到: ${args[0]}`;
    }
    case 'date': {
      // date: 返回当前日期时间
      return new Date().toLocaleString();
    }
    case 'whoami': {
      // whoami: 返回当前用户名
      return process.env.USERNAME || process.env.USER || 'unknown';
    }
    case 'hostname': {
      // hostname: 返回主机名
      return (await import('node:os')).hostname();
    }
    default:
      // 未处理的内建命令，回退到 spawn（不应发生，因为已在白名单中）
      return `错误: 内建命令 "${cmdName}" 暂未实现原生支持`;
  }
}