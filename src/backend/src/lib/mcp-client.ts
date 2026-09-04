/**
 * MCP 客户端管理器 — 加载数据库中的 MCP 服务器，提供工具列表与工具调用
 * 通过 @modelcontextprotocol/sdk 与本地/远程 MCP 服务器通信
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { isSafeFetchUrl } from './safe-fetch.js';

interface McpServerEntry {
  id: string;
  name: string;
  type: 'local' | 'remote';
  command: string | null;
  cwd: string | null;
  environment: string | null;
  url: string | null;
  enabled: boolean;
  timeout: number;
  headers: string | null;
}

interface McpToolDef {
  name: string;
  description?: string;
  inputSchema: any;
  serverName: string;
}

// 缓存已连接的客户端（按服务器 id）
const connectedClients = new Map<string, { client: Client; transport: Transport }>();
// 缓存工具列表（按服务器 id），带 TTL（P1-12 修复）
const cachedTools = new Map<string, McpToolDef[]>();
const cachedToolsAt = new Map<string, number>();
const CACHE_TTL_MS = 30_000; // 30 秒内不重新加载

function parseCommand(cmd: string | null): string[] {
  if (!cmd) return [];
  try {
    const parsed = JSON.parse(cmd);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return cmd.split(/\s+/).filter(Boolean);
  }
}

function parseJsonField(field: string | null): any {
  if (!field) return undefined;
  try { return JSON.parse(field); } catch { return undefined; }
}

async function connectServer(server: McpServerEntry, timeout = 15000): Promise<{ client: Client; transport: Transport }> {
  if (connectedClients.has(server.id)) return connectedClients.get(server.id)!;

  if (server.type === 'local') {
    const cmd = parseCommand(server.command);
    if (cmd.length === 0) {
      throw new Error(`MCP 服务器 "${server.name}" 未配置命令`);
    }
    const env = server.environment
      ? { ...process.env, ...parseJsonField(server.environment) }
      : process.env;
    const transport = new StdioClientTransport({
      command: cmd[0],
      args: cmd.slice(1),
      cwd: server.cwd || undefined,
      env,
    });
    const client = new Client({ name: 'pacc-mcp-client', version: '1.0.0' });
    // 审计修复：单 setTimeout + reject Promise，避免双重 setTimeout 泄漏
    let rejectTimeout: ((e: Error) => void) | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => { rejectTimeout = reject; });
    const timeoutHandle = setTimeout(() => {
      rejectTimeout?.(new Error('MCP 连接超时'));
    }, timeout);
    try {
      await Promise.race([client.connect(transport), timeoutPromise]);
    } catch (e) {
      // 超时或连接失败时清理 transport，防止资源泄漏
      try { await client.close(); } catch (_e: unknown) { /* ignore - intentional */ }
      try { (transport as any).close?.(); } catch (_e: unknown) { /* ignore - intentional */ }
      throw e;
    } finally {
      clearTimeout(timeoutHandle);
    }
    const entry = { client, transport };
    connectedClients.set(server.id, entry);
    return entry;
  } else {
    // 远程类型（HTTP/SSE）— 用 StreamableHTTPClientTransport
    const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');
    if (!server.url) throw new Error(`远程 MCP 服务器 "${server.name}" 未配置 URL`);
    // 纵深防御：显式校验 server.url（防配置篡改/注入）
    if (!isSafeFetchUrl(server.url)) throw new Error(`MCP 服务器 "${server.name}" URL 存在 SSRF 风险：禁止访问链路本地/元数据地址或非 http(s) 协议`);
    const headers = parseJsonField(server.headers) || {};
    const transport = new StreamableHTTPClientTransport(new URL(server.url), { requestInit: { headers } });
    const client = new Client({ name: 'pacc-mcp-client', version: '1.0.0' });
    // P0-9 修复：远程连接与本地一致加超时兜底，避免不可达服务器永久挂起所有 MCP 调用
    let rejectTimeout: ((e: Error) => void) | null = null;
    const timeoutPromise = new Promise<never>((_, reject) => { rejectTimeout = reject; });
    const timeoutHandle = setTimeout(() => {
      rejectTimeout?.(new Error('远程 MCP 连接超时'));
    }, timeout);
    try {
      await Promise.race([client.connect(transport), timeoutPromise]);
    } catch (e) {
      // 超时/失败时清理 transport，防连接泄漏
      try { await client.close(); } catch (_e: unknown) { /* ignore - intentional */ }
      try { (transport as any).close?.(); } catch (_e: unknown) { /* ignore - intentional */ }
      throw e;
    } finally {
      clearTimeout(timeoutHandle);
    }
    const entry = { client, transport };
    connectedClients.set(server.id, entry);
    return entry;
  }
}

