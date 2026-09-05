import type { FastifyInstance } from 'fastify';
import type { BackendConfig } from '../../config/index.js';
import { getSettings } from '../../lib/dal.js';
import { executeCommand } from '../../lib/command.js';
import { isPathAllowed } from './utils.js';
import { resolve, sep } from 'node:path';
import { existsSync } from 'node:fs';

/** 项目执行相关路由 */
export function registerExecRoutes(app: FastifyInstance, config: BackendConfig): void {
  // ====== Project Exec (bat/command execution) ======
  // P0-5: 改进白名单 — 分级管理，不再用无用白名单
  // P0-2 (第三轮) 修复：移除 cmd/start 通行证 —
  //   cmd 允许 `cmd /c <任意>` 平整绕过后门（如 cmd /c powershell -enc ...），
  //   start 允许启动任意程序。安全性上「用户手动执行」可接受，但「AI 可通过
  //   prompt 注入诱导执行任意命令」不可接受，故一律剔除。
  // 无害 cmd 内建（echo/dir/type 等）由 lib/command.ts 原生实现，不再经 cmd.exe。
  const SAFE_COMMANDS = new Set(['echo', 'dir', 'ls', 'pwd', 'cls', 'type', 'cat', 'ver', 'where', 'git', 'node', 'npm', 'npx', 'tsx', 'tsc', 'vite', 'pnpm', 'yarn', 'bun', 'python', 'python3', 'deno', 'notepad', 'calc', 'start', 'explorer']);
  const FORBIDDEN_COMMANDS = new Set(['rm', 'del', 'rmdir', 'format', 'diskpart', 'regedit', 'shutdown', 'powershell', 'pwsh', 'wscript', 'cscript', 'cmd', 'cmd.exe', 'taskkill', 'net']);
  const FORBIDDEN_PATHS = ['C:\\Windows', 'C:/Windows', 'C:\\Program Files', 'System32', '/etc', '/bin', '/usr/bin'];
  // P0-5: bat 内容危险模式扫描
  const FORBIDDEN_BAT_PATTERNS = [/\bformat\b/i, /\bdel\s+\/[fsq]/i, /%~dp0.*cmd\.exe/i, /\breg\b.*\badd\b/i, /\bpowershell.*-enc\b/i, /\bcscript\b/i, /\bwscript\b/i];

  app.post('/api/projects/exec', { schema: { description: '执行项目', tags: ['数据'] } }, async (request) => {
    const body = request.body as { type: string; target: string };
    if (!body?.type || !body?.target) return { error: '缺少 type 或 target', code: 'INVALID_BODY' };
    const { spawn } = await import('child_process');
    const fs = await import('fs');
    const { resolve } = await import('node:path');

    // command 类型：使用 lib/command.ts 的 executeCommand（spawn + shell:false，内建命令原生实现）
    if (body.type === 'command') {
      const cmd = body.target.trim();
      if (!cmd) return { error: '命令为空', code: 'EMPTY_COMMAND' };
      const parts = cmd.split(/\s+/);
      const cmdName = parts[0].toLowerCase();
      // 读取当前权限级别（Level 3 = 超级，与 OpenCode 同等权限，允许执行任何命令）
      const settings = await getSettings();
      const permLevel = settings.permissionLevel ?? 2;
      const isLevel3 = permLevel === 3;
      const allowedDirs = settings.allowedDirs || [];
      const defaultDir = settings.defaultDir || allowedDirs[0] || process.cwd();

      // Level 3：绕过所有命令限制（与 OpenCode 自身权限一致）
      if (!isLevel3) {
        // P0-5: 危险命令直接拒绝
        if (FORBIDDEN_COMMANDS.has(cmdName)) {
          return { error: `命令 "${cmdName}" 被禁止执行`, code: 'CMD_FORBIDDEN' };
        }
        // P0-5: 非白名单命令也拒绝
        if (!SAFE_COMMANDS.has(cmdName)) {
          return { error: `命令 "${cmdName}" 不在白名单中`, code: 'CMD_NOT_ALLOWED' };
        }
      }
      const args = parts.slice(1);
      const lower = cmd.toLowerCase();
      if (FORBIDDEN_PATHS.some(p => lower.includes(p.toLowerCase()))) {
        return { error: '命令访问了禁止路径', code: 'FORBIDDEN_PATH' };
      }
      // 使用统一的 executeCommand 实现（包含命令历史记录）
      const output = await executeCommand(cmd, defaultDir, 30000, allowedDirs, permLevel, defaultDir);
      // 解析输出以确定成功/失败（executeCommand 返回格式化字符串）
      const success = !output.startsWith('错误:') && !output.startsWith('安全限制:') && !output.startsWith('权限不足:') && !output.startsWith('命令执行异常:');
      return { success, stdout: output, stderr: '', exitCode: success ? 0 : 1 };
    }

    // bat/py/html 类型：路径必须在校验后的 allowedDirs 内
    const targetPath = resolve(body.target);
    if (!fs.existsSync(targetPath)) {
      return { error: `文件不存在: ${targetPath}`, code: 'FILE_NOT_FOUND' };
    }
    // P0-2: 路径必须在 allowedDirs 内，防任意路径执行
    // B3 修复：合并动态 settings.allowedDirs（用户设置的目录），统一数据源
    const execSettings = await getSettings().catch(() => null);
    const dynDirs = (execSettings?.allowedDirs || []).map((d: string) => resolve(d));
    const safeDirs = [...config.allowedDirs, ...dynDirs];
    if (!isPathAllowed(targetPath, safeDirs)) {
      return { error: `路径不在允许目录内: ${targetPath}`, code: 'PATH_NOT_ALLOWED' };
    }

    // html 类型：用默认浏览器打开（使用 start 命令，通过 executeCommand 处理）
    if (body.type === 'html') {
      const settings = await getSettings();
      const permLevel = settings.permissionLevel ?? 2;
      const allowedDirs = settings.allowedDirs || [];
      const defaultDir = settings.defaultDir || allowedDirs[0] || process.cwd();
      await executeCommand(`start "" "${targetPath}"`, defaultDir, 5000, allowedDirs, permLevel, defaultDir);
      return { success: true, message: '已用浏览器打开' };
    }

    // py 类型：spawn + shell:false 防命令注入（不再用 exec 拼字符串）
    if (body.type === 'py') {
      return new Promise((resolve) => {
        const child = spawn('python', [targetPath], { windowsHide: true, timeout: 30000, shell: false });
        let stdout = '', stderr = '';
        child.stdout?.on('data', (d: Buffer) => { stdout += d.toString(); });
        child.stderr?.on('data', (d: Buffer) => { stderr += d.toString(); });
        child.on('close', (code) => {
          resolve({ success: code === 0, stdout: stdout.trim(), stderr: stderr.trim(), exitCode: code ?? 0 });
        });
        child.on('error', (err) => {
          resolve({ success: false, stdout: '', stderr: err.message, exitCode: 1 });
        });
      });
    }

    // bat 类型：使用 executeCommand 执行（通过 cmd.exe /c 运行 bat 文件，但命令已通过内容扫描验证）
    if (body.type === 'bat') {
      // P0-5: 扫描 bat 内容，拒绝危险操作
      try {
        const { readFileSync: rfs } = await import('fs');
        const batContent = rfs(targetPath, 'utf-8');
        for (const pattern of FORBIDDEN_BAT_PATTERNS) {
          if (pattern.test(batContent)) {
            return { error: '脚本含危险操作模式，拒绝执行', code: 'BAT_DANGEROUS_CONTENT' };
          }
        }
      } catch { /* 读取失败，继续执行（文件可能被锁） */ }
      // P0-5: 使用 executeCommand 执行 bat 文件
      const settings = await getSettings();
      const permLevel = settings.permissionLevel ?? 2;
      const allowedDirs = settings.allowedDirs || [];
      const defaultDir = settings.defaultDir || allowedDirs[0] || process.cwd();
      const output = await executeCommand(`cmd /c "${targetPath}"`, defaultDir, 60000, allowedDirs, permLevel, defaultDir);
      const success = !output.startsWith('错误:') && !output.startsWith('安全限制:') && !output.startsWith('权限不足:') && !output.startsWith('命令执行异常:');
      return { success, stdout: output, stderr: '', exitCode: success ? 0 : 1 };
    }

    return { error: `未知类型: ${body.type}`, code: 'UNKNOWN_TYPE' };
  });
}