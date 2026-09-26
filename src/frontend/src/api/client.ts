import {
  ApiErrorCode,
  extractErrorMessage,
  fromHttpFailure,
  fromTransportFailure,
  type ApiError,
  type ApiResult,
} from './contract';
import type {
  DefaultProviders,
  ImportAllResult,
  McpImportResult,
  MemoryRow,
  ProviderSummary,
  TerminalEntry,
  TerminalExecuteResult,
  ToolboxConvertResult,
  ToolboxEncodePayload,
  ToolboxEncodeResult,
  ToolboxFileResult,
  ToolboxPdfCompressResult,
  ToolboxPdfToDocxResult,
  ToolboxReadResult,
  ToolboxUnlockResult,
  ToolboxUtilityResult,
  ToolboxYoutubeResult,
  ToolsStatus,
  SyncConfigInfo,
  WikiPageRow,
} from './types';

const BASE = '/api';
// P1-5: 默认请求超时 30s（SSE 流式端点除外）
const DEFAULT_TIMEOUT_MS = 30000;
// P2: AI 媒体生成超时 300s（图片/视频 AI 生成+轮询最长 5 分钟）
const MEDIA_TIMEOUT_MS = 300000;

const TIMEOUT_MESSAGE = '请求超时，请检查网络连接';

/** request / requestResult 共用的请求选项（timeout 为本层扩展，非标准 RequestInit） */
export interface ApiRequestOptions extends RequestInit {
  timeout?: number;
}

/**
 * 传输层结果：把 fetch 的三种失败（主动取消 / 超时 / 网络中断）与成功响应分开表达，
 * 让 `request`（抛 Error，向后兼容）与 `requestResult`（返回 ApiError）共用同一段 IO。
 */
type TransportOutcome =
  | { kind: 'response'; res: Response }
  | { kind: 'aborted'; cause: unknown }
  | { kind: 'timeout' }
  | { kind: 'network'; cause: unknown };

// 本地认证 token（启动时从 /api/auth/token 获取，仅内存）
let authToken: string | null = null;
// 整改计划：authReadyPromise —— initAuthToken 只跑一次，供 ensureAuthToken 等待
let authReadyPromise: Promise<void> | null = null;

/** 初始化认证 token（应用启动时调用一次；幂等 —— 多次调用共用同一 Promise） */
export function initAuthToken(): Promise<void> {
  if (!authReadyPromise) {
    authReadyPromise = (async () => {
      try {
        const res = await fetch(`${BASE}/auth/token`, {
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
        });
        if (res.ok) {
          const data = await res.json();
          authToken = data.token ?? null;
        }
      } catch {
        // 静默失败：token 获取失败不阻断应用，写请求会 401 提示重试
      }
    })();
  }
  return authReadyPromise;
}

/**
 * 整改计划第 1 章（P0）：确保认证 token 已就绪。
 * 后端默认拒绝鉴权 —— 若用户刷新页面后立即发送消息（token 尚未异步获取），
 * 写请求会因缺 Authorization 被 401 拒绝，导致"新对话首条消息丢失"。
 * 调用方（request / streamClient 写请求）在发起请求前 await 此函数。
 */
export async function ensureAuthToken(): Promise<void> {
  if (authToken) return;
  await initAuthToken();
}

/** 获取当前认证 token（供调试/测试用） */
export function getAuthToken(): string | null {
  return authToken;
}

/**
 * 默认拒绝鉴权（整改计划第 1 章，P0）：后端所有非 GET/HEAD 路由缺 Bearer 一律 401。
 * 供页面内直接 fetch 的写请求复用：返回应附加的 Authorization 头。
 */
export function authHeaders(): Record<string, string> {
  return authToken ? { Authorization: `Bearer ${authToken}` } : {};
}

/**
 * 统一传输层：注入 CSRF 头 / 鉴权头 / 超时，**不解释响应体**。
 * request（抛 Error）与 requestResult（返回 ApiError）都建立在它之上，避免逻辑分叉。
 */
