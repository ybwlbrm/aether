/**
 * T9 纯投影层：AgentEventEnvelope[] → 结构化视图。
 *
 * 硬性约束：
 * - 纯函数，**零 set() / 零 store 依赖**：投影期间绝不写 store，调用方自行从
 *   activityStore 取事件数组后传入（events 由调用方保证已按 run 切分）。
 * - 事件流由 SSE 实时帧与回放帧共用，事件类型判定一律按运行时字符串（v1 的
 *   AgentEventType 闭集尚未覆盖 run.* / attempt.* / retry.*），不做类型断言逃逸。
 * - 状态迁移表用 Record<字面量, 状态> 表达，编译期穷尽，禁止 default 静默吞状态。
 */
import type { AgentEventEnvelope, EventStatus, RunStatus, ToolEventPayload } from '@pacc/shared';
import { toolEventLabel } from '@pacc/shared';
import { classifyTool, deriveSummary, type ToolCallKind } from '../lib/tool-models';

// ── 工具活动 ────────────────────────────────────────────────────────

/** 工具活动行状态（tool.* 五类事件折叠后的终态） */
export type ToolActivityStatus = 'running' | 'completed' | 'error' | 'retry';

/** 单条工具活动（tool.started 与其 completed/error/retry 折叠为一条） */
export interface ToolActivityEntry {
  /** 锚点事件 id（tool.started 的 eventId；无父引用时为该事件自身） */
  eventId: string;
  toolName: string;
  /** 渲染标签（Read/Write/Grep…） */
  label: string;
  /** 机器可读类别 */
  kind: ToolCallKind;
  /** 紧凑参数（文件路径 / 命令摘要）；packed 帧回退为 content */
  target: string;
  status: ToolActivityStatus;
  /** 最后一次更新该条目的事件 id（完成/错误帧），用于回查原始 SSE 帧 */
  parentEventId?: string;
  startedAt: string;
  endedAt?: string;
  /** 是否存在可展开的完整载荷（inputDetail / outputDetail） */
  hasDetail: boolean;
}

/** tool.* 五类事件 → 行状态（键为运行时字符串，覆盖 v1 闭集外的回放帧） */
const TOOL_EVENT_STATUS: Readonly<Record<string, ToolActivityStatus | undefined>> = {
  'tool.started': 'running',
  'tool.progress': 'running',
  'tool.completed': 'completed',
  'tool.error': 'error',
  'tool.retry': 'retry',
};

function isToolActivityEvent(type: string): boolean {
  return TOOL_EVENT_STATUS[type] !== undefined;
}

function hasToolDetail(tool: ToolEventPayload | undefined): boolean {
  return tool !== undefined && ('inputDetail' in tool || 'outputDetail' in tool);
}

/**
 * 投影：工具活动列表。
 * 用 parentEventId 把 tool.started 与其 completed/error/retry 配对折叠为一条；
 * 无 parentEventId 的完成事件独立成条（回放丢帧时的防御性兜底）。
 */
export function projectToolActivity(events: AgentEventEnvelope[], runId?: string): ToolActivityEntry[] {
  const entries: ToolActivityEntry[] = [];
  const byEventId = new Map<string, ToolActivityEntry>();

  for (const ev of events) {
    if (!inRun(ev, runId) || !isToolActivityEvent(ev.eventType)) continue;
    const status = TOOL_EVENT_STATUS[ev.eventType];
    if (status === undefined) continue;
    const tool = ev.tool;
    const toolName = tool?.toolName ?? ev.eventType;

    const paired = ev.parentEventId === undefined ? undefined : byEventId.get(ev.parentEventId);
    if (paired !== undefined) {
      paired.status = status;
      // 进行中（started/progress）没有结束时间；retry/completed/error 才落 endedAt
      paired.endedAt = status === 'running' ? undefined : ev.timestamp;
      paired.parentEventId = ev.eventId;
      if (tool !== undefined) {
        if (tool.toolName !== '') paired.toolName = tool.toolName;
        if (tool.toolInput !== '') paired.target = tool.toolInput;
      }
      if (hasToolDetail(tool)) paired.hasDetail = true;
      continue;
    }

    const entry: ToolActivityEntry = {
      eventId: ev.eventId,
      toolName,
      label: toolEventLabel(toolName),
      kind: classifyTool(toolName),
      target: tool?.toolInput ?? ev.content ?? '',
      status,
      parentEventId: ev.parentEventId,
      startedAt: ev.timestamp,
      hasDetail: hasToolDetail(tool),
    };
    entries.push(entry);
    byEventId.set(ev.eventId, entry);
  }
  return entries;
}

// ── 文件活动 ────────────────────────────────────────────────────────

