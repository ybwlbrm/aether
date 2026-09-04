/** AI Provider 类型 */
export type ProviderType = 'openai' | 'anthropic' | 'google' | 'deepseek' | 'openrouter' | 'custom';

/** AI Provider 能力类型 */
export type ProviderCapability = 'text' | 'image' | 'video' | 'audio';

/** AI Provider 配置 */
export interface ProviderConfig {
  id: string;
  name: string;
  type: ProviderType;
  apiKey: string;
  baseUrl?: string;
  models: string[];
  capabilities: ProviderCapability[];
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 对话/线程 */
export interface Conversation {
  id: string;
  title: string;
  providerId: string;
  model: string;
  createdAt: string;
  updatedAt: string;
}

/** 消息 */
export interface Message {
  id: string;
  conversationId: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCalls?: ToolCall[];
  toolResults?: ToolResult[];
  createdAt: string;
}

/** 工具调用 */
export interface ToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

/** 工具结果 */
export interface ToolResult {
  toolCallId: string;
  output: string;
}

/** Agent 工具定义（参考 DeepSeek Harness ToolDefinition） */
export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  enabled: boolean;
  /** 是否可并发执行（false = exclusive，同一时间只允许一个此类工具执行） */
  isConcurrencySafe?: boolean;
  /** 超时时间（毫秒） */
  timeoutMs?: number;
  /** 工具类别（用于 UI 分类展示） */
  category?: 'file' | 'search' | 'command' | 'code' | 'lsp' | 'mcp' | 'other';
  /** 渲染意图（参考 DeepSeek presentCall/presentResult） */
  renderIntent?: 'generic' | 'terminal' | 'diff' | 'search' | 'read' | 'web';
}

/** 项目 */
export interface Project {
  id: string;
  name: string;
  description: string;
  cover?: string;
  screenshots: string[];
  techStack: string[];
  links: { label: string; url: string }[];
  github?: string;
  createdAt: string;
  updatedAt: string;
}

/** 版本快照 */
export interface Version {
  id: string;
  entityType: string;
  entityId: string;
  version: number;
  snapshot: Record<string, unknown>;
  message: string;
  createdAt: string;
}

/** 工作流定义 */
export interface WorkflowDef {
  id: string;
  name: string;
  description: string;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  trigger: 'manual' | 'schedule' | 'webhook';
  createdAt: string;
  updatedAt: string;
}

/** 工作流节点 */
export interface WorkflowNode {
  id: string;
  type: 'tool' | 'agent' | 'media' | 'document' | 'condition';
  label: string;
  config: Record<string, unknown>;
}

/** 工作流边 */
export interface WorkflowEdge {
  id: string;
  source: string;
  target: string;
}

/** 工作流运行 */
export interface WorkflowRun {
  id: string;
  workflowId: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  currentNodeId?: string;
  results: Record<string, unknown>;
  error?: string;
  startedAt: string;
  completedAt?: string;
}

/** 记忆条目 */
export interface MemoryEntry {
  id: string;
  type: 'short_term' | 'project' | 'long_term';
  key: string;
  content: string;
  tags: string[];
  createdAt: string;
  updatedAt: string;
}

/** 媒体资产 */
export interface MediaAsset {
  id: string;
  type: 'image' | 'video' | 'audio';
  name: string;
  path: string;
  mimeType: string;
  size: number;
  metadata: Record<string, unknown>;
  createdAt: string;
}

/** 文档 */
export interface Document {
  id: string;
  type: 'ppt' | 'doc';
  name: string;
  path: string;
  status: 'draft' | 'generating' | 'completed' | 'failed';
  createdAt: string;
  updatedAt: string;
}