async function sendRequest(path: string, options?: ApiRequestOptions): Promise<TransportOutcome> {
  // 仅当有请求体时才设置 Content-Type: application/json，
  // 否则 Fastify 会因空 JSON body 报 400/415 错误。
  const hasBody = options?.body != null;
  const headers: Record<string, string> = { ...(options?.headers as Record<string, string> | undefined) };
  if (hasBody) headers['Content-Type'] = 'application/json';
  // P1-5: 超时控制 — 非 SSE 请求 30s 超时
  // Oracle-5: CSRF 防护 — 所有请求附带 X-Requested-With header
  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => { timedOut = true; controller.abort(); }, options?.timeout ?? DEFAULT_TIMEOUT_MS);
  const signal = options?.signal ? mergeSignals(options.signal, controller.signal) : controller.signal;
  // 确保所有请求都带 X-Requested-With（CSRF 防护要求）
  headers['X-Requested-With'] = 'XMLHttpRequest';
  // 默认拒绝鉴权（整改计划第 1 章，P0）：后端所有非 GET/HEAD 路由缺 Bearer 一律 401。
  // 因此所有非 GET 请求必须附加 Authorization；GET 仅对敏感读路径（导出/下载/审批）附加。
  const method = (options?.method ?? 'GET').toUpperCase();
  const isReadMethod = method === 'GET' || method === 'HEAD';
  const sensitiveReadPaths = [
    '/export/all',
    '/sync/download',
    '/sync/config',
    '/approvals/',
  ];
  const isSensitiveRead = sensitiveReadPaths.some(p =>
    path === p || (p.endsWith('/') && path.startsWith(p))
  );
  const needsAuth = !isReadMethod || isSensitiveRead;
  if (needsAuth) {
    // 整改计划第 1 章（P0）：写请求前确保 token 已就绪（防止刷新后首条消息 401 丢失）
    await ensureAuthToken();
  }
  if (needsAuth && authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  try {
    const res = await fetch(`${BASE}${path}`, { ...options, headers, signal });
    return { kind: 'response', res };
  } catch (e: unknown) {
    // P1-2 修复：区分主动取消（调用方 signal）与超时，避免误导性文案
    if (e instanceof Error && e.name === 'AbortError') {
      if (options?.signal?.aborted) return { kind: 'aborted', cause: e };
      if (controller.signal.aborted || timedOut) return { kind: 'timeout' };
    }
    return { kind: 'network', cause: e };
  } finally {
    clearTimeout(timeout);
    // P0 修复：请求结束移除 mergeSignals 注册的监听器，防内存泄漏
    if (options?.signal) cleanupMergedSignals(options.signal, controller.signal);
  }
}

