/**
 * 终端模块 — 提供 Web 终端页面可调用的命令执行接口
 * 共享命令历史由 command.ts 维护，终端页面和 Agent 共用
 */
import type { FastifyInstance } from 'fastify';
import type { BackendConfig } from '../../config/index.js';
import { executeCommand, addCommandHistory, getCommandHistory } from '../../lib/command.js';
import { getSettings } from '../../lib/dal.js';

export function registerTerminalRoutes(app: FastifyInstance, _config: BackendConfig): void {
  // 获取命令执行历史（含 Agent 执行的命令）
  app.get('/api/terminal/history', {
    schema: { description: '获取命令执行历史（含 Agent 执行的命令）', tags: ['终端'] },
  }, async () => {
    return getCommandHistory();
  });

  // 执行命令（供终端页面手动输入使用）
  app.post('/api/terminal/execute', {
    schema: {
      description: '在终端中执行命令（与 AI Agent 共用安全模型）',
      tags: ['终端'],
      body: {
        type: 'object',
        required: ['command'],
        properties: {
          command: { type: 'string', description: '要执行的命令' },
          workdir: { type: 'string', description: '工作目录（可选）' },
          timeout: { type: 'number', description: '超时时间毫秒（默认 30000）' },
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body as { command: string; workdir?: string; timeout?: number };
    if (!body.command || !body.command.trim()) {
      return reply.code(400).send({ error: '命令不能为空' });
    }

    const settings = await getSettings();
    const allowedDirs = Array.isArray(settings.allowedDirs) && settings.allowedDirs.length > 0
      ? settings.allowedDirs
      : [process.cwd()];
    const defaultDir = settings.defaultDir || allowedDirs[0] || process.cwd();
    const permLevel = settings.permissionLevel ?? 2;

    const startTime = Date.now();
    const output = await executeCommand(
      body.command,
      body.workdir,
      body.timeout,
      allowedDirs,
      permLevel,
      defaultDir,
    );

    const duration = Date.now() - startTime;
    const success = !output.startsWith('错误:') && !output.startsWith('安全限制') && !output.startsWith('权限不足');

    // 写入共享历史
    addCommandHistory({ command: body.command, output, duration, success, source: 'terminal' });

    return { output };
  });
}