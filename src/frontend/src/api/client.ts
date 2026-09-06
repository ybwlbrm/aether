const BASE = '/api';
// P1-5: 默认请求超时 30s（SSE 流式端点除外）
const DEFAULT_TIMEOUT_MS = 30000;
// P2: AI 媒体生成超时 300s（图片/视频 AI 生成+轮询最长 5 分钟）
const MEDIA_TIMEOUT_MS = 300000;

// 本地认证 token（启动时从 /api/auth/token 获取，仅内存）
let authToken: string | null = null;

/** 初始化认证 token（应用启动时调用一次） */
export async function initAuthToken(): Promise<void> {
  try {
    const res = await fetch(`${BASE}/auth/token`, {
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });
    if (res.ok) {
      const data = await res.json();
      authToken = data.token ?? null;
    }
  } catch {
    // 静默失败：token 获取失败不阻断应用，敏感端点会返回 401 提示重试
  }
}

/** 获取当前认证 token（供调试/测试用） */
export function getAuthToken(): string | null {
  return authToken;
}

async function request<T>(path: string, options?: RequestInit & { timeout?: number }): Promise<T> {
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
  // 敏感端点需要 Authorization header（终端执行、安全设置、provider key、导入导出等）
  // Wave0-AM: 与后端 Auth Matrix 对齐（permissions/approvals/sync 为新增敏感写路径）
  const sensitivePaths = [
    '/terminal/execute',
    '/settings/security',
    '/providers/',
    '/import/all',
    '/export/all',
    '/permissions/',
    '/approvals/',
    '/sync/config',
    '/sync/upload',
  ];
  const needsAuth = sensitivePaths.some(p =>
    path === p || (p.endsWith('/') && path.startsWith(p))
  );
  if (needsAuth && authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  try {
    const res = await fetch(`${BASE}${path}`, {
      ...options,
      headers,
      signal,
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: { message: '网络错误' } }));
      throw new Error(err.error?.message || `请求失败: ${res.status}`);
    }
    return res.json();
  } catch (e: unknown) {
    if (e instanceof Error && e.name === 'AbortError') {
      // P1-2 修复：区分主动取消（调用方 signal）与超时，避免误导性文案
      if (options?.signal?.aborted) throw e; // 调用方主动取消 → 原样抛出（组件卸载/用户停止）
      if (controller.signal.aborted || timedOut) throw new Error('请求超时，请检查网络连接');
      throw e;
    }
    throw e;
  } finally {
    clearTimeout(timeout);
    // P0 修复：请求结束移除 mergeSignals 注册的监听器，防内存泄漏
    if (options?.signal) cleanupMergedSignals(options.signal, controller.signal);
  }
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
  createProvider: (data: any) => request<any>('/providers', { method: 'POST', body: JSON.stringify(data) }),
  updateProvider: (id: string, data: any) => request<any>(`/providers/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
  deleteProvider: (id: string) => request<any>(`/providers/${id}`, { method: 'DELETE' }),
  testProvider: (id: string) => request<any>(`/providers/${id}/test`, { method: 'POST', body: JSON.stringify({}) }),

  // Conversations
  getConversations: () => request<any[]>('/conversations'),
  getConversation: (id: string) => request<any>(`/conversations/${id}`),
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
};