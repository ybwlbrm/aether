/**
 * Aether 2.0 — v2 AgentEvent Protocol
 *
 * Strict discriminated union with 37 event types, versioned BaseEvent,
 * and explicit payload fields per event category.
 */

import type { ToolEventPayload } from '../agent-event.js';

/** Base event fields shared by all v2 events */
export interface BaseEvent {
  /** 全局唯一事件 ID（uuid） */
  eventId: string;
  /** 会话归属（conversation.id） */
  sessionId: string;
  /** 运行 ID（AgentEventRun.id） */
  runId: string;
  /** 任务 ID（可选，任务级事件携带） */
  taskId?: string;
  /** 归属 Agent ID（可选，Agent 级事件携带） */
  agentId?: string;
  /** 关联父事件 ID（用于工具完成引用工具开始等） */
  parentEventId?: string;
  /** ISO8601 时间戳 */
  timestamp: string;
  /** 会话内单调递增序号（定序 + 回放去重键） */
  seq: number;
  /** 事件类型判别字段（dot-notation literal） */
  type: string;
  /** 协议版本（当前为 2） */
  version: number;
  /** 扩展元数据 */
  metadata?: Record<string, unknown>;
}

/** 运行结束原因 */
export type RunEndReason =
  | 'stop'
  | 'tool_calls'
  | 'max-tokens'
  | 'error'
  | 'aborted'
  | 'max_turns'
  | 'completed';

/** 任务结束原因 */
export type TaskEndReason =
  | 'stop'
  | 'tool_calls'
  | 'max-tokens'
  | 'error'
  | 'aborted'
  | 'max_turns'
  | 'completed';

/** Agent 状态 */
export type AgentStatusValue =
  | 'idle'
  | 'running'
  | 'waiting'
  | 'paused'
  | 'completed'
  | 'error'
  | 'retry';

/** 工具状态 */
export type ToolStatusValue =
  | 'started'
  | 'running'
  | 'completed'
  | 'error'
  | 'retry'
  | 'cancelled';

/** 运行级事件载荷 */
export interface RunEventPayload {
  /** 结束原因（完成/失败/取消/中断时） */
  endReason?: RunEndReason;
  /** 错误信息（失败时） */
  error?: { message: string; code?: string };
  /** Token 用量（完成时） */
  tokenUsage?: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
}

/** 任务级事件载荷 */
export interface TaskEventPayload {
  /** 任务状态 */
  status?: 'started' | 'running' | 'completed' | 'error' | 'cancelled' | 'interrupted';
  /** 文本内容（计划/进度/确认提示/错误说明） */
  content?: string;
  /** 结束原因（完成/取消/失败时） */
  endReason?: TaskEndReason;
}

/** Agent 级事件载荷 */
export interface AgentEventPayload {
  /** Agent 状态 */
  status?: AgentStatusValue;
  /** 文本内容（状态描述/错误说明/消息增量） */
  content?: string;
  /** 切换/交接目标 Agent ID（handoff 时） */
  targetAgentId?: string;
  /** 指令内容（inbox.directive 时） */
  directive?: string;
}

/** 消息增量事件载荷 */
export interface MessageDeltaPayload {
  /** 增量文本内容 */
  content: string;
  /** 是否为最后一片 */
  isFinal?: boolean;
}

/** 推理增量事件载荷 */
export interface ReasoningDeltaPayload {
  /** 推理文本增量 */
  content: string;
  /** 是否为最后一片 */
  isFinal?: boolean;
}

/** 输出增量事件载荷 */
export interface OutputDeltaPayload {
  /** 输出文本增量 */
  content: string;
  /** 是否为最后一片 */
  isFinal?: boolean;
}

/** 工具事件载荷（复用 v1 的 ToolEventPayload 并扩展状态） */
export interface ToolEventPayloadV2 extends ToolEventPayload {
  /** 工具执行状态 */
  status?: ToolStatusValue;
}

/** Token 用量事件载荷 */
export interface TokenUsagePayload {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  /** 模型名称（可选） */
  model?: string;
}

/** 37 个具体事件类型接口 */

// ── Run 生命周期 (8) ──────────────────────────────────────────────
export interface RunCreatedEvent extends BaseEvent {
  type: 'run.created';
  payload: RunEventPayload;
}

export interface RunStartedEvent extends BaseEvent {
  type: 'run.started';
  payload: RunEventPayload;
}

export interface RunPausedEvent extends BaseEvent {
  type: 'run.paused';
  payload: RunEventPayload;
}

