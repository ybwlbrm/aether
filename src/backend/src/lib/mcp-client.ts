/**
 * MCP 客户端管理器 — 加载数据库中的 MCP 服务器，提供工具列表与工具调用
 * 通过 @modelcontextprotocol/sdk 与本地/远程 MCP 服务器通信
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { isSafeFetchUrl } from './safe-fetch.js';
import { logger } from './logger.js';

export interface McpServerEntry {
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
  /** JSON Schema —— 结构由远端 MCP server 决定，不在本地约束，故为 unknown */
  inputSchema: unknown;
  serverName: string;
}

// 缓存已连接的客户端（按服务器 id）
const connectedClients = new Map<string, { client: Client; transport: Transport }>();
// 缓存工具列表（按服务器 id），带 TTL（P1-12 修复）
const cachedTools = new Map<string, McpToolDef[]>();
const cachedToolsAt = new Map<string, number>();
const CACHE_TTL_MS = 30_000; // 30 秒内不重新加载

// 整改计划第 2 章（P0/P1）：callTool 并发信号量 + 连接 TTL
const MAX_CONCURRENT_CALLS = 8; // 单进程最大并发 MCP 调用（防失控扇出）
let activeCalls = 0;
const CONNECTION_TTL_MS = 15 * 60_000; // 15 分钟未使用的连接将被关闭回收

/** 边界守卫：JSON 解析结果必须收敛为「非数组普通对象」才可当映射使用 */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 边界守卫：MCP content 数组中的文本块（判别联合 type === 'text' 分支） */
function isTextContentBlock(value: unknown): value is { type: 'text'; text: string } {
  return isRecord(value) && value.type === 'text' && typeof value.text === 'string';
}

/**
 * 从 MCP callTool 结果中提取文本内容。
 * SDK 的 callTool 返回联合类型（正常 CallToolResult | 兼容层 { toolResult } 包装），
 * 因此按 unknown 接收并用守卫收窄，不对联合成员做不安全断言。
 */
function extractMcpText(result: unknown): string {
  if (!isRecord(result) || !Array.isArray(result.content)) return '';
  return result.content.filter(isTextContentBlock).map(block => block.text).join('\n');
}

/** 解析 JSON 字段：仅接受字符串数组（spawn 只接受字符串参数），其余降级为空 */
function parseCommand(cmd: string | null): string[] {
  if (!cmd) return [];
  try {
    const parsed: unknown = JSON.parse(cmd);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((part): part is string => typeof part === 'string');
  } catch {
    return cmd.split(/\s+/).filter(Boolean);
  }
}

/** 解析 JSON 字符串映射字段（environment / headers）：非对象或非字符串值一律丢弃 */
function parseStringRecordField(field: string | null): Record<string, string> | undefined {
  if (!field) return undefined;
  try {
    const parsed: unknown = JSON.parse(field);
    if (!isRecord(parsed)) return undefined;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value === 'string') out[key] = value;
    }
    return out;
  } catch {
    return undefined;
  }
}

async function connectServer(server: McpServerEntry, timeout = 15000): Promise<{ client: Client; transport: Transport }> {
  if (connectedClients.has(server.id)) return connectedClients.get(server.id)!;

  if (server.type === 'local') {
    const cmd = parseCommand(server.command);
    if (cmd.length === 0) {
      throw new Error(`MCP 服务器 "${server.name}" 未配置命令`);
    }
    const parsedEnv = parseStringRecordField(server.environment);
    const env: Record<string, string> = parsedEnv
      ? { ...(process.env as Record<string, string>), ...parsedEnv }
      : (process.env as Record<string, string>);
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
      // AEX-P2-004 分类：ignored —— 清理阶段的二次失败不掩盖原始连接错误，
      // 仍以 throw e 向上传播根因。
      try { await client.close(); } catch {
        logger.debug({ event: 'mcp.connect_cleanup_client_close_ignored', serverId: server.id }, '连接失败后 client 关闭失败，已忽略');
      }
      try { await transport.close(); } catch {
        logger.debug({ event: 'mcp.connect_cleanup_transport_close_ignored', serverId: server.id }, '连接失败后 transport 关闭失败，已忽略');
      }
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
    const headers = parseStringRecordField(server.headers) || {};
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
      // AEX-P2-004 分类：ignored —— 清理阶段的二次失败不掩盖原始连接错误，仍以 throw e 传播根因。
      try { await client.close(); } catch {
        logger.debug({ event: 'mcp.connect_cleanup_client_close_ignored', serverId: server.id }, '远程连接失败后 client 关闭失败，已忽略');
      }
      try { await transport.close(); } catch {
        logger.debug({ event: 'mcp.connect_cleanup_transport_close_ignored', serverId: server.id }, '远程连接失败后 transport 关闭失败，已忽略');
      }
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
        inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
        serverName: server.name,
      }));
      cachedTools.set(server.id, tools);
      cachedToolsAt.set(server.id, Date.now());
      allTools.push(...tools);
    } catch (e: unknown) {
      // AEX-P2-004 分类：recoverable —— 单个 MCP 服务器不可用只损失该 server 的工具，
      // 其余 server 的工具照常返回给模型。
      logger.warn({ event: 'mcp.list_tools_failed', err: e, serverId: server.id, serverName: server.name }, '加载 MCP 工具失败，跳过该 server');
    }
  }
  return allTools;
}