/** 文件操作语义（仅 6 类内置文件工具，不猜测 MCP/未知工具的 op） */
export type FileOp = 'read' | 'write' | 'edit' | 'delete' | 'mkdir' | 'list';

/** 单条文件活动 */
export interface FileActivityEntry {
  path: string;
  op: FileOp;
  at: string;
  /** 结果是否被裁剪（buildToolPayload 200 字截断或显式 truncated 标记） */
  truncated: boolean;
}

const FILE_OPS: Readonly<Record<string, FileOp | undefined>> = {
  read_file: 'read',
  write_file: 'write',
  edit_file: 'edit',
  delete_file: 'delete',
  create_directory: 'mkdir',
  list_files: 'list',
};

function fileOpOf(toolName: string): FileOp | null {
  // classifyTool 粗筛：仅 read/edit/delete 三类文件工具入列，
  // grep/execute/web 等一律排除（避免把搜索/命令当成文件变更）
  const kind = classifyTool(toolName);
  if (kind !== 'read' && kind !== 'edit' && kind !== 'delete') return null;
  return FILE_OPS[toolName] ?? null;
}

/** 路径提取：优先 inputDetail.path，其次按 classifyTool 的键偏好从 toolInput 解析 */
function toolPathOf(tool: ToolEventPayload): string | undefined {
  const detail = tool.inputDetail;
  if (typeof detail === 'object' && detail !== null && 'path' in detail) {
    const path = detail.path;
    if (typeof path === 'string' && path !== '') return path;
  }
  const summary = deriveSummary(tool.toolName, tool.toolInput);
  return summary === '' ? undefined : summary;
}

function isTruncatedToolResult(tool: ToolEventPayload): boolean {
  if (tool.toolOutput !== undefined && tool.toolOutput.endsWith('…')) return true;
  const detail = tool.outputDetail;
  return typeof detail === 'object' && detail !== null && 'truncated' in detail && detail.truncated === true;
}

/** 投影：文件活动列表（read/write/edit/delete/mkdir/list） */
export function projectFileActivity(events: AgentEventEnvelope[], runId?: string): FileActivityEntry[] {
  const files: FileActivityEntry[] = [];
  for (const ev of events) {
    if (!inRun(ev, runId)) continue;
    const tool = ev.tool;
    if (tool === undefined) continue;
    const op = fileOpOf(tool.toolName);
    if (op === null) continue;
    const path = toolPathOf(tool);
    if (path === undefined) continue;
    files.push({ path, op, at: ev.timestamp, truncated: isTruncatedToolResult(tool) });
  }
  return files;
}

// ── Agent 树 ────────────────────────────────────────────────────────

/** Agent 节点状态 */
export type AgentTreeStatus = 'running' | 'waiting' | 'completed' | 'error' | 'retry' | 'stopped';

/** Agent 树节点（key = agentId） */
export interface AgentTreeNode {
  status: AgentTreeStatus;
  /** spawn 发起方（agent.spawned 的父 Agent）；handoff 不算 spawn，不设置 */
  spawnedBy?: string;
  label: string;
}

/** v1 EventStatus → Agent 树状态（Record 穷尽映射，新增状态编译期报错） */
const EVENT_STATUS_TO_AGENT_STATUS: Record<EventStatus, AgentTreeStatus> = {
  started: 'running',
  running: 'running',
  completed: 'completed',
  error: 'error',
  retry: 'retry',
  cancelled: 'stopped',
  interrupted: 'stopped',
};

function targetAgentIdOf(ev: AgentEventEnvelope): string | undefined {
  const target = ev.metadata?.['targetAgentId'];
  return typeof target === 'string' && target !== '' ? target : undefined;
}

/**
 * 节点 upsert：不存在则创建，存在则改写状态（label 缺省时保留原值）。
 * label 只在首帧或带 content 的帧上更新，避免后续无内容事件把说明冲掉。
 */
function upsertNode(
  tree: Record<string, AgentTreeNode>,
  id: string,
  status: AgentTreeStatus,
  label: string | undefined,
): AgentTreeNode {
  let node = tree[id];
  if (node === undefined) {
    node = { status, label: label ?? id };
    tree[id] = node;
  }
  node.status = status;
  if (label !== undefined) node.label = label;
  return node;
}

/**
 * 投影：Agent 树。
 * agent.spawned 建立父子关系（metadata.targetAgentId 缺失时退化为发起方自身），
 * agent.handoff 只标记目标 Agent；agent.inbox.directive / message / reasoning /
 * output 类事件只携带内容，不改变生命周期状态，显式跳过。
 */
