/**
 * Aether 统一 Agent Event Protocol
 *
 * 把「Chatbot 式 Card 输出」升级为「Event-driven Agent Activity Stream」的数据契约。
 * 设计要点：
 * - 事件信封（envelope）统一携带 eventId/sessionId/taskId/agentId/seq 等关联字段
 * - seq 在会话内单调递增，用于定序与回放去重
 * - eventType 为判别联合（closed union），新增事件必须显式加入
 * - 所有事件共享一个 envelope，前端按 eventType 投影出 Activity Stream / 消息列表 / 任务进度
 */

/** 事件状态生命周期（工具/任务/Agent 共用） */
export type EventStatus =
  | 'started'
  | 'running'
  | 'completed'
  | 'error'
  | 'retry'
  | 'cancelled'
  | 'interrupted';

/** 工具事件负载（紧凑展示 + 可展开详情分离） */
export interface ToolEventPayload {
  /** 工具名：如 'read_file' / 'grep' / 'browser.search' / 'mcp.filesystem.read' */
  toolName: string;
  /** 紧凑展示参数（如文件路径），不铺满 JSON */
  toolInput: string;
  /** 结果摘要（前端控制展示） */
  toolOutput?: string;
  /** 完整参数（可展开查看） */
  inputDetail?: unknown;
  /** 完整结果（可展开查看） */
  outputDetail?: unknown;
  /** 工具错误（tool.error 事件携带） */
  error?: { message: string; code?: string };
}

/** Agent 事件类型全集（判别联合） */
export type AgentEventType =
  // ── 会话生命周期 ──────────────────────────────
  | 'session.started'
  | 'session.closed'

  // ── 任务生命周期（含 plan 计划状态） ────────────
  | 'task.started'
  | 'task.plan'
  | 'task.progress'
  | 'task.ask-confirm'
  | 'task.completed'
  | 'task.cancelled'
  | 'task.failed'

  // ── Agent 生命周期 ────────────────────────────
  | 'agent.started'
  | 'agent.status'
  | 'agent.waiting'
  | 'agent.resumed'
  | 'agent.completed'
  | 'agent.error'
  | 'agent.retry'
  | 'agent.spawned'
  | 'agent.handoff'
  | 'agent.failed'
  // ── inbox 指令（任务运行中 steer/followup 补充指令） ──
  | 'agent.inbox.directive'

  // ── 模型流式消息 ──────────────────────────────
  | 'agent.message.delta'
  | 'agent.message.completed'
  | 'agent.reasoning.delta'

  // ── 最终输出（与过程分离：仅编排汇总阶段发射，前端据此投影最终气泡） ──
  | 'agent.output.delta'
  | 'agent.output.completed'

  // ── 工具生命周期 ──────────────────────────────
  | 'tool.started'
  | 'tool.progress'
  | 'tool.completed'
  | 'tool.error'
  | 'tool.retry'

  // ── 统计 ──────────────────────────────────────
  | 'token';

/** 事件状态集合 */
export const EVENT_STATUSES: readonly EventStatus[] = [
  'started',
  'running',
  'completed',
  'error',
  'retry',
  'cancelled',
  'interrupted',
];

/** Agent 事件类型全集（供 Zod / 校验 / 遍历使用） */
export const AGENT_EVENT_TYPES: readonly AgentEventType[] = [
  'session.started',
  'session.closed',
  'task.started',
  'task.plan',
  'task.progress',
  'task.ask-confirm',
  'task.completed',
  'task.cancelled',
  'task.failed',
  'agent.started',
  'agent.status',
  'agent.waiting',
  'agent.resumed',
  'agent.completed',
  'agent.error',
  'agent.retry',
  'agent.spawned',
  'agent.handoff',
  'agent.failed',
  'agent.inbox.directive',
  'agent.message.delta',
  'agent.message.completed',
  'agent.reasoning.delta',
  'agent.output.delta',
  'agent.output.completed',
  'tool.started',
  'tool.progress',
  'tool.completed',
  'tool.error',
  'tool.retry',
  'token',
];