export interface RunResumedEvent extends BaseEvent {
  type: 'run.resumed';
  payload: RunEventPayload;
}

export interface RunCompletedEvent extends BaseEvent {
  type: 'run.completed';
  payload: RunEventPayload & { endReason: RunEndReason; tokenUsage: { inputTokens: number; outputTokens: number; totalTokens: number } };
}

export interface RunFailedEvent extends BaseEvent {
  type: 'run.failed';
  payload: RunEventPayload & { endReason: RunEndReason; error: NonNullable<RunEventPayload['error']> };
}

export interface RunCancelledEvent extends BaseEvent {
  type: 'run.cancelled';
  payload: RunEventPayload & { endReason: RunEndReason };
}

export interface RunInterruptedEvent extends BaseEvent {
  type: 'run.interrupted';
  payload: RunEventPayload & { endReason: RunEndReason };
}

// ── Task 生命周期 (7) ─────────────────────────────────────────────
export interface TaskStartedEvent extends BaseEvent {
  type: 'task.started';
  payload: TaskEventPayload & { status: 'started' };
}

export interface TaskPlanEvent extends BaseEvent {
  type: 'task.plan';
  payload: TaskEventPayload & { content: string };
}

export interface TaskProgressEvent extends BaseEvent {
  type: 'task.progress';
  payload: TaskEventPayload & { content: string };
}

export interface TaskAskConfirmEvent extends BaseEvent {
  type: 'task.ask-confirm';
  payload: TaskEventPayload & { content: string };
}

export interface TaskCompletedEvent extends BaseEvent {
  type: 'task.completed';
  payload: TaskEventPayload & { status: 'completed'; endReason: TaskEndReason };
}

export interface TaskCancelledEvent extends BaseEvent {
  type: 'task.cancelled';
  payload: TaskEventPayload & { status: 'cancelled'; endReason: TaskEndReason };
}

export interface TaskFailedEvent extends BaseEvent {
  type: 'task.failed';
  payload: TaskEventPayload & { status: 'error'; endReason: TaskEndReason; error: { message: string; code?: string } };
}

// ── Agent 生命周期 (11) ───────────────────────────────────────────
export interface AgentStartedEvent extends BaseEvent {
  type: 'agent.started';
  payload: AgentEventPayload & { status: 'running' };
}

export interface AgentStatusEvent extends BaseEvent {
  type: 'agent.status';
  payload: AgentEventPayload & { status: AgentStatusValue };
}

export interface AgentWaitingEvent extends BaseEvent {
  type: 'agent.waiting';
  payload: AgentEventPayload & { status: 'waiting'; content: string };
}

export interface AgentResumedEvent extends BaseEvent {
  type: 'agent.resumed';
  payload: AgentEventPayload & { status: 'running' };
}

export interface AgentCompletedEvent extends BaseEvent {
  type: 'agent.completed';
  payload: AgentEventPayload & { status: 'completed' };
}

export interface AgentErrorEvent extends BaseEvent {
  type: 'agent.error';
  payload: AgentEventPayload & { status: 'error'; content: string; error: { message: string; code?: string } };
}

export interface AgentRetryEvent extends BaseEvent {
  type: 'agent.retry';
  payload: AgentEventPayload & { status: 'retry'; content: string };
}

export interface AgentSpawnedEvent extends BaseEvent {
  type: 'agent.spawned';
  payload: AgentEventPayload & { targetAgentId: string };
}

export interface AgentHandoffEvent extends BaseEvent {
  type: 'agent.handoff';
  payload: AgentEventPayload & { targetAgentId: string; content: string };
}

export interface AgentFailedEvent extends BaseEvent {
  type: 'agent.failed';
  payload: AgentEventPayload & { status: 'error'; content: string; error: { message: string; code?: string } };
}

export interface AgentInboxDirectiveEvent extends BaseEvent {
  type: 'agent.inbox.directive';
  payload: AgentEventPayload & { directive: string };
}

// ── 模型流式消息 (3) ──────────────────────────────────────────────
export interface AgentMessageDeltaEvent extends BaseEvent {
  type: 'agent.message.delta';
  payload: MessageDeltaPayload;
}

export interface AgentMessageCompletedEvent extends BaseEvent {
  type: 'agent.message.completed';
  payload: MessageDeltaPayload & { isFinal: true };
}

export interface AgentReasoningDeltaEvent extends BaseEvent {
  type: 'agent.reasoning.delta';
  payload: ReasoningDeltaPayload;
}