export function projectAgentTree(events: AgentEventEnvelope[], runId?: string): Record<string, AgentTreeNode> {
  const tree: Record<string, AgentTreeNode> = {};
  for (const ev of events) {
    if (!inRun(ev, runId)) continue;
    const id = ev.agentId;

    if (ev.eventType === 'agent.spawned') {
      const childId = targetAgentIdOf(ev) ?? id;
      const child = upsertNode(tree, childId, 'running', ev.content);
      if (child.spawnedBy === undefined) child.spawnedBy = id;
      upsertNode(tree, id, 'running', undefined);
      continue;
    }
    if (ev.eventType === 'agent.handoff') {
      upsertNode(tree, targetAgentIdOf(ev) ?? id, 'running', ev.content);
      continue;
    }
    if (ev.eventType === 'agent.started' || ev.eventType === 'agent.resumed') {
      upsertNode(tree, id, 'running', ev.content);
      continue;
    }
    if (ev.eventType === 'agent.waiting') {
      upsertNode(tree, id, 'waiting', ev.content);
      continue;
    }
    if (ev.eventType === 'agent.status') {
      const status = ev.status === undefined ? 'running' : EVENT_STATUS_TO_AGENT_STATUS[ev.status];
      upsertNode(tree, id, status, ev.content);
      continue;
    }
    if (ev.eventType === 'agent.completed') {
      upsertNode(tree, id, 'completed', ev.content);
      continue;
    }
    if (ev.eventType === 'agent.error' || ev.eventType === 'agent.failed') {
      upsertNode(tree, id, 'error', ev.content);
      continue;
    }
    if (ev.eventType === 'agent.retry') {
      upsertNode(tree, id, 'retry', ev.content);
      continue;
    }
    if (ev.eventType === 'agent.stopped') {
      upsertNode(tree, id, 'stopped', ev.content);
      continue;
    }
  }
  return tree;
}

// ── 重试态 ──────────────────────────────────────────────────────────

/** Run 的重试态（attempt.* + retry.* 折叠） */
export interface RetryState {
  attempt?: number;
  status?: RunStatus;
  delayMs?: number;
}

/** attempt.* / retry.* → Run 状态（attempt/retry 不在 v1 闭集，按运行时字符串匹配） */
const RETRY_EVENT_STATUS: Readonly<Record<string, RunStatus | undefined>> = {
  'attempt.started': 'running',
  'retry.scheduled': 'retry_waiting',
  'retry.started': 'retrying',
  'retry.completed': 'completed',
  'retry.failed': 'failed',
  'retry.exhausted': 'failed',
};

function readNumber(meta: Record<string, unknown> | undefined, key: string): number | undefined {
  const value = meta?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** 投影：重试态；无 attempt/retry 事件时返回 null */
export function projectRetryState(events: AgentEventEnvelope[], runId?: string): RetryState | null {
  let state: RetryState | null = null;
  for (const ev of events) {
    if (!inRun(ev, runId)) continue;
    const type: string = ev.eventType;
    const status = RETRY_EVENT_STATUS[type];
    if (status === undefined) continue;
    if (state === null) state = {};
    const attempt = readNumber(ev.metadata, 'attempt');
    if (attempt !== undefined) state.attempt = attempt;
    const delayMs = readNumber(ev.metadata, 'delayMs');
    if (delayMs !== undefined) state.delayMs = delayMs;
    state.status = status;
  }
  return state;
}

// ── packed-replay 检测 ──────────────────────────────────────────────

/**
 * packed-replay 检测器：判断本 run 的工具载荷是否完整。
 *
 * 后端 readEvents（src/backend/src/modules/runs/stream.ts）对 packed 行只回放
 * `payload: { content }` —— toolName / toolInput / inputDetail / outputDetail 全部
 * 丢失。事件里只要出现一个「只有 content」的 tool 事件，工具活动与文件活动就不可
 * 完整重建，UI 应走降级路径（禁用展开 / 提示需要完整回放）。
 *
 * 没有任何 tool 事件时同样返回 false：无可展开载荷，按不完整处理。
 */
export function hasFullToolPayload(events: AgentEventEnvelope[], runId?: string): boolean {
  let sawToolEvent = false;
  for (const ev of events) {
    if (!inRun(ev, runId) || !isToolActivityEvent(ev.eventType)) continue;
    sawToolEvent = true;
    const tool = ev.tool;
    if (tool === undefined) return false;
    if (!('toolInput' in tool) && !('inputDetail' in tool) && !('outputDetail' in tool)) return false;
  }
  return sawToolEvent;
}

// ── 公共 ────────────────────────────────────────────────────────────

/**
 * runKey 过滤：语义与 activityStore.getRunKey 一致
 * （v2 显式 runId 优先，v1 回退 sessionId:taskId）。runId 省略时不做过滤。
 */
function inRun(ev: AgentEventEnvelope, runId: string | undefined): boolean {
  if (runId === undefined) return true;
  return (ev.runId || `${ev.sessionId}:${ev.taskId}`) === runId;
}
