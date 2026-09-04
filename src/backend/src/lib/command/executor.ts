import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  ALLOWED_EXEC,
  FORBIDDEN_TOKENS,
  FORBIDDEN_COMBINATIONS,
  DANGEROUS_BASENAMES,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MAX_OUTPUT_CHARS,
  BUILTIN_COMMANDS,
} from './constants.js';
import { resolveWorkdir, isWorkdirSafe, truncateOutput } from './validator.js';
import { executeBuiltinCommand } from './builtins.js';

/**
 * 执行 shell 命令并返回输出结果（错误以字符串返回，不抛异常）
 *
 * @param command          要执行的命令（首词必须在 ALLOWED_EXEC 白名单内）
 * @param workdir          工作目录（可选，默认 allowedDirs[0]）
 * @param timeout          超时毫秒数（默认 30000，上限 60000）
 * @param allowedDirs      允许操作的工作目录列表
 * @param permissionLevel  权限级别（1=只读拒绝执行，2=受限执行，3=绕过路径限制）
 * @param defaultDir       相对路径的基准目录
 */
export async function executeCommand(
  command: string,
  workdir?: string,
  timeout?: number,
  allowedDirs?: string[],
  permissionLevel?: number,
  defaultDir?: string,
): Promise<string> {
  try {
    const cmd = String(command || '').trim();
    if (!cmd) return '错误: 缺少要执行的命令';

    // 权限检查：Level 1（只读）不允许执行任何命令
    if (permissionLevel === 1) {
      return '权限不足：当前为 Level 1（只读）模式，不允许执行命令。请切换到 Level 2 以允许执行操作。';
    }

    // 工作目录解析与校验
    const resolvedWorkdir = resolveWorkdir(workdir, allowedDirs, defaultDir);
    if (!existsSync(resolvedWorkdir)) {
      return `错误: 工作目录不存在: ${resolvedWorkdir}`;
    }
    const dirCheck = isWorkdirSafe(resolvedWorkdir, allowedDirs, permissionLevel);
    if (!dirCheck.ok) return `错误: ${dirCheck.error}`;

    // 命令解析：引号感知分词器，正确处理含空格的引号路径
    // Windows 命令行规则：双引号内的空格不分割，成对双引号被移除
    const tokens: string[] = [];
    let current = '';
    let inQuote = false;
    for (const ch of cmd) {
      if (ch === '"') {
        inQuote = !inQuote;
        continue; // 丢弃引号字符
      }
      if (ch === ' ' && !inQuote) {
        if (current) { tokens.push(current); current = ''; }
        continue;
      }
      current += ch;
    }
    if (current) tokens.push(current);
    const cmdName = tokens[0] || '';
    const args = tokens.slice(1);

    // PowerShell/cmd 仅在 Level 3（超级）下允许
    const cmdNameLower = cmdName.toLowerCase();
    if ((cmdNameLower === 'powershell' || cmdNameLower === 'pwsh' || cmdNameLower === 'cmd') && (permissionLevel ?? 2) < 3) {
      return `安全限制：${cmdName} 需要 Level 3（超级）权限才能执行。当前为 Level ${permissionLevel ?? 2}。`;
    }

    // 白名单检查（硬边界）：spawn 无 shell 时只能定位真实可执行文件
    if (!ALLOWED_EXEC.has(cmdName.toLowerCase())) {
      return `安全限制：命令 "${cmdName}" 不在允许列表内`;
    }

    // 黑名单检查：token 级 + 拼接注入防护
    const lowerCmd = cmd.toLowerCase();
    if (tokens.some(p => FORBIDDEN_TOKENS.has(p.toLowerCase()))) {
      return `安全限制：禁止执行危险命令 "${cmd}"`;
    }
    if (FORBIDDEN_COMBINATIONS.some(f => lowerCmd.includes(f))) {
      return `安全限制：禁止执行危险操作 "${cmd}"`;
    }
    // 危险解释器 basename 列表（start/explorer 可启动任意程序，需拦截）
    // 归一化 basename：去掉尾随点/空格（Windows 加载器会忽略）+ 短路 UNC 路径
    const dangerousInArgs = (argList: string[]): boolean => argList.some(p => {
      // 拒绝 UNC 路径（\\server\share\evil.exe 可远程加载执行）
      if (p.startsWith('\\\\')) return true;
      const base = p.split(/[\\/]/).pop()?.toLowerCase().replace(/[.\s]+$/, '') || '';
      return DANGEROUS_BASENAMES.includes(base);
    });

    // explorer 通过 ShellExecute 可启动任意程序，同样检查
    if (cmdName.toLowerCase() === 'explorer') {
      if (dangerousInArgs(args)) {
        return `安全限制：禁止通过 explorer 启动危险程序或 UNC 路径`;
      }
    }

    // 超时上限保护
    const effectiveTimeout = typeof timeout === 'number' && Number.isFinite(timeout) && timeout > 0
      ? Math.min(timeout, MAX_TIMEOUT_MS)
      : DEFAULT_TIMEOUT_MS;

    // Windows 内建命令：使用原生实现，完全避免 cmd.exe
    if (BUILTIN_COMMANDS.has(cmdName.toLowerCase())) {
      return await executeBuiltinCommand(cmdName, args, resolvedWorkdir, allowedDirs, permissionLevel);
    }

    // start 命令：特殊处理，用于启动独立进程
    if (cmdName.toLowerCase() === 'start') {
      // start 是 cmd.exe 内建，首个引号参数会被当作窗口标题。
      // 用参数数组拆分方式调用，避免 cmd.exe /s /c 对中文路径的引号解析问题。
      // stdio:ignore 防止 start 检测到输入重定向时报错 "Input redirection is not supported"
      const child = spawn('cmd.exe', ['/c', 'start', '', ...args], { cwd: resolvedWorkdir, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });

      return await new Promise<string>((resolvePromise, rejectPromise) => {
        let stdout = '';
        let stderr = '';
        let timedOut = false;

        const timer = setTimeout(() => {
          timedOut = true;
          try { child.kill(); } catch { /* 进程可能已退出 */ }
        }, effectiveTimeout);

        child.stdout?.on('data', (d: Buffer) => {
          if (stdout.length < MAX_OUTPUT_CHARS) stdout += d.toString();
        });
        child.stderr?.on('data', (d: Buffer) => {
          if (stderr.length < MAX_OUTPUT_CHARS) stderr += d.toString();
        });

        child.on('error', (err) => {
          clearTimeout(timer);
          rejectPromise(err);
        });

        child.on('close', (code) => {
          clearTimeout(timer);
          if (timedOut) {
            resolvePromise(
              `错误: 命令执行超时（>${effectiveTimeout}ms），进程已被强制终止。\n` +
              `已收集的部分输出:\n${truncateOutput(stdout) || '(无输出)'}`,
            );
            return;
          }
          const exitCode = code ?? 1;
          const lines = [
            `命令执行完成（退出码 ${exitCode}）`,
            `--- stdout ---`,
            truncateOutput(stdout) || '(无输出)',
          ];
          if (stderr.trim()) {
            lines.push(`--- stderr ---`, truncateOutput(stderr));
          }
          resolvePromise(lines.join('\n'));
        });
      });
    }

    // 其余命令：tokenize 后 spawn(cmdName, args, { shell: false })
    const child = spawn(cmdName, args, { cwd: resolvedWorkdir, shell: false });

    return await new Promise<string>((resolvePromise, rejectPromise) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      // 自管定时器：区分「超时终止」与「正常退出」（spawn 自带 timeout 无法区分）
      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill(); } catch { /* 进程可能已退出 */ }
      }, effectiveTimeout);

      child.stdout?.on('data', (d: Buffer) => {
        if (stdout.length < MAX_OUTPUT_CHARS) stdout += d.toString();
      });
      child.stderr?.on('data', (d: Buffer) => {
        if (stderr.length < MAX_OUTPUT_CHARS) stderr += d.toString();
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        rejectPromise(err);
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          resolvePromise(
            `错误: 命令执行超时（>${effectiveTimeout}ms），进程已被强制终止。\n` +
            `已收集的部分输出:\n${truncateOutput(stdout) || '(无输出)'}`,
          );
          return;
        }
        const exitCode = code ?? 1;
        const lines = [
          `命令执行完成（退出码 ${exitCode}）`,
          `--- stdout ---`,
          truncateOutput(stdout) || '(无输出)',
        ];
        if (stderr.trim()) {
          lines.push(`--- stderr ---`, truncateOutput(stderr));
        }
        resolvePromise(lines.join('\n'));
      });
    });
  } catch (e: unknown) {
    return `命令执行异常: ${e instanceof Error ? e.message : String(e)}`;
  }
}