// ── 最终输出 (2) ──────────────────────────────────────────────────
export interface AgentOutputDeltaEvent extends BaseEvent {
  type: 'agent.output.delta';
  payload: OutputDeltaPayload;
}

export interface AgentOutputCompletedEvent extends BaseEvent {
  type: 'agent.output.completed';
  payload: OutputDeltaPayload & { isFinal: true };
}

// ── 工具生命周期 (5) ──────────────────────────────────────────────
export interface ToolStartedEvent extends BaseEvent {
  type: 'tool.started';
  payload: ToolEventPayloadV2 & { status: 'started' };
}

export interface ToolProgressEvent extends BaseEvent {
  type: 'tool.progress';
  payload: ToolEventPayloadV2 & { status: 'running' };
}

export interface ToolCompletedEvent extends BaseEvent {
  type: 'tool.completed';
  payload: ToolEventPayloadV2 & { status: 'completed'; toolOutput: string };
}

export interface ToolErrorEvent extends BaseEvent {
  type: 'tool.error';
  payload: ToolEventPayloadV2 & { status: 'error'; error: NonNullable<ToolEventPayload['error']> };
}

export interface ToolRetryEvent extends BaseEvent {
  type: 'tool.retry';
  payload: ToolEventPayloadV2 & { status: 'retry' };
}

// ── 统计 (1) ──────────────────────────────────────────────────────
export interface TokenUsageEvent extends BaseEvent {
  type: 'token.usage';
  payload: TokenUsagePayload;
}

/** 37 事件类型的判别联合 */
export type AgentEvent =
  | RunCreatedEvent
  | RunStartedEvent
  | RunPausedEvent
  | RunResumedEvent
  | RunCompletedEvent
  | RunFailedEvent
  | RunCancelledEvent
  | RunInterruptedEvent
  | TaskStartedEvent
  | TaskPlanEvent
  | TaskProgressEvent
  | TaskAskConfirmEvent
  | TaskCompletedEvent
  | TaskCancelledEvent
  | TaskFailedEvent
  | AgentStartedEvent
  | AgentStatusEvent
  | AgentWaitingEvent
  | AgentResumedEvent
  | AgentCompletedEvent
  | AgentErrorEvent
  | AgentRetryEvent
  | AgentSpawnedEvent
  | AgentHandoffEvent
  | AgentFailedEvent
  | AgentInboxDirectiveEvent
  | AgentMessageDeltaEvent
  | AgentMessageCompletedEvent
  | AgentReasoningDeltaEvent
  | AgentOutputDeltaEvent
  | AgentOutputCompletedEvent
  | ToolStartedEvent
  | ToolProgressEvent
  | ToolCompletedEvent
  | ToolErrorEvent
  | ToolRetryEvent
  | TokenUsageEvent;

/** 37 个 dot-notation 类型判别字面量（按规范顺序） */
export const AGENT_EVENT_TYPES: readonly AgentEvent['type'][] = [
  // Run (8)
  'run.created',
  'run.started',
  'run.paused',
  'run.resumed',
  'run.completed',
  'run.failed',
  'run.cancelled',
  'run.interrupted',
  // Task (7)
  'task.started',
  'task.plan',
  'task.progress',
  'task.ask-confirm',
  'task.completed',
  'task.cancelled',
  'task.failed',
  // Agent (11)
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
  // Message/Reasoning/Output (5)
  'agent.message.delta',
  'agent.message.completed',
  'agent.reasoning.delta',
  'agent.output.delta',
  'agent.output.completed',
  // Tool (5)
  'tool.started',
  'tool.progress',
  'tool.completed',
  'tool.error',
  'tool.retry',
  // Token (1)
  'token.usage',
] as const;

/** 类型守卫：检查对象是否为合法的 AgentEvent */
export function isAgentEvent(value: unknown): value is AgentEvent {
  if (!value || typeof value !== 'object') return false;
  const obj = value as Record<string, unknown>;
  return (
    typeof obj.type === 'string' &&
    AGENT_EVENT_TYPES.includes(obj.type as AgentEvent['type']) &&
    typeof obj.eventId === 'string' &&
    typeof obj.sessionId === 'string' &&
    typeof obj.runId === 'string' &&
    typeof obj.timestamp === 'string' &&
    typeof obj.seq === 'number' &&
    typeof obj.version === 'number' &&
    obj.version === 2
  );
}

/** 编译期穷尽性检查辅助：在 switch 中对 AgentEvent 穷尽所有 37 种 type */
export function assertNever(_value: never): never {
  throw new Error('Non-exhaustive match on AgentEvent type');
}