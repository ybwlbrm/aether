/**
 * LSP 诊断工具 — 供 AI Agent 通过 function calling 对 TypeScript 文件运行类型检查
 * 实现方式：使用 tsc --noEmit 对项目进行编译检查，过滤出指定文件的诊断结果
 * 安全限制：文件路径必须在 allowedDirs 内（Level 3 超级权限除外）
 */
import { existsSync, statSync } from 'node:fs';
import { resolve, dirname, parse, sep } from 'node:path';
import { spawn } from 'node:child_process';
import { isPathSafe } from './path-guard.js';

const DIAG_TIMEOUT_MS = 30000;
const MAX_OUTPUT_CHARS = 50000;

/** 敏感路径段（与 files.ts 保持一致） */
const FORBIDDEN_PATH_PATTERNS = [
  'windows', 'program files', 'program files (x86)', 'system32',
  '/etc', '/root', '/boot', '/sbin', '/bin', '/usr/bin',
  '.git',
];

export const lspTools = [
  {
    type: 'function',
    function: {
      name: 'lsp_diagnostics',
      description: '对 TypeScript 文件运行类型检查，返回语法错误和类型错误',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string', description: '要检查的文件路径（绝对路径）' },
        },
        required: ['filePath'],
      },
    },
  },
];

/** 向上查找最近的 tsconfig.json */
function findTsconfig(startDir: string): string | null {
  let dir = resolve(startDir);
  const root = parse(dir).root;
  while (true) {
    const candidate = resolve(dir, 'tsconfig.json');
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
    const parent = resolve(dir, '..');
    if (parent === dir || dir === root) return null;
    dir = parent;
  }
}

/** 解析 tsc 输出行，过滤出目标文件的诊断 */
function parseTscOutput(
  output: string,
  targetFile: string,
  projectDir: string,
): { line: number; col: number; message: string }[] {
  const results: { line: number; col: number; message: string }[] = [];
  const targetLower = targetFile.toLowerCase();
  // tsc 输出格式: filepath(line,col): error TS1234: message
  const regex = /^(.+?)\((\d+),(\d+)\):\s+(error|warning)\s+(TS\d+):\s+(.+)$/gm;
  let match;
  while ((match = regex.exec(output)) !== null) {
    const filePath = resolve(projectDir, match[1].trim());
    if (filePath.toLowerCase() === targetLower) {
      results.push({
        line: parseInt(match[2], 10),
        col: parseInt(match[3], 10),
        message: `${match[5]}: ${match[6].trim()}`,
      });
    }
  }
  return results;
}

/**
 * 对指定文件运行 TypeScript 诊断
 * 通过查找最近的 tsconfig.json 并运行 tsc --noEmit 实现
 */
export async function executeLspDiagnostics(
  filePath: string,
  allowedDirs?: string[],
  permissionLevel?: number,
  defaultDir?: string,
): Promise<string> {
  try {
    const resolvedPath = resolve(filePath || '');
    if (!resolvedPath) return '错误: 请提供文件路径';

    // 安全检查
    if (!isPathSafe(resolvedPath, allowedDirs, permissionLevel)) {
      return '错误: 文件路径不在允许的目录内';
    }

    if (!existsSync(resolvedPath)) {
      return `错误: 文件不存在: ${resolvedPath}`;
    }

    // 检查文件类型
    const ext = parse(resolvedPath).ext.toLowerCase();
    if (!['.ts', '.tsx', '.mts', '.cts'].includes(ext)) {
      return `LSP 诊断暂不支持 ${ext} 文件类型，仅支持 TypeScript (.ts/.tsx/.mts/.cts)`;
    }

    // 查找 tsconfig.json
    const tsconfigPath = findTsconfig(dirname(resolvedPath));
    if (!tsconfigPath) {
      return `未找到 tsconfig.json，无法对 ${resolvedPath} 运行类型检查。请确保项目根目录包含 tsconfig.json。`;
    }

    const projectDir = dirname(tsconfigPath);

    // 优先使用本地 typescript，否则回退到 npx tsc
    const localTsc = resolve(projectDir, 'node_modules', 'typescript', 'bin', 'tsc');
    const hasLocalTsc = existsSync(localTsc);

    return await new Promise<string>((resolvePromise) => {
      let stdout = '';
      let stderr = '';
      let timedOut = false;

      const child = hasLocalTsc
        ? spawn(process.execPath, [localTsc, '--noEmit', '--pretty', 'false'], {
            cwd: projectDir,
            shell: false,
            timeout: DIAG_TIMEOUT_MS,
          })
        : process.platform === 'win32'
          ? spawn('cmd.exe', ['/d', '/s', '/c', 'npx.cmd', '--no-install', 'tsc', '--noEmit', '--pretty', 'false'], {
              cwd: projectDir,
              shell: false,
            })
          : spawn('npx', ['--no-install', 'tsc', '--noEmit', '--pretty', 'false'], {
              cwd: projectDir,
              shell: false,
            });

      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill(); } catch { /* 进程可能已退出 */ }
      }, DIAG_TIMEOUT_MS);

      child.stdout?.on('data', (d: Buffer) => {
        if (stdout.length < MAX_OUTPUT_CHARS) stdout += d.toString();
      });
      child.stderr?.on('data', (d: Buffer) => {
        if (stderr.length < MAX_OUTPUT_CHARS) stderr += d.toString();
      });

      child.on('error', (err) => {
        clearTimeout(timer);
        resolvePromise(`诊断执行异常: ${err.message}`);
      });

      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          resolvePromise(`错误: 类型检查超时（>${DIAG_TIMEOUT_MS}ms）`);
          return;
        }

        // tsc 输出在 stderr 中
        const tscOutput = stderr || stdout;
        const diagnostics = parseTscOutput(tscOutput, resolvedPath, projectDir);

        if (diagnostics.length === 0) {
          if (code === 0) {
            resolvePromise(`✅ ${resolvedPath} — 未发现 TypeScript 错误`);
          } else {
            // tsc 报告了其他文件的错误，但当前文件无错误
            resolvePromise(`✅ ${resolvedPath} — 未发现 TypeScript 错误（项目中其他文件有错误，但不影响此文件）`);
          }
          return;
        }

        const formatted = diagnostics
          .map(d => `  第 ${d.line} 行, 第 ${d.col} 列: ${d.message}`)
          .join('\n');
        resolvePromise(`${resolvedPath} 的 TypeScript 诊断结果 (${diagnostics.length} 个${diagnostics.length > 0 ? '错误' : ''}):\n${formatted}`);
      });
    });
  } catch (e: unknown) {
    return `工具执行错误: ${e instanceof Error ? e.message : String(e)}`;
  }
}