/** 读取错误响应体：非 JSON / 空体时返回 null，由 fromHttpFailure 回退到状态码文案。 */
async function readErrorBody(res: Response): Promise<unknown> {
  try {
    const text = await res.text();
    if (!text) return null;
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function transportError(outcome: Exclude<TransportOutcome, { kind: 'response' }>): ApiError {
  switch (outcome.kind) {
    case 'aborted':
      return fromTransportFailure(ApiErrorCode.Aborted, '请求已取消', outcome.cause);
    case 'timeout':
      return fromTransportFailure(ApiErrorCode.Timeout, TIMEOUT_MESSAGE);
    case 'network':
      return fromTransportFailure(
        ApiErrorCode.NetworkError,
        '网络连接失败，请检查网络后重试',
        outcome.cause instanceof Error ? outcome.cause.message : String(outcome.cause),
      );
  }
}

async function request<T>(path: string, options?: ApiRequestOptions): Promise<T> {
  const outcome = await sendRequest(path, options);
  if (outcome.kind === 'response') {
    const { res } = outcome;
    if (!res.ok) throw new Error(extractErrorMessage(await readErrorBody(res)) ?? `请求失败: ${res.status}`);
    return res.json() as Promise<T>;
  }
  if (outcome.kind === 'timeout') throw new Error(TIMEOUT_MESSAGE);
  throw outcome.cause;
}

/**
 * AEX-P1-017 统一契约入口：**永不 throw**，成功给 data，失败给结构化 ApiError。
 * 调用点必须判别 `ok` —— 因此"空数据"与"请求失败"在类型层就是两件事，
 * 从根上杜绝 `catch → []` 把错误伪装成空列表。
 */
export async function requestResult<T>(path: string, options?: ApiRequestOptions): Promise<ApiResult<T>> {
  const outcome = await sendRequest(path, options);
  if (outcome.kind !== 'response') return { ok: false, error: transportError(outcome) };
  const { res } = outcome;
  if (!res.ok) return { ok: false, error: fromHttpFailure(res.status, await readErrorBody(res)) };
  let raw: string;
  try {
    raw = await res.text();
  } catch (e: unknown) {
    return { ok: false, error: fromTransportFailure(ApiErrorCode.ParseError, '响应读取失败', String(e)) };
  }
  if (!raw) {
    return { ok: false, error: fromTransportFailure(ApiErrorCode.ParseError, '响应体为空（期望 JSON）') };
  }
  try {
    return { ok: true, data: JSON.parse(raw) as T };
  } catch {
    // 代理返回 HTML 错误页 / 网关拦截 —— 必须暴露为错误，不能退化成空数据
    return { ok: false, error: fromTransportFailure(ApiErrorCode.ParseError, '响应解析失败：返回内容不是合法 JSON') };
  }
}

/** 无响应体端点（204）的统一契约入口；避免用 `undefined as T` 伪造成功。 */
export async function requestResultVoid(path: string, options?: ApiRequestOptions): Promise<ApiResult<void>> {
  const outcome = await sendRequest(path, options);
  if (outcome.kind !== 'response') return { ok: false, error: transportError(outcome) };
  const { res } = outcome;
  if (!res.ok) return { ok: false, error: fromHttpFailure(res.status, await readErrorBody(res)) };
  return { ok: true, data: undefined };
}

/** JSON POST 写请求的公共选项收敛（只做序列化，不解释响应）。 */
function postJson(body: unknown, options?: ApiRequestOptions): ApiRequestOptions {
  return { method: 'POST', body: JSON.stringify(body), ...options };
}

/** 合并两个 AbortSignal — 优先使用 AbortSignal.any()（现代浏览器/Electron 43+ 原生支持），
 *  回退方案使用显式监听器并在请求结束时确保移除，防止内存泄漏。 */
function mergeSignals(a: AbortSignal, b: AbortSignal): AbortSignal {
  // 现代环境：直接使用标准 API，无泄漏风险
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([a, b]);
  }

  // 回退方案：手动合并，使用符号键避免污染 signal 原型，确保清理时精确匹配
  const combined = new AbortController();
  const onAbort = () => combined.abort();

  // 使用 Symbol 作为私有键，避免与其他代码冲突
  const listenerKey = Symbol('mergedAbortListener');
  const controllerKey = Symbol('mergedAbortController');

  // 存储监听器引用以便后续移除
  (a as any)[listenerKey] = onAbort;
  (a as any)[controllerKey] = combined;
  (b as any)[listenerKey] = onAbort;
  (b as any)[controllerKey] = combined;

  a.addEventListener('abort', onAbort);
  b.addEventListener('abort', onAbort);

  // 返回一个会在任一源 signal abort 时触发的 signal
  return combined.signal;
}

/** 清除 signal 上由 mergeSignals 注册的监听器（请求结束后调用） */
function cleanupMergedSignals(a?: AbortSignal, b?: AbortSignal): void {
  const listenerKey = Symbol('mergedAbortListener');
  const controllerKey = Symbol('mergedAbortController');

  for (const s of [a, b]) {
    if (!s) continue;
    const fn = (s as any)[listenerKey];
    if (typeof fn === 'function') {
      s.removeEventListener('abort', fn);
      // 清理引用，防止重复清理或内存残留
      delete (s as any)[listenerKey];
      delete (s as any)[controllerKey];
    }
  }
}

// API 方法
export const api = {
  // 健康检查
  health: () => request<{ status: string; version: string; timestamp: string }>('/health'),

  // Providers
  getProviders: () => request<any[]>('/providers'),
  getProvider: (id: string) => request<any>(`/providers/${id}`),
  getProviderDetail: (id: string) => request<{ id: string; name: string; type: string; apiKey: string; baseUrl: string | null; models: string[]; capabilities: string[]; isDefault: boolean; createdAt: string; updatedAt: string }>(`/providers/${id}/detail`),
  // P1-28 修复：获取明文 API Key 必须走统一 request client（自动附 Bearer Authorization，
  // 不再手写裸 fetch 仅带 X-Requested-With —— 否则后端敏感写路径的认证可被绕过）
  getProviderApiKey: (id: string) => request<{ apiKey: string }>(`/providers/${id}/apikey`, { method: 'POST', body: JSON.stringify({}) }),
  createProvider: (data: any) => request<any>('/providers', { method: 'POST', body: JSON.stringify(data) }),
  updateProvider: (id: string, data: any) => request<any>(`/providers/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteProvider: (id: string) => request<any>(`/providers/${id}`, { method: 'DELETE' }),
  testProvider: (id: string) => request<any>(`/providers/${id}/test`, { method: 'POST', body: JSON.stringify({}) }),

  // Conversations
  getConversations: () => request<any[]>('/conversations'),
  // 整改计划第 3 章（P0）：轮询支持 AbortController —— 组件卸载/会话切换/重试时取消旧请求
  getConversation: (id: string, signal?: AbortSignal) => request<any>(`/conversations/${id}`, { signal }),
  updateConversation: (id: string, data: { title: string }) => request<any>(`/conversations/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  createConversation: (data: any) => request<any>('/conversations', { method: 'POST', body: JSON.stringify(data) }),
  sendMessage: (id: string, data: any) => request<any>(`/conversations/${id}/messages`, { method: 'POST', body: JSON.stringify(data) }),
  deleteConversation: (id: string) => request<any>(`/conversations/${id}`, { method: 'DELETE' }),

  // 流式发送统一走 api/streamClient.ts（streamConversation / streamOrchestrate / fetchEvents）——判别联合 StreamEvent 协议

  // Projects
  getProjects: () => request<any[]>('/projects'),
  createProject: (data: any) => request<any>('/projects', { method: 'POST', body: JSON.stringify(data) }),
  updateProject: (id: string, data: any) => request<any>(`/projects/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteProject: (id: string) => request<any>(`/projects/${id}`, { method: 'DELETE' }),

  // Media（AI Studio）
  getMedia: () => request<any[]>('/media'),
  generateMedia: (data: {
    type: 'image' | 'video';
    prompt: string;
    negativePrompt?: string;
    model?: string;
    name?: string;
    providerId?: string;
    size?: string;
    num?: number;
    image?: string; // base64 图片，用于图生图/图生视频
    numFrames?: number;
    frameRate?: number;
  }) => request<any>('/media/generate', { method: 'POST', body: JSON.stringify(data), timeout: MEDIA_TIMEOUT_MS }),
  deleteMedia: (id: string) => request<any>(`/media/${id}`, { method: 'DELETE' }),
  batchDeleteMedia: (ids: string[]) => request<any>('/media/batch-delete', { method: 'POST', body: JSON.stringify({ ids }) }),

  // Default Providers per capability
  getDefaultProviders: () => request<Record<string, string>>('/settings/default-providers'),
  setDefaultProviders: (data: Record<string, string>) => request<any>('/settings/default-providers', { method: 'POST', body: JSON.stringify(data) }),

  // Documents
  getDocuments: () => request<any[]>('/documents'),
  generatePPT: (data: any) => request<any>('/documents/ppt', { method: 'POST', body: JSON.stringify(data) }),
  generateDOC: (data: any) => request<any>('/documents/doc', { method: 'POST', body: JSON.stringify(data) }),
  deleteDocument: (id: string) => request<any>(`/documents/${id}`, { method: 'DELETE' }),
  documentDownloadUrl: (id: string) => `${BASE}/documents/${id}/download`,
  previewDocument: (id: string) => request<any>(`/documents/${id}/preview`),

  // Data Layer (JSON persistence)
  getSettings: () => request<any>('/settings'),
  saveSettings: (data: any) => request<any>('/settings', { method: 'POST', body: JSON.stringify(data) }),
  // Wave0-AM: 全量导出/导入走带 Authorization 的 client（DataManage 不再用裸 fetch）
  exportAll: () => request<any>('/export/all'),
  importAll: (data: any) => request<any>('/import/all', { method: 'POST', body: JSON.stringify(data) }),
  // Wave0-AM：approvals list（decideApproval 已在下方 Permissions/审批段定义，避免重名）
  listApprovals: () => request<{ id: string; toolName: string; argsSummary: string }[]>('/approvals'),
  // Sync（写路径带 Authorization；getSyncConfig GET 后端豁免 token）
  getSyncConfig: () => request<any>('/sync/config'),
  saveSyncConfig: (data: any) => request<any>('/sync/config', { method: 'POST', body: JSON.stringify(data) }),
  syncUpload: (data: any) => request<any>('/sync/upload', { method: 'POST', body: JSON.stringify(data) }),
  execProject: (data: any) => request<any>('/projects/exec', { method: 'POST', body: JSON.stringify(data) }),
  testProviderConnection: (data: any) => request<any>('/providers/test', { method: 'POST', body: JSON.stringify(data) }),
  updateDocument: (id: string, data: any) => request<any>(`/documents/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  updateMedia: (id: string, data: any) => request<any>(`/media/${id}`, { method: 'PUT', body: JSON.stringify(data) }),

  // Workspace
  getWorkspace: () => request<any>('/workspace'),

  // Agents（多 Agent 并行与编排）
  getAgents: () => request<any>('/agents'),
  getAgentPrompt: (id: string) => request<{ id: string; name: string; systemPrompt: string }>(`/agents/${id}/prompt`),
  updateAgentPrompt: (id: string, systemPrompt: string) =>
    request<any>(`/agents/${id}/prompt`, { method: 'PUT', body: JSON.stringify({ systemPrompt }) }),
  getAgentConfigs: () => request<any>('/agents/config'),
  updateAgentConfig: (agentId: string, data: { providerId: string; model: string }) =>
    request<any>(`/agents/config/${agentId}`, { method: 'PUT', body: JSON.stringify(data) }),
  sisyphusReply: (data: any) => request<any>('/agents/sisyphus', { method: 'POST', body: JSON.stringify(data) }),

  // Backgrounds（背景轮播持久化）
  getBackgrounds: () => request<any>('/backgrounds'),
  uploadBackgrounds: (images: string[]) => request<any>('/backgrounds/upload', { method: 'POST', body: JSON.stringify({ images }) }),
  setBackgroundInterval: (interval: number) => request<any>('/backgrounds/interval', { method: 'POST', body: JSON.stringify({ interval }) }),
  clearBackgrounds: () => request<any>('/backgrounds/clear', { method: 'POST', body: JSON.stringify({}) }),
  setBackgroundSource: (mode: 'upload' | 'dir', dir?: string) =>
    request<any>('/backgrounds/source', { method: 'POST', body: JSON.stringify({ mode, dir }) }),

  // Toolbox（工具箱）
  getToolboxFormats: () => request<any>('/toolbox/formats'),
  convertFile: (data: any) => request<any>('/toolbox/convert', { method: 'POST', body: JSON.stringify(data) }),
  encodeTool: (data: { op: string; input: string }) =>
    request<any>('/toolbox/encode', { method: 'POST', body: JSON.stringify(data) }),

  // Search（搜索引擎）
  search: (data: { query: string; sources?: string[] }) => request<any>('/search', { method: 'POST', body: JSON.stringify(data) }),
  searchConversations: (query: string, limit?: number) =>
    request<any>('/search/conversations', { method: 'POST', body: JSON.stringify({ query, limit }) }),
  getSearchSources: () => request<any>('/search/sources'),
  getSearchHistory: () => request<any>('/search/history'),
  clearSearchHistory: () => request<any>('/search/history', { method: 'DELETE' }),
  recordSearchHistory: (data: { query: string; sources?: string[]; resultCount?: number }) =>
    request<any>('/search/record', { method: 'POST', body: JSON.stringify(data) }),

  // Export（数据导出）
  exportData: (data: { format: string; data: any[]; filename?: string }) =>
    request<any>('/export', { method: 'POST', body: JSON.stringify(data) }),

  // Permissions（权限系统）
  getPermissions: () => request<{ level: number; label: string }>('/permissions'),
  setPermissions: (level: number) =>
    request<{ level: number; label: string }>('/permissions', { method: 'POST', body: JSON.stringify({ level }) }),

  // ask-user 审批决议（Level 1 敏感工具执行前弹出确认框）
  decideApproval: (id: string, decision: 'approved' | 'rejected') =>
    request<{ success: boolean }>(`/approvals/${id}/decide`, { method: 'POST', body: JSON.stringify({ decision }) }),

  // 取消正在进行的 AI 生成
  cancelConversation: (id: string) =>
    request<{ success: boolean }>(`/conversations/${id}/cancel`, { method: 'POST' }),
  cancelAgentGeneration: (conversationId: string) =>
    request<{ success: boolean }>('/agents/cancel', { method: 'POST', body: JSON.stringify({ conversationId }) }),

  // P0-6 修复：安全设置专用端点（allowedDirs/defaultDir/permissionLevel 不能通过 /api/settings 修改）
  saveSecuritySettings: (data: { allowedDirs?: string[]; defaultDir?: string; permissionLevel?: number }) =>
    request<any>('/settings/security', { method: 'POST', body: JSON.stringify(data) }),

  // MCP（MCP 服务器管理）
  getMcpServers: () => request<any[]>('/mcp/servers'),
  getMcpServer: (id: string) => request<any>(`/mcp/servers/${id}`),
  createMcpServer: (data: any) => request<any>('/mcp/servers', { method: 'POST', body: JSON.stringify(data) }),
  updateMcpServer: (id: string, data: any) => request<any>(`/mcp/servers/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteMcpServer: (id: string) => request<any>(`/mcp/servers/${id}`, { method: 'DELETE' }),
  testMcpServer: (id: string) => request<any>(`/mcp/servers/${id}/test`, { method: 'POST', body: JSON.stringify({}) }),

  // Monitoring（监控）
  getSystemStats: () => request<any>('/monitoring/system'),
  getModelHealth: () => request<any>('/monitoring/models'),
  getAgentStats: () => request<any>('/monitoring/agents'),
  getTokenStats: () => request<any>('/monitoring/tokens'),

  // SelfCheck（AI 自检）
  runSelfCheck: () => request<any>('/selfcheck'),

  // Skills（技能管理）
  getSkills: () => request<any>('/skills'),
  installSkill: (name: string) => request<any>(`/skills/${encodeURIComponent(name)}/install`, { method: 'POST' }),
  deleteSkill: (name: string) => request<any>(`/skills/${encodeURIComponent(name)}`, { method: 'DELETE' }),

  // Memory（AI 记忆系统）
  extractMemory: (data: { content: string; conversationId?: string }) =>
    request<{ extracted: number; memories: any[] }>('/memory/extract', { method: 'POST', body: JSON.stringify(data) }),
  searchMemories: (q: string) => request<any[]>(`/memory/search?q=${encodeURIComponent(q)}`),
  recallMemories: (context: string) => request<any[]>(`/memory/recall?context=${encodeURIComponent(context)}`),
  getMemories: (type?: string) => request<any[]>(type ? `/memory?type=${encodeURIComponent(type)}` : '/memory'),
  deleteMemory: (id: string) => request<any>(`/memory/${id}`, { method: 'DELETE' }),

  // Workflows（可视化工作流）
  getWorkflows: () => request<any[]>('/workflows'),
  getWorkflow: (id: string) => request<any>(`/workflows/${id}`),
  createWorkflow: (data: { name: string; description?: string; nodes?: any[]; edges?: any[]; trigger?: string }) =>
    request<any>('/workflows', { method: 'POST', body: JSON.stringify(data) }),
  updateWorkflow: (id: string, data: { name?: string; description?: string; nodes?: any[]; edges?: any[]; trigger?: string }) =>
    request<any>(`/workflows/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteWorkflow: (id: string) => request<any>(`/workflows/${id}`, { method: 'DELETE' }),
  runWorkflow: (id: string, input?: Record<string, unknown>) =>
    request<any>(`/workflows/${id}/run`, { method: 'POST', body: JSON.stringify({ input }) }),
  getWorkflowRuns: (id: string) => request<any[]>(`/workflows/${id}/runs`),
  aiCreateWorkflow: (data: { description: string; name?: string }) =>
    request<any>('/workflows/ai-create', { method: 'POST', body: JSON.stringify(data) }),

  // Knowledge（知识库后端持久化）
  getWikiPages: () => request<any[]>('/knowledge/wiki'),
  createWikiPage: (data: { title: string; content?: string; category?: string }) =>
    request<any>('/knowledge/wiki', { method: 'POST', body: JSON.stringify(data) }),
  updateWikiPage: (id: string, data: { title?: string; content?: string; category?: string }) =>
    request<any>(`/knowledge/wiki/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteWikiPage: (id: string) => request<any>(`/knowledge/wiki/${id}`, { method: 'DELETE' }),

  // Prompt Templates（提示词模板后端持久化）
  getPromptTemplates: () => request<any[]>('/knowledge/templates'),
  createPromptTemplate: (data: { name: string; content: string }) =>
    request<any>('/knowledge/templates', { method: 'POST', body: JSON.stringify(data) }),
  updatePromptTemplate: (id: string, data: { name?: string; content?: string }) =>
    request<any>(`/knowledge/templates/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deletePromptTemplate: (id: string) => request<any>(`/knowledge/templates/${id}`, { method: 'DELETE' }),

  /**
   * AEX-P1-017 统一契约：以下方法返回 `ApiResult<T>`，**永不 throw**。
   * 调用点必须判别 `ok` —— 空数据（`ok:true, data:[]`）与请求失败（`ok:false`）在类型层分开，
   * 从根上杜绝 `catch → []` 把错误伪装成空列表。收敛范围：Toolbox / Terminal / MCP 导入 /
   * Sync 断开 / 全量导入（原先均为页面内裸 fetch，绕过统一鉴权与超时）。
   */
  result: {
    // ---- Toolbox ----
    getToolsStatus: () => requestResult<ToolsStatus>('/toolbox/tools-status'),
    encode: (data: ToolboxEncodePayload) => requestResult<ToolboxEncodeResult>('/toolbox/encode', postJson(data)),
    utility: (data: { op: string; input: string }) => requestResult<ToolboxUtilityResult>('/toolbox/utility', postJson(data)),
    convert: (data: { files: { name: string; data: string }[]; targetFormat: string; options: Record<string, unknown> }) =>
      requestResult<ToolboxConvertResult>('/toolbox/convert', postJson(data)),
    pdfCompress: (files: { name: string; data: string }[]) =>
      requestResult<ToolboxPdfCompressResult>('/toolbox/pdf-compress', postJson({ files })),
    unlockMusic: (file: { name: string; data: string }) =>
      requestResult<ToolboxUnlockResult>('/toolbox/unlock-music', postJson({ file })),
    pdfOperate: (data: { operation?: string; files: { name: string; data: string }[]; text: string }) =>
      requestResult<ToolboxFileResult>('/toolbox/pdf-operate', postJson(data)),
    pdfRead: (data: { op?: string; file: { name: string; data: string } }) =>
      requestResult<ToolboxReadResult>('/toolbox/pdf-read', postJson(data)),
    pdfToDocx: (file: { name: string; data: string }) =>
      requestResult<ToolboxPdfToDocxResult>('/toolbox/pdf-to-docx', postJson({ file })),
    videoExtract: (data: { files: { name: string; data: string }[]; targetFormat: string }) =>
      requestResult<ToolboxConvertResult>('/toolbox/video-extract', postJson(data)),
    youtubeDownload: (data: { url: string; format: string; quality: number }) =>
      requestResult<ToolboxYoutubeResult>('/toolbox/youtube-download', postJson(data)),

    // ---- Terminal ----
    getTerminalHistory: () => requestResult<TerminalEntry[]>('/terminal/history'),
    executeTerminal: (command: string) =>
      requestResult<TerminalExecuteResult>('/terminal/execute', postJson({ command })),

    // ---- MCP ----
    importMcpServers: () => requestResult<McpImportResult>('/mcp/import', postJson({})),

    // ---- Sync（断开无需读响应体） ----
    disconnectSync: () => requestResultVoid('/sync/disconnect', postJson({})),

    // ---- 数据层全量导入 ----
    importAll: (backendPayload: unknown) => requestResult<ImportAllResult>('/import/all', postJson(backendPayload)),

    // ---- 列表页读接口（原 catch → [] 把失败伪装成空列表的四处，收敛到统一契约） ----
    providers: () => requestResult<ProviderSummary[]>('/providers'),
    defaultProviders: () => requestResult<DefaultProviders>('/settings/default-providers'),
    wikiPages: () => requestResult<WikiPageRow[]>('/knowledge/wiki'),
    memories: (type?: string) =>
      requestResult<MemoryRow[]>(type ? `/memory?type=${encodeURIComponent(type)}` : '/memory'),
    searchMemories: (q: string) =>
      requestResult<MemoryRow[]>(`/memory/search?q=${encodeURIComponent(q)}`),

    // ---- 云同步（/sync/config 属敏感读路径，sendRequest 会自动附 Authorization） ----
    syncConfig: () => requestResult<SyncConfigInfo>('/sync/config'),
  },
};