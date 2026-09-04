import type { FastifyInstance } from 'fastify';
import type { BackendConfig } from '../../config/index.js';
import { getDb } from '../../db/client.js';
import { mcpServers } from '../../db/schema/index.js';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { homedir } from 'node:os';

// P0-6: MCP 命令白名单 — 只允许常见的 MCP server 启动命令
const MCP_ALLOWED_COMMANDS = new Set([
  'node', 'npx', 'tsx', 'npm', 'python', 'python3', 'uv', 'pip',
  'deno', 'bun', 'java', 'ruby', 'go',
]);
// P0-6: 危险命令黑名单
const MCP_FORBIDDEN_COMMANDS = new Set([
  'cmd', 'cmd.exe', 'powershell', 'powershell.exe', 'pwsh',
  'wscript', 'cscript', 'sh', 'bash', 'zsh',
  'rm', 'del', 'format', 'shutdown', 'regedit',
]);

// SEC-034: 参数级危险标志（子串匹配，大小写不敏感）。
// 聚焦「拉取远程代码」与「全权限提权」两类，避免误伤本地合法用法（如本地编译、本地 --import-map）。
const MCP_DANGEROUS_ARG_FRAGMENTS = [
  // deno/bun 全权限或联网
  '--allow-all', '-A',
  '--allow-net', '--allow-read', '--allow-write', '--allow-run', '--allow-env', '--allow-ffi',
  '--network', '--fetch',
  // 远程代码/脚本 URL
  'http://', 'https://', 'ftp://',
];

/** P0-6: 校验 MCP 命令是否安全 */
function validateMcpCommand(command: any): { ok: boolean; error?: string } {
  if (!Array.isArray(command) || command.length === 0) {
    return { ok: false, error: '命令必须是非空数组' };
  }
  const cmdName = String(command[0]).toLowerCase();
  const baseName = basename(cmdName);
  // 检查黑名单
  if (MCP_FORBIDDEN_COMMANDS.has(cmdName) || MCP_FORBIDDEN_COMMANDS.has(baseName)) {
    return { ok: false, error: `命令 "${cmdName}" 被禁止` };
  }
  // 检查白名单（允许 baseName 匹配）
  if (!MCP_ALLOWED_COMMANDS.has(cmdName) && !MCP_ALLOWED_COMMANDS.has(baseName)) {
    return { ok: false, error: `命令 "${cmdName}" 不在允许列表中` };
  }
  // SEC-034: 扫描参数，阻断远程代码拉取与全权限提权标志
  const args = command.slice(1);
  for (const arg of args) {
    const s = String(arg).toLowerCase();
    for (const frag of MCP_DANGEROUS_ARG_FRAGMENTS) {
      if (s.includes(frag)) {
        return { ok: false, error: `命令 "${cmdName}" 包含危险参数 "${String(arg)}"（禁止远程代码/全权限执行）` };
      }
    }
  }
  return { ok: true };
}

/** P0-8: 校验 MCP 远程服务器 URL 是否安全（SSRF 防护）
 *  与 search/index.ts 的 isSafeFetchUrl 类似，但允许本地/私网地址（本地 MCP server 合法）。
 *  仅拦截：非 http/https、链路本地 169.254.0.0/16（云元数据）、0.0.0.0。 */
function isSafeMcpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    // 云元数据地址（AWS/Azure/GCP/Aliyun）— 必须拦截
    if (host === '169.254.169.254' || host.endsWith('.metadata.google.internal') || host === 'metadata.google.internal') return false;
    // 链路本地 169.254.0.0/16
    if (/^169\.254\./.test(host)) return false;
    // 0.0.0.0
    if (host === '0.0.0.0') return false;
    // 防止十进制/八进制混淆 IP（如 http://2130706433 指向 127.0.0.1）
    try {
      const ip = u.hostname.startsWith('[') ? u.hostname.slice(1, -1) : u.hostname;
      if (/^\d+$/.test(ip.replace(/\./g, '')) && ip.includes('.')) {
        if (/^(169\.254\.)/.test(ip)) return false;
      }
    } catch { /* 忽略解析失败 */ }
    return true;
  } catch {
    return false;
  }
}

