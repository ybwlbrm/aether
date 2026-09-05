import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core';

/** AI Provider 配置表 */
export const providers = sqliteTable('providers', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  type: text('type', { enum: ['openai', 'anthropic', 'google', 'deepseek', 'openrouter', 'custom'] }).notNull(),
  apiKey: text('api_key').notNull(), // AES-256-GCM encrypted
  baseUrl: text('base_url'),
  models: text('models').notNull(), // JSON array
  capabilities: text('capabilities').notNull().default('["text"]'), // JSON array
  isDefault: integer('is_default', { mode: 'boolean' }).default(false),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/** 对话/线程表 */
export const conversations = sqliteTable('conversations', {
  id: text('id').primaryKey(),
  title: text('title').notNull().default('新对话'),
  providerId: text('provider_id').notNull().references(() => providers.id),
  model: text('model').notNull(),
  generationStatus: text('generation_status', { enum: ['idle', 'generating', 'interrupted'] }).default('idle'),
  generationState: text('generation_state'), // JSON: stores orchestration state for session persistence
  tokenTotal: integer('token_total').notNull().default(0), // PF-01: 累计 token 用量，避免 N+1 全表扫描
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/** 消息表 */
export const messages = sqliteTable('messages', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').notNull().references(() => conversations.id),
  role: text('role', { enum: ['user', 'assistant', 'system', 'tool'] }).notNull(),
  content: text('content').notNull(),
  toolCalls: text('tool_calls'), // JSON
  toolResults: text('tool_results'), // JSON
  /** 推理内容（thinking 模式截获的 reasoning_content），多轮对话防"砖化"需要回传 */
  reasoningContent: text('reasoning_content'), // JSON string
  createdAt: text('created_at').notNull(),
});

/** 项目表 */
export const projects = sqliteTable('projects', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').default(''),
  cover: text('cover'),
  screenshots: text('screenshots').default('[]'), // JSON array
  techStack: text('tech_stack').default('[]'), // JSON array
  links: text('links').default('[]'), // JSON array
  github: text('github'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/** 版本表 */
export const versions = sqliteTable('versions', {
  id: text('id').primaryKey(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  version: integer('version').notNull(),
  snapshot: text('snapshot').notNull(), // JSON
  message: text('message').default(''),
  createdAt: text('created_at').notNull(),
});

/** 记忆表 — P2-7: 此表当前未使用（记忆实际存储在 JSON 文件 memory.json 中），保留供未来迁移使用 */
export const memories = sqliteTable('memories', {
  id: text('id').primaryKey(),
  type: text('type', { enum: ['short_term', 'project', 'long_term'] }).notNull(),
  key: text('key').notNull(),
  content: text('content').notNull(),
  tags: text('tags').default('[]'), // JSON array
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/** 媒体资产表 */
export const mediaAssets = sqliteTable('media_assets', {
  id: text('id').primaryKey(),
  type: text('type', { enum: ['image', 'video', 'audio'] }).notNull(),
  name: text('name').notNull(),
  path: text('path').notNull(),
  mimeType: text('mime_type').notNull(),
  size: integer('size').notNull(),
  metadata: text('metadata').default('{}'), // JSON
  createdAt: text('created_at').notNull(),
});

/** 文档表 */
export const documents = sqliteTable('documents', {
  id: text('id').primaryKey(),
  type: text('type', { enum: ['ppt', 'doc'] }).notNull(),
  name: text('name').notNull(),
  path: text('path'),
  status: text('status', { enum: ['draft', 'generating', 'completed', 'failed'] }).default('draft'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/** Agent 模型配置表 — 每个 Agent 可选的 provider + model */
export const agentConfigs = sqliteTable('agent_configs', {
  id: text('id').primaryKey(),
  agentId: text('agent_id').notNull().unique(),
  providerId: text('provider_id').notNull(),
  model: text('model').notNull(),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/** 搜索历史表 — 记录每次搜索查询 */
export const searchHistory = sqliteTable('search_history', {
  id: text('id').primaryKey(),
  query: text('query').notNull(),
  sources: text('sources').notNull().default('["duckduckgo"]'), // JSON array
  resultCount: integer('result_count').default(0),
  createdAt: text('created_at').notNull(),
});

/** 知识库页面表 — 支持后端持久化 Wiki */
export const wikiPages = sqliteTable('wiki_pages', {
  id: text('id').primaryKey(),
  title: text('title').notNull(),
  content: text('content').notNull().default(''),
  category: text('category').notNull().default('通用'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/** 提示词模板表 */
export const promptTemplates = sqliteTable('prompt_templates', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  content: text('content').notNull(),
  createdAt: text('created_at').notNull(),
});

/** MCP 服务器配置表 */
export const mcpServers = sqliteTable('mcp_servers', {
  id: text('id').primaryKey(),
  name: text('name').notNull().unique(),
  type: text('type', { enum: ['local', 'remote'] }).notNull().default('local'),
  command: text('command'), // JSON array for local type
  cwd: text('cwd'),
  environment: text('environment'), // JSON object
  url: text('url'), // for remote type
  enabled: integer('enabled', { mode: 'boolean' }).notNull().default(true),
  timeout: integer('timeout').default(5000),
  headers: text('headers'), // JSON object for remote type
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/** 工作流定义表 — 可视化工作流编辑器（节点 + 边以 JSON 存储） */
export const workflows = sqliteTable('workflows', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  description: text('description').default(''),
  nodes: text('nodes').notNull().default('[]'), // JSON array of WorkflowNode
  edges: text('edges').notNull().default('[]'), // JSON array of WorkflowEdge
  trigger: text('trigger', { enum: ['manual', 'schedule', 'webhook'] }).notNull().default('manual'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

/** 工作流运行记录表 — 每次执行的状态与结果 */
export const workflowRuns = sqliteTable('workflow_runs', {
  id: text('id').primaryKey(),
  workflowId: text('workflow_id').notNull().references(() => workflows.id),
  status: text('status', { enum: ['pending', 'running', 'completed', 'failed'] }).notNull().default('pending'),
  currentNodeId: text('current_node_id'),
  results: text('results').default('{}'), // JSON object: nodeId -> output
  error: text('error'),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at'),
});

/**
 * Agent Activity Event 表 — Event-driven Activity Stream 的事件日志（append-only）
 * 设计对齐 DeepSeek Harness 的 event-sourced sessions：事件是唯一事实源，
 * 前端 Activity Stream / 任务进度 / 消息列表均为事件投影。
 * seq 在会话内单调递增，作为定序与回放去重键。
 */
export const activityEvents = sqliteTable('activity_events', {
  id: text('id').primaryKey(), // eventId (uuid)
  conversationId: text('conversation_id').notNull().references(() => conversations.id),
  taskId: text('task_id').notNull(), // 本次运行/任务 id
  agentId: text('agent_id').notNull().default('main'),
  agentType: text('agent_type').notNull().default('conversation'),
  eventType: text('event_type').notNull(),
  seq: integer('seq').notNull(),
  status: text('status'),
  content: text('content'),
  tool: text('tool'), // JSON ToolEventPayload
  parentEventId: text('parent_event_id'),
  metadata: text('metadata'), // JSON
  createdAt: text('created_at').notNull(), // ISO8601
});

// ──────────────────────────────────────────────────────────────
// Aether 2.0 — Run / Task / Event Runtime（Phase 2/3）
// ──────────────────────────────────────────────────────────────

/**
 * Run 表 — 一次完整 AI 运行的根实体（对话消息 / 编排 / 工作流 / 后台任务统一入口）
 * 状态机：created → running ⇄ waiting → completed | failed | cancelled | interrupted
 */
export const runs = sqliteTable('runs', {
  id: text('id').primaryKey(),
  conversationId: text('conversation_id').references(() => conversations.id),
  status: text('status', {
    enum: ['created', 'running', 'waiting', 'completed', 'failed', 'cancelled', 'interrupted'],
  }).notNull().default('created'),
  /** 运行模式：normal（单 Agent 直答）| super（多 Agent 编排）| workflow | background */
  mode: text('mode', { enum: ['normal', 'super', 'workflow', 'background'] }).notNull().default('normal'),
  rootAgentId: text('root_agent_id'),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  endReason: text('end_reason'),
  inputTokens: integer('input_tokens').notNull().default(0),
  outputTokens: integer('output_tokens').notNull().default(0),
  totalTokens: integer('total_tokens').notNull().default(0),
  error: text('error'),
  metadata: text('metadata'), // JSON
  createdAt: text('created_at').notNull(),
});

/**
 * Task 表 — Run 下的执行单元（支持父子层级：Sisyphus spawn 子 Agent）
 */
export const tasks = sqliteTable('tasks', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull().references(() => runs.id),
  parentTaskId: text('parent_task_id'),
  agentId: text('agent_id').notNull().default('main'),
  agentType: text('agent_type').notNull().default('conversation'),
  status: text('status', {
    enum: ['pending', 'running', 'waiting', 'completed', 'failed', 'cancelled'],
  }).notNull().default('pending'),
  input: text('input'), // JSON
  output: text('output'), // JSON
  error: text('error'),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  metadata: text('metadata'), // JSON
  createdAt: text('created_at').notNull(),
});

/**
 * Events 表 — Aether 2.0 Event Store（事件唯一事实源）
 * 与旧 activity_events 并存：新 Runtime 写此表，旧路径经 Adapter 桥接。
 * 关键约束：UNIQUE(run_id, seq) — run 级序号分配器的并发安全保证。
 * payload 为完整判别联合事件（AgentEvent v2）的 JSON 序列化。
 */
export const events = sqliteTable('events', {
  id: text('id').primaryKey(), // eventId (uuid)
  runId: text('run_id').notNull().references(() => runs.id),
  seq: integer('seq').notNull(),
  eventType: text('event_type').notNull(),
  /** 协议版本（当前 = 1），未来升级时用于解码分发 */
  eventVersion: integer('event_version').notNull().default(1),
  payload: text('payload').notNull(), // JSON: 完整 AgentEvent v2
  /** 打包事件（chunk packing）时携带原始子事件数组 */
  packed: text('packed'), // JSON: 子事件数组（packed row）或 null
  metadata: text('metadata'), // JSON
  createdAt: text('created_at').notNull(), // ISO8601
});