/** 关闭单个 MCP server 的连接（整改计划第 2 章：update/disable/delete 时关旧 transport） */
export async function closeMcpServer(id: string): Promise<void> {
  const entry = connectedClients.get(id);
  if (!entry) return;
  const { client, transport } = entry;
  try { await client.close(); } catch (e: unknown) {
    // AEX-P2-004 分类：ignored —— 关闭旧连接的失败不影响「从注册表摘除」这一预期终态。
    logger.warn({ event: 'mcp.close_client_failed', err: e, serverId: id }, '关闭 MCP client 失败，已忽略');
  }
  try { await transport.close(); } catch (e: unknown) {
    // AEX-P2-004 分类：ignored —— 同上，transport 关闭失败不阻断摘除。
    logger.warn({ event: 'mcp.close_transport_failed', err: e, serverId: id }, '关闭 MCP transport 失败，已忽略');
  }
  connectedClients.delete(id);
  cachedTools.delete(id);
  cachedToolsAt.delete(id);
  lastActivityAt.delete(id);
}

/** 连接最后活动时间（TTL 回收用） */
const lastActivityAt = new Map<string, number>();

/** 回收超时未使用的连接（调用方在 callTool 前可周期性调用；返回关闭的连接数） */
export function reapIdleMcpConnections(): number {
  const now = Date.now();
  const expired: string[] = [];
  for (const [id, last] of lastActivityAt) {
    if (now - last > CONNECTION_TTL_MS) expired.push(id);
  }
  for (const id of expired) void closeMcpServer(id);
  return expired.length;
}

/**
 * 调用 MCP 工具（整改计划第 2 章：AbortSignal 支持 + 并发上限）。
 * 不再自动注入 confirm:true — 用户须显式确认写操作。
 */
export async function callMcpTool(
  serverName: string,
  toolName: string,
  args: Record<string, unknown>,
  getServerEntries: () => McpServerEntry[],
  permissionLevel?: number,
  signal?: AbortSignal,
): Promise<string> {
  // P1-16 修复：Level 1（只读）模式下阻止所有 MCP 工具调用（MCP 工具可执行任意代码）
  // Level 3（超级）绕过所有限制
  if (permissionLevel === 1) {
    return `权限不足：当前为 Level 1（只读）模式，不允许调用 MCP 工具 "${toolName}"。请切换到 Level 2 或 Level 3 以允许。`;
  }
  const server = getServerEntries().find(s => s.enabled && s.name === serverName);
  if (!server) return `错误: MCP 服务器 "${serverName}" 未找到或未启用`;
  // 整改计划第 2 章：并发上限 —— 超过限制直接拒绝，防止 MCP 工具失控扇出
  if (activeCalls >= MAX_CONCURRENT_CALLS) {
    return `错误: MCP 并发调用已达上限（${MAX_CONCURRENT_CALLS}），请稍后重试`;
  }
  activeCalls += 1;
  try {
    // P1-2: MCP 服务器不可达时 connectServer/callTool 可能永久挂起 — 用 Promise.race 加 60s 超时兜底，
    // 超时后 reject，由下方 catch 统一转为错误字符串返回给调用方
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    let abortReject: ((e: Error) => void) | null = null;
    const onAbort = () => abortReject?.(new Error('aborted'));
    if (signal) {
      if (signal.aborted) return `工具调用已取消`;
      signal.addEventListener('abort', onAbort, { once: true });
    }
    try {
      const result: unknown = await Promise.race([
        (async () => {
          const { client } = await connectServer(server);
          lastActivityAt.set(server.id, Date.now());
          // P0-3: 不再自动注入 confirm:true — AI 调用写操作工具需经用户确认
          // 调用方（agents/conversations）应通过 SSE 事件回传确认请求给前端
          const callArgs: Record<string, unknown> = { ...args };
          return client.callTool({
            name: toolName,
            arguments: callArgs,
          });
        })().finally(() => { if (timeoutTimer !== undefined) clearTimeout(timeoutTimer); }),
        new Promise<never>((_, reject) => {
          abortReject = reject;
          timeoutTimer = setTimeout(() => reject(new Error('MCP 工具调用超时：60 秒内无响应')), 60_000);
        }),
      ]);
      lastActivityAt.set(server.id, Date.now());
      // result 是 unknown（SDK 返回联合类型）——先守卫提取 text 块，再判 isError
      const text = extractMcpText(result);
      if (text) return text.slice(0, 4000);
      if (isRecord(result) && result.isError === true) {
        return `工具执行报错: ${JSON.stringify(result).slice(0, 800)}`;
      }
      return JSON.stringify(result).slice(0, 4000);
    } finally {
      if (signal) signal.removeEventListener('abort', onAbort);
    }
  } catch (e: unknown) {
    if (signal?.aborted) return `工具调用已取消`;
    return `工具调用失败: ${(e instanceof Error ? e.message : String(e))}`;
  } finally {
    activeCalls -= 1;
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
    try { await client.close(); } catch (e: unknown) {
      // AEX-P2-004 分类：ignored —— 批量关闭是「尽力而为」的资源回收，单个失败不阻断其余 server。
      logger.warn({ event: 'mcp.close_all_client_failed', err: e, serverId: id }, '关闭 MCP client 失败，已忽略');
    }
    try { await transport.close(); } catch (e: unknown) {
      // AEX-P2-004 分类：ignored —— 同上，transport 关闭失败不阻断摘除。
      logger.warn({ event: 'mcp.close_all_transport_failed', err: e, serverId: id }, '关闭 MCP transport 失败，已忽略');
    }
    connectedClients.delete(id);
  }
  cachedTools.clear();
}