/** 获取所有已启用 MCP 服务器的工具列表（转成 OpenAI function schema） */
export async function listMcpTools(getServerEntries: () => McpServerEntry[]): Promise<McpToolDef[]> {
  const servers = getServerEntries().filter(s => s.enabled);
  const allTools: McpToolDef[] = [];

  for (const server of servers) {
    const cached = cachedTools.get(server.id);
    const cachedAt = cachedToolsAt.get(server.id) || 0;
    if (cached && Date.now() - cachedAt < CACHE_TTL_MS) {
      allTools.push(...cached);
      continue;
    }
    try {
      const { client } = await connectServer(server);
      const result = await client.listTools();
      const tools: McpToolDef[] = result.tools.map(tool => ({
        name: `${server.name}_${tool.name}`,
        description: tool.description || `MCP 工具 from ${server.name}`,
        inputSchema: (tool as any).inputSchema || { type: 'object', properties: {} },
        serverName: server.name,
      }));
      cachedTools.set(server.id, tools);
      cachedToolsAt.set(server.id, Date.now());
      allTools.push(...tools);
    } catch (e: unknown) {
      console.warn(`[MCP] 加载 ${server.name} 工具失败: ${(e instanceof Error ? e.message : String(e))}`);
    }
  }
  return allTools;
}

/** 调用 MCP 工具（不再自动注入 confirm:true — 用户须显式确认写操作） */
export async function callMcpTool(serverName: string, toolName: string, args: any, getServerEntries: () => McpServerEntry[], permissionLevel?: number): Promise<string> {
  // P1-16 修复：Level 1（只读）模式下阻止所有 MCP 工具调用（MCP 工具可执行任意代码）
  // Level 3（超级）绕过所有限制
  if (permissionLevel === 1) {
    return `权限不足：当前为 Level 1（只读）模式，不允许调用 MCP 工具 "${toolName}"。请切换到 Level 2 或 Level 3 以允许。`;
  }
  const server = getServerEntries().find(s => s.enabled && s.name === serverName);
  if (!server) return `错误: MCP 服务器 "${serverName}" 未找到或未启用`;
  try {
    // P1-2: MCP 服务器不可达时 connectServer/callTool 可能永久挂起 — 用 Promise.race 加 60s 超时兜底，
    // 超时后 reject，由下方 catch 统一转为错误字符串返回给调用方
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const result = await Promise.race([
      (async () => {
        const { client } = await connectServer(server);
        // P0-3: 不再自动注入 confirm:true — AI 调用写操作工具需经用户确认
        // 调用方（agents/conversations）应通过 SSE 事件回传确认请求给前端
        const callArgs = { ...(args || {}) };
        return client.callTool({
          name: toolName,
          arguments: callArgs,
        });
      })().finally(() => { if (timeoutTimer !== undefined) clearTimeout(timeoutTimer); }),
      new Promise<never>((_, reject) => {
        timeoutTimer = setTimeout(() => reject(new Error('MCP 工具调用超时：60 秒内无响应')), 60_000);
      }),
    ]);
    // result.content 是 [{type:'text', text}, ...]
    if (result && (result as any).content) {
      const text = (result as any).content
        .filter((c: any) => c.type === 'text')
        .map((c: any) => c.text)
        .join('\n');
      if (text) return text.slice(0, 4000);
    }
    if ((result as any).isError) return `工具执行报错: ${JSON.stringify(result).slice(0, 800)}`;
    return JSON.stringify(result).slice(0, 4000);
  } catch (e: unknown) {
    return `工具调用失败: ${(e instanceof Error ? e.message : String(e))}`;
  }
}

/** 关闭所有 MCP 连接 */
export async function closeAllMcpClients(): Promise<void> {
  // 审计修复：先收集全部 ID 再迭代，避免迭代中删除 Map 的隐患
  const ids = [...connectedClients.keys()];
  for (const id of ids) {
    const entry = connectedClients.get(id);
    if (!entry) continue;
    const { client, transport } = entry;
    try { await client.close(); } catch (_e: unknown) { console.warn("[SilentCatch]", _e); }
    try { (transport as any).close?.(); } catch (_e: unknown) { console.warn("[SilentCatch]", _e); }
    connectedClients.delete(id);
  }
  cachedTools.clear();
}