export function registerMcpRoutes(app: FastifyInstance, _config: BackendConfig): void {
  const db = getDb();

  // 获取所有 MCP 服务器
  app.get('/api/mcp/servers', {
    schema: { description: '获取所有 MCP 服务器', tags: ['MCP'] },
  }, async () => {
    return db.select().from(mcpServers).all();
  });

  // 获取单个 MCP 服务器
  app.get('/api/mcp/servers/:id', {
    schema: { description: '获取单个 MCP 服务器', tags: ['MCP'] },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const server = db.select().from(mcpServers).where(eq(mcpServers.id, id)).get();
    if (!server) return { error: 'MCP server not found' };
    return server;
  });

  // 创建 MCP 服务器
  app.post('/api/mcp/servers', {
    schema: { description: '创建 MCP 服务器', tags: ['MCP'] },
  }, async (request, reply) => {
    const body = request.body as any;
    // P0-6: 命令校验
    if (body.command) {
      const check = validateMcpCommand(body.command);
      if (!check.ok) return reply.code(400).send({ error: check.error });
    }
    // P0-8: URL 安全校验（仅远程类型需要）
    if (body.url && !isSafeMcpUrl(body.url)) {
      return reply.code(400).send({ error: 'URL 不安全：禁止访问云元数据、链路本地或非 http/https 地址' });
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    db.insert(mcpServers).values({
      id,
      name: body.name,
      type: body.type || 'local',
      command: body.command ? JSON.stringify(body.command) : null,
      cwd: body.cwd || null,
      environment: body.environment ? JSON.stringify(body.environment) : null,
      url: body.url || null,
      enabled: body.enabled !== false,
      timeout: body.timeout || 5000,
      headers: body.headers ? JSON.stringify(body.headers) : null,
      createdAt: now,
      updatedAt: now,
    }).run();
    return db.select().from(mcpServers).where(eq(mcpServers.id, id)).get();
  });

  // 更新 MCP 服务器
  app.put('/api/mcp/servers/:id', {
    schema: { description: '更新 MCP 服务器', tags: ['MCP'] },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as any;
    const existing = db.select().from(mcpServers).where(eq(mcpServers.id, id)).get();
    if (!existing) return { error: 'MCP server not found' };
    // P0-6: 命令校验
    if (body.command !== undefined && body.command !== null) {
      const check = validateMcpCommand(body.command);
      if (!check.ok) return reply.code(400).send({ error: check.error });
    }
    // P0-8: URL 安全校验（仅远程类型需要，或显式提供 url 时）
    if (body.url !== undefined && body.url !== null && !isSafeMcpUrl(body.url)) {
      return reply.code(400).send({ error: 'URL 不安全：禁止访问云元数据、链路本地或非 http/https 地址' });
    }

    const updateData: any = { updatedAt: new Date().toISOString() };
    if (body.name !== undefined) updateData.name = body.name;
    if (body.type !== undefined) updateData.type = body.type;
    if (body.command !== undefined) updateData.command = JSON.stringify(body.command);
    if (body.cwd !== undefined) updateData.cwd = body.cwd;
    if (body.environment !== undefined) updateData.environment = JSON.stringify(body.environment);
    if (body.url !== undefined) updateData.url = body.url;
    if (body.enabled !== undefined) updateData.enabled = body.enabled;
    if (body.timeout !== undefined) updateData.timeout = body.timeout;
    if (body.headers !== undefined) updateData.headers = JSON.stringify(body.headers);

    db.update(mcpServers).set(updateData).where(eq(mcpServers.id, id)).run();
    return db.select().from(mcpServers).where(eq(mcpServers.id, id)).get();
  });

  // 删除 MCP 服务器
  app.delete('/api/mcp/servers/:id', {
    schema: { description: '删除 MCP 服务器', tags: ['MCP'] },
  }, async (request) => {
    const { id } = request.params as { id: string };
    db.delete(mcpServers).where(eq(mcpServers.id, id)).run();
    return { success: true };
  });

  // 测试 MCP 服务器连接
  app.post('/api/mcp/servers/:id/test', {
    schema: { description: '测试 MCP 服务器连接', tags: ['MCP'] },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const server = db.select().from(mcpServers).where(eq(mcpServers.id, id)).get();
    if (!server) return { error: 'MCP server not found' };

    try {
      if (server.type === 'local') {
        // 本地类型：尝试启动进程并获取工具列表
        // P1-7 修复：JSON.parse 加 try-catch，避免数据库脏数据导致测试接口 500
        let cmd: any[] = [];
        try { const parsed = server.command ? JSON.parse(server.command) : []; if (Array.isArray(parsed)) cmd = parsed; } catch { cmd = []; }
        if (!Array.isArray(cmd) || cmd.length === 0) {
          return { success: false, message: '未配置命令' };
        }
        let env = process.env;
        try {
          const parsedEnv = server.environment ? JSON.parse(server.environment) : null;
          if (parsedEnv && typeof parsedEnv === 'object') env = { ...process.env, ...parsedEnv };
        } catch { /* 无效 environment 则忽略 */ }
        const child = spawn(cmd[0], cmd.slice(1), {
          cwd: server.cwd || undefined,
          env,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: true,
        });
        const result = await new Promise<{ success: boolean; message: string }>((resolve) => {
          let settled = false;
          const cleanup = () => { clearTimeout(timeout); clearTimeout(checkTimer); };
          const timeout = setTimeout(() => {
            if (settled) return; settled = true; cleanup();
            child.kill();
            resolve({ success: false, message: '连接超时' });
          }, server.timeout || 5000);
          let output = '';
          // SEC-035: 限制收集的输出大小（1MB），防恶意 MCP server 无限输出耗尽内存
          const MAX_MCP_OUTPUT = 1024 * 1024;
          child.stdout?.on('data', (data: Buffer) => { if (output.length < MAX_MCP_OUTPUT) output += data.toString(); });
          child.stderr?.on('data', (data: Buffer) => { if (output.length < MAX_MCP_OUTPUT) output += data.toString(); });
          child.on('error', (err) => { if (settled) return; settled = true; cleanup(); resolve({ success: false, message: err.message }); });
          child.on('exit', (code) => {
            if (settled) return; settled = true; cleanup();
            if (code === 0) {
              resolve({ success: true, message: '连接成功，进程已退出' });
            } else {
              resolve({ success: false, message: `进程退出码: ${code}, 输出: ${output.slice(0, 200)}` });
            }
          });
          // 如果进程持续运行（如 MCP server），等待一会后认为成功
          const checkTimer = setTimeout(() => {
            if (settled) return; settled = true; cleanup();
            child.kill();
            resolve({ success: true, message: 'MCP 服务器已启动并运行' });
          }, 2000);
        });
        return result;
      } else {
        // 远程类型：HTTP 请求测试
        if (!server.url) return { success: false, message: '未配置 URL' };
        // P0-8: URL 安全校验
        if (!isSafeMcpUrl(server.url)) {
          return { success: false, message: 'URL 不安全：禁止访问云元数据、链路本地或非 http/https 地址' };
        }
        const headers: Record<string, string> = {};
        if (server.headers) {
          try { Object.assign(headers, JSON.parse(server.headers)); } catch (_e: unknown) { console.warn("[SilentCatch]", _e); }
        }
        const res = await fetch(server.url, { method: 'GET', headers, signal: AbortSignal.timeout(server.timeout || 5000) });
        return { success: res.ok, message: `HTTP ${res.status}: ${res.statusText}` };
      }
    } catch (e: unknown) {
      return { success: false, message: (e instanceof Error ? e.message : String(e)) };
    }
  });

  // 从 OpenCode/Codex 配置一键导入 MCP 服务器
  app.post('/api/mcp/import', {
    schema: { description: '从 OpenCode/Codex 配置文件导入 MCP 服务器', tags: ['MCP'] },
  }, async () => {
    const imported: string[] = [];
    const errors: string[] = [];
    const now = new Date().toISOString();

    // 搜索多个配置文件
    const configPaths = [
      resolve(homedir(), '.config', 'opencode', 'opencode.json'),
      resolve(homedir(), '.config', 'opencode', 'opencode.jsonc'),
      resolve(process.cwd(), 'opencode.json'),
      resolve(process.cwd(), '.opencode', 'opencode.json'),
      resolve(homedir(), '.codex', 'config.json'),
    ];

    for (const configPath of configPaths) {
      if (!existsSync(configPath)) continue;
      try {
        const raw = readFileSync(configPath, 'utf-8');
        const cfg = JSON.parse(raw);
        const mcpEntries = cfg.mcp || cfg.mcpServers || {};
        for (const [name, server] of Object.entries(mcpEntries)) {
          try {
            const s = server as any;
            // 检查是否已存在同名服务器
            const existing = db.select().from(mcpServers).where(eq(mcpServers.name, name)).get();
            if (existing) {
              // 更新已有配置
              db.update(mcpServers).set({
                type: s.type || 'local',
                command: s.command ? JSON.stringify(s.command) : null,
                cwd: s.cwd || null,
                environment: s.environment ? JSON.stringify(s.environment) : null,
                url: s.url || null,
                enabled: s.enabled !== false,
                timeout: s.timeout || 5000,
                headers: s.headers ? JSON.stringify(s.headers) : null,
                updatedAt: now,
              }).where(eq(mcpServers.name, name)).run();
              imported.push(`${name} (已更新)`);
            } else {
              // 新建
              db.insert(mcpServers).values({
                id: randomUUID(),
                name,
                type: s.type || 'local',
                command: s.command ? JSON.stringify(s.command) : null,
                cwd: s.cwd || null,
                environment: s.environment ? JSON.stringify(s.environment) : null,
                url: s.url || null,
                enabled: s.enabled !== false,
                timeout: s.timeout || 5000,
                headers: s.headers ? JSON.stringify(s.headers) : null,
                createdAt: now,
                updatedAt: now,
              }).run();
              imported.push(name);
            }
          } catch (e: unknown) {
            errors.push(`${name}: ${(e instanceof Error ? e.message : String(e))}`);
          }
        }
      } catch (e: unknown) {
        errors.push(`${basename(configPath)}: ${(e instanceof Error ? e.message : String(e))}`);
      }
    }

    return { imported, errors, total: imported.length };
  });
}