/** 统一事件信封 */
export interface AgentEventEnvelope {
  /** 全局唯一事件 ID（uuid） */
  eventId: string;
  /** 会话归属（conversation.id） */
  sessionId: string;
  /** 本次运行/任务 ID（AgentEventRun.id；单轮消息场景 = eventId） */
  taskId: string;
  /** 归属 Agent：'main'（普通对话）| 'sisyphus' | 'hephaestus' | ... */
  agentId: string;
  /** Agent 类型分类：'conversation' | 'planner' | 'coder' | 'researcher' | ... */
  agentType: string;
  /** 事件类型（判别联合） */
  eventType: AgentEventType;
  /** ISO8601 时间戳 */
  timestamp: string;
  /** 会话内单调递增序号（定序 + 回放去重键） */
  seq: number;
  /** 状态生命周期 */
  status?: EventStatus;
  /** 文本内容（reasoning / 消息增量 / 状态描述 / 错误说明） */
  content?: string;
  /** 工具事件负载 */
  tool?: ToolEventPayload;
  /** 事件关联（tool.completed 引用 tool.started 的 eventId） */
  parentEventId?: string;
  /** 扩展元数据（token 用量、耗时等） */
  metadata?: Record<string, unknown>;
  /** 任务结束原因（task.completed 携带：stop/tool_calls/max-tokens/error/aborted/max_turns） */
  endReason?: 'stop' | 'tool_calls' | 'max-tokens' | 'error' | 'aborted' | 'max_turns' | 'completed';
}

/** 活动流渲染投影用的紧凑表示（前端可直接渲染的一条 Activity） */
export interface ActivityItem {
  eventId: string;
  seq: number;
  eventType: AgentEventType;
  status?: EventStatus;
  agentId: string;
  agentType: string;
  timestamp: string;
  /** 渲染标签：'Read' | 'Edit' | 'Think' | 'Tool' | ... */
  label?: string;
  /** 渲染目标（文件路径 / 工具名 / 状态描述） */
  target?: string;
  /** 两行展示时的第二行（工具参数摘要等） */
  detail?: string;
  /** 是否可展开查看完整载荷 */
  expandable?: boolean;
  /** 完整载荷（展开时读取） */
  fullPayload?: unknown;
  /** 关联的事件（用于折叠 pending → final） */
  parentEventId?: string;
}

/**
 * 构造工具事件负载的便捷函数：把调用参数转成紧凑展示字符串。
 * @param toolName 工具名
 * @param args 调用参数对象
 * @param output 完整结果文本（可选）
 */
export function buildToolPayload(
  toolName: string,
  args: Record<string, unknown>,
  output?: string,
): ToolEventPayload {
  // 优先提取常用的人类可读字段作为紧凑展示；无法识别时用请求键值对概览
  const humanReadable = ['path', 'filePath', 'file', 'pattern', 'url', 'query', 'command', 'workdir', 'name']
    .map((k) => (args[k] !== undefined && args[k] !== null ? String(args[k]) : null))
    .find((v): v is string => v !== null);
  const toolInput = humanReadable ?? Object.entries(args)
    .slice(0, 4)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(', ');
  const payload: ToolEventPayload = {
    toolName,
    toolInput: toolInput || '(无参数)',
    inputDetail: args,
  };
  if (output !== undefined) {
    payload.toolOutput = output.length > 200 ? `${output.slice(0, 200)}…` : output;
    payload.outputDetail = output;
  }
  return payload;
}

/** 内部工具 -> 渲染标签的精确映射（优先匹配，避免与 MCP 下划线格式混淆） */
const INTERNAL_TOOL_LABELS: Record<string, string> = {
  read_file: 'Read',
  write_file: 'Write',
  list_files: 'List',
  create_directory: 'Mkdir',
  delete_file: 'Delete',
  edit_file: 'Edit',
  execute_command: 'Shell',
  grep: 'Grep',
  glob: 'Glob',
  web_search: 'Search',
  web_fetch: 'Fetch',
  'browser.search': 'Search',
  lsp_diagnostics: 'LSP',
  run_tests: 'Test',
  code_review: 'Review',
};

/**
 * 把工具名映射为渲染标签（Read/Write/Edit/Grep/Browser/MCP…）
 */
export function toolEventLabel(toolName: string): string {
  const exact = INTERNAL_TOOL_LABELS[toolName];
  if (exact) return exact;
  // MCP 工具名格式一般为 {serverName}_{toolName}（含下划线），优先识别
  if (toolName.includes('_')) return 'MCP';
  if (toolName.includes('read')) return 'Read';
  if (toolName.includes('write')) return 'Write';
  if (toolName.includes('edit')) return 'Edit';
  if (toolName.includes('list')) return 'List';
  if (toolName.includes('grep')) return 'Grep';
  if (toolName.includes('glob')) return 'Glob';
  if (toolName.includes('browser') || toolName.includes('web') || toolName.includes('search')) return 'Search';
  if (toolName.includes('test')) return 'Test';
  if (toolName.includes('lsp')) return 'LSP';
  if (toolName.includes('mcp')) return 'MCP';
  if (toolName.includes('command') || toolName.includes('exec')) return 'Shell';
  return 'Tool';
}