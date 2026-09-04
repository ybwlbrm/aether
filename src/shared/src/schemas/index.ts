import { z } from 'zod';

/** Provider 类型枚举 */
export const ProviderTypeSchema = z.enum([
  'openai', 'anthropic', 'google', 'deepseek', 'openrouter', 'custom'
]);

/** Provider 能力类型枚举 */
export const ProviderCapabilitySchema = z.enum(['text', 'image', 'video', 'audio']);

/** Provider 配置 schema */
export const ProviderConfigSchema = z.object({
  id: z.string(),
  name: z.string().min(1, '名称不能为空'),
  type: ProviderTypeSchema,
  apiKey: z.string().min(1, 'API Key 不能为空'),
  // trim 首尾空格，空字符串归一为 undefined（SHARED-02：避免下游把 '' 当有效 URL 处理）
  baseUrl: z.union([z.string().trim().url('Base URL 格式不正确'), z.literal('')]).optional().transform(v => (v === '' ? undefined : v)),
  models: z.array(z.string()).min(1, '至少需要一个模型'),
  capabilities: z.array(ProviderCapabilitySchema).default(['text']),
  isDefault: z.boolean().default(false),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** 创建 Provider 请求 */
export const CreateProviderSchema = ProviderConfigSchema.omit({
  id: true, createdAt: true, updatedAt: true,
});

/** 更新 Provider 请求 */
export const UpdateProviderSchema = CreateProviderSchema.partial();

/** 对话 schema */
export const ConversationSchema = z.object({
  id: z.string(),
  title: z.string(),
  providerId: z.string(),
  model: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** 消息 schema */
export const MessageSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  role: z.enum(['user', 'assistant', 'system', 'tool']),
  content: z.string(),
  toolCalls: z.array(z.object({
    id: z.string(),
    name: z.string(),
    arguments: z.record(z.unknown()),
  })).optional(),
  toolResults: z.array(z.object({
    toolCallId: z.string(),
    output: z.string(),
  })).optional(),
  createdAt: z.string(),
});

/** 发送消息请求 (P1-17: content 加 maxLength 防超长输入) */
export const SendMessageSchema = z.object({
  conversationId: z.string().optional(),
  content: z.string().max(10000000, '消息过长').default(''),
  images: z.array(z.string()).max(10).optional(),
  files: z.array(z.object({ name: z.string(), dataUrl: z.string() })).max(10).optional(),
  providerId: z.string().optional(),
  model: z.string().optional(),
  deepThinking: z.boolean().optional(),
  reasoningEffort: z.enum(['low', 'medium', 'high']).optional(),
  webSearch: z.boolean().optional(),
  loop: z.boolean().optional(),
});

/** 项目 schema */
export const ProjectSchema = z.object({
  id: z.string(),
  name: z.string().min(1, '项目名称不能为空'),
  description: z.string().default(''),
  cover: z.string().optional(),
  screenshots: z.array(z.string()).default([]),
  techStack: z.array(z.string()).default([]),
  links: z.array(z.object({ label: z.string(), url: z.string() })).default([]),
  github: z.string().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** 创建项目请求 */
export const CreateProjectSchema = ProjectSchema.omit({
  id: true, createdAt: true, updatedAt: true,
});

/** 版本 schema */
export const VersionSchema = z.object({
  id: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  version: z.number().int().positive(),
  snapshot: z.record(z.unknown()),
  message: z.string(),
  createdAt: z.string(),
});

/** 工作流定义 schema */
export const WorkflowDefSchema = z.object({
  id: z.string(),
  name: z.string().min(1),
  description: z.string().default(''),
  nodes: z.array(z.object({
    id: z.string(),
    type: z.enum(['tool', 'agent', 'media', 'document', 'condition']),
    label: z.string(),
    config: z.record(z.unknown()),
  })),
  edges: z.array(z.object({
    id: z.string(),
    source: z.string(),
    target: z.string(),
  })),
  trigger: z.enum(['manual', 'schedule', 'webhook']).default('manual'),
  createdAt: z.string(),
  updatedAt: z.string(),
});

/** 工具定义 schema */
export const ToolDefinitionSchema = z.object({
  name: z.string(),
  description: z.string(),
  inputSchema: z.record(z.unknown()),
  enabled: z.boolean().default(true),
});

/** 配置 schema */
export const AppConfigSchema = z.object({
  port: z.number().default(3000),
  host: z.string().default('127.0.0.1'),
  dataDir: z.string().default('./data'),
  allowedDirs: z.array(z.string()).default(['./data', './workspace']),
  encryptionKey: z.string().optional(),
  allowedOrigins: z.array(z.string().url()).default([
    'http://127.0.0.1:3000',
    'http://localhost:3000',
    'http://127.0.0.1:5173',
    'http://localhost:5173',
  ]),
  enableSwagger: z.boolean().default(false),
});

export type AppConfig = z.infer<typeof AppConfigSchema>;