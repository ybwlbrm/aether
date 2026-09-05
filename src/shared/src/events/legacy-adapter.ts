/**
 * Aether 2.0 — v1/v2 双向兼容适配器
 *
 * - toLegacy: v2 AgentEvent -> v1 AgentEventEnvelope
 * - toV2: v1 AgentEventEnvelope + runId -> v2 AgentEvent
 * - roundTrip: 验证往返转换保持关键字段不变
 */

import type {
  AgentEventEnvelope,
  AgentEventType,
  ToolEventPayload,
  EventStatus,
} from '../agent-event.js';
import type {
  AgentEvent,
  BaseEvent,
  RunEventPayload,
  TaskEventPayload,
  AgentEventPayload,
  MessageDeltaPayload,
  ReasoningDeltaPayload,
  OutputDeltaPayload,
  ToolEventPayloadV2,
  TokenUsagePayload,
  AGENT_EVENT_TYPES,
  RunEndReason,
  TaskEndReason,
} from './events.js';

/** v1 eventType -> v2 type 映射表 */
const V1_TO_V2_TYPE: Readonly<Record<AgentEventType, AgentEvent['type']>> = {
  'session.started': 'run.created',
  'session.closed': 'run.completed',
  'task.started': 'task.started',
  'task.plan': 'task.plan',
  'task.progress': 'task.progress',
  'task.ask-confirm': 'task.ask-confirm',
  'task.completed': 'task.completed',
  'task.cancelled': 'task.cancelled',
  'task.failed': 'task.failed',
  'agent.started': 'agent.started',
  'agent.status': 'agent.status',
  'agent.waiting': 'agent.waiting',
  'agent.resumed': 'agent.resumed',
  'agent.completed': 'agent.completed',
  'agent.error': 'agent.error',
  'agent.retry': 'agent.retry',
  'agent.spawned': 'agent.spawned',
  'agent.handoff': 'agent.handoff',
  'agent.failed': 'agent.failed',
  'agent.inbox.directive': 'agent.inbox.directive',
  'agent.message.delta': 'agent.message.delta',
  'agent.message.completed': 'agent.message.completed',
  'agent.reasoning.delta': 'agent.reasoning.delta',
  'agent.output.delta': 'agent.output.delta',
  'agent.output.completed': 'agent.output.completed',
  'tool.started': 'tool.started',
  'tool.progress': 'tool.progress',
  'tool.completed': 'tool.completed',
  'tool.error': 'tool.error',
  'tool.retry': 'tool.retry',
  'token': 'token.usage',
};

/** v2 type -> v1 eventType 反向映射（用于 toLegacy） */
const V2_TO_V1_TYPE: Readonly<Partial<Record<AgentEvent['type'], AgentEventType>>> = {
  'run.created': 'session.started',
  'run.started': 'session.started',
  'run.paused': 'session.closed',
  'run.resumed': 'session.started',
  'run.completed': 'session.closed',
  'run.failed': 'session.closed',
  'run.cancelled': 'session.closed',
  'run.interrupted': 'session.closed',
  'task.started': 'task.started',
  'task.plan': 'task.plan',
  'task.progress': 'task.progress',
  'task.ask-confirm': 'task.ask-confirm',
  'task.completed': 'task.completed',
  'task.cancelled': 'task.cancelled',
  'task.failed': 'task.failed',
  'agent.started': 'agent.started',
  'agent.status': 'agent.status',
  'agent.waiting': 'agent.waiting',
  'agent.resumed': 'agent.resumed',
  'agent.completed': 'agent.completed',
  'agent.error': 'agent.error',
  'agent.retry': 'agent.retry',
  'agent.spawned': 'agent.spawned',
  'agent.handoff': 'agent.handoff',
  'agent.failed': 'agent.failed',
  'agent.inbox.directive': 'agent.inbox.directive',
  'agent.message.delta': 'agent.message.delta',
  'agent.message.completed': 'agent.message.completed',
  'agent.reasoning.delta': 'agent.reasoning.delta',
  'agent.output.delta': 'agent.output.delta',
  'agent.output.completed': 'agent.output.completed',
  'tool.started': 'tool.started',
  'tool.progress': 'tool.progress',
  'tool.completed': 'tool.completed',
  'tool.error': 'tool.error',
  'tool.retry': 'tool.retry',
  'token.usage': 'token',
};

/** 从 v2 payload 提取 v1 兼容字段 */
function extractV1Fields(event: AgentEvent): Partial<AgentEventEnvelope> {
  const base: Partial<AgentEventEnvelope> = {
    eventId: event.eventId,
    sessionId: event.sessionId,
    taskId: event.taskId ?? event.runId, // v1 用 taskId 承载 runId
    agentId: event.agentId ?? 'unknown',
    agentType: 'conversation', // v1 必填，v2 无对应字段，给默认值
    timestamp: event.timestamp,
    seq: event.seq,
    metadata: event.metadata,
  };

  // 根据事件类型填充特定字段
  switch (event.type) {
    case 'run.created':
    case 'run.started':
    case 'run.paused':
    case 'run.resumed':
    case 'run.completed':
    case 'run.failed':
    case 'run.cancelled':
    case 'run.interrupted': {
      const p = event.payload as RunEventPayload;
      base.status = p.endReason ? 'completed' : 'started';
      if (p.error) base.content = p.error.message;
      if (p.tokenUsage) base.metadata = { ...base.metadata, tokenUsage: p.tokenUsage };
      break;
    }
    case 'task.started':
    case 'task.plan':
    case 'task.progress':
    case 'task.ask-confirm':
    case 'task.completed':
    case 'task.cancelled':
    case 'task.failed': {
      const p = event.payload as TaskEventPayload;
      base.status = p.status as EventStatus | undefined;
      base.content = p.content;
      if (p.endReason) base.endReason = p.endReason as AgentEventEnvelope['endReason'];
      break;
    }
    case 'agent.started':
    case 'agent.status':
    case 'agent.waiting':
    case 'agent.resumed':
    case 'agent.completed':
    case 'agent.error':
    case 'agent.retry':
    case 'agent.spawned':
    case 'agent.handoff':
    case 'agent.failed':
    case 'agent.inbox.directive': {
      const p = event.payload as AgentEventPayload;
      base.status = p.status as EventStatus | undefined;
      base.content = p.content;
      if (p.targetAgentId) base.metadata = { ...base.metadata, targetAgentId: p.targetAgentId };
      if (p.directive) base.metadata = { ...base.metadata, directive: p.directive };
      break;
    }
    case 'agent.message.delta':
    case 'agent.message.completed': {
      const p = event.payload as MessageDeltaPayload;
      base.content = p.content;
      break;
    }
    case 'agent.reasoning.delta': {
      const p = event.payload as ReasoningDeltaPayload;
      base.content = p.content;
      break;
    }
    case 'agent.output.delta':
    case 'agent.output.completed': {
      const p = event.payload as OutputDeltaPayload;
      base.content = p.content;
      break;
    }
    case 'tool.started':
    case 'tool.progress':
    case 'tool.completed':
    case 'tool.error':
    case 'tool.retry': {
      const p = event.payload as ToolEventPayloadV2;
      base.status = p.status as EventStatus | undefined;
      base.tool = {
        toolName: p.toolName,
        toolInput: p.toolInput,
        toolOutput: p.toolOutput,
        inputDetail: p.inputDetail,
        outputDetail: p.outputDetail,
        error: p.error,
      };
      break;
    }
    case 'token.usage': {
      const p = event.payload as TokenUsagePayload;
      base.metadata = { ...base.metadata, tokenUsage: p };
      break;
    }
  }

  return base;
}

/** 将 v2 AgentEvent 转换为 v1 AgentEventEnvelope */
export function toLegacy(event: AgentEvent): AgentEventEnvelope {
  const v1Type = V2_TO_V1_TYPE[event.type] ?? 'session.started';
  const base = extractV1Fields(event);

  return {
    eventId: base.eventId!,
    sessionId: base.sessionId!,
    taskId: base.taskId!,
    agentId: base.agentId!,
    agentType: base.agentType!,
    eventType: v1Type,
    timestamp: base.timestamp!,
    seq: base.seq!,
    status: base.status,
    content: base.content,
    tool: base.tool,
    parentEventId: event.parentEventId,
    metadata: base.metadata,
    endReason: base.endReason,
  };
}

/** 从 v1 envelope 重建 v2 payload（按类型分发） */
function buildV2Payload(envelope: AgentEventEnvelope, v2Type: AgentEvent['type']): AgentEvent['payload'] {
  switch (v2Type) {
    case 'run.created':
    case 'run.started':
    case 'run.paused':
    case 'run.resumed': {
      const p: RunEventPayload = {};
      if (envelope.status === 'completed') p.endReason = 'completed';
      if (envelope.content) p.error = { message: envelope.content };
      if (envelope.metadata?.tokenUsage) p.tokenUsage = envelope.metadata.tokenUsage as TokenUsagePayload;
      return p;
    }
    case 'run.completed': {
      const p: RunEventPayload = { endReason: (envelope.endReason as RunEndReason) ?? 'completed' };
      if (envelope.metadata?.tokenUsage) p.tokenUsage = envelope.metadata.tokenUsage as TokenUsagePayload;
      return p;
    }
    case 'run.failed': {
      const p: RunEventPayload = {
        endReason: (envelope.endReason as RunEndReason) ?? 'error',
        error: { message: envelope.content ?? 'Unknown error', code: envelope.metadata?.errorCode as string },
      };
      return p;
    }
    case 'run.cancelled':
    case 'run.interrupted': {
      return { endReason: (envelope.endReason as RunEndReason) ?? 'aborted' };
    }

    case 'task.started': {
      return { status: 'started' as const };
    }
    case 'task.plan':
    case 'task.progress':
    case 'task.ask-confirm': {
      return { content: envelope.content ?? '', status: 'running' as const };
    }
    case 'task.completed': {
      return { status: 'completed' as const, endReason: (envelope.endReason as TaskEndReason) ?? 'completed', content: envelope.content };
    }
    case 'task.cancelled': {
      return { status: 'cancelled' as const, endReason: (envelope.endReason as TaskEndReason) ?? 'aborted', content: envelope.content };
    }
    case 'task.failed': {
      return {
        status: 'error' as const,
        endReason: (envelope.endReason as TaskEndReason) ?? 'error',
        content: envelope.content,
        error: { message: envelope.content ?? 'Task failed', code: envelope.metadata?.errorCode as string },
      };
    }

    case 'agent.started':
    case 'agent.resumed': {
      return { status: 'running' as const, content: envelope.content };
    }
    case 'agent.status': {
      return { status: (envelope.status as AgentEventPayload['status']) ?? 'running', content: envelope.content };
    }
    case 'agent.waiting': {
      return { status: 'waiting' as const, content: envelope.content ?? 'Waiting for input' };
    }
    case 'agent.completed': {
      return { status: 'completed' as const, content: envelope.content };
    }
    case 'agent.error':
    case 'agent.failed': {
      return {
        status: 'error' as const,
        content: envelope.content ?? 'Agent error',
        error: { message: envelope.content ?? 'Agent error', code: envelope.metadata?.errorCode as string },
      };
    }
    case 'agent.retry': {
      return { status: 'retry' as const, content: envelope.content ?? 'Retrying...' };
    }
    case 'agent.spawned': {
      return { targetAgentId: envelope.metadata?.targetAgentId as string ?? 'unknown', content: envelope.content };
    }
    case 'agent.handoff': {
      return { targetAgentId: envelope.metadata?.targetAgentId as string ?? 'unknown', content: envelope.content ?? 'Handoff' };
    }
    case 'agent.inbox.directive': {
      return { directive: envelope.metadata?.directive as string ?? envelope.content ?? '', content: envelope.content };
    }

    case 'agent.message.delta': {
      return { content: envelope.content ?? '', isFinal: false };
    }
    case 'agent.message.completed': {
      return { content: envelope.content ?? '', isFinal: true };
    }
    case 'agent.reasoning.delta': {
      return { content: envelope.content ?? '', isFinal: false };
    }
    case 'agent.output.delta': {
      return { content: envelope.content ?? '', isFinal: false };
    }
    case 'agent.output.completed': {
      return { content: envelope.content ?? '', isFinal: true };
    }

    case 'tool.started': {
      return {
        toolName: envelope.tool?.toolName ?? 'unknown',
        toolInput: envelope.tool?.toolInput ?? '',
        inputDetail: envelope.tool?.inputDetail,
        status: 'started' as const,
      };
    }
    case 'tool.progress': {
      return {
        toolName: envelope.tool?.toolName ?? 'unknown',
        toolInput: envelope.tool?.toolInput ?? '',
        inputDetail: envelope.tool?.inputDetail,
        toolOutput: envelope.tool?.toolOutput,
        outputDetail: envelope.tool?.outputDetail,
        status: 'running' as const,
      };
    }
    case 'tool.completed': {
      return {
        toolName: envelope.tool?.toolName ?? 'unknown',
        toolInput: envelope.tool?.toolInput ?? '',
        inputDetail: envelope.tool?.inputDetail,
        toolOutput: envelope.tool?.toolOutput ?? '',
        outputDetail: envelope.tool?.outputDetail,
        status: 'completed' as const,
      };
    }
    case 'tool.error': {
      return {
        toolName: envelope.tool?.toolName ?? 'unknown',
        toolInput: envelope.tool?.toolInput ?? '',
        inputDetail: envelope.tool?.inputDetail,
        error: envelope.tool?.error ?? { message: envelope.content ?? 'Tool error' },
        status: 'error' as const,
      };
    }
    case 'tool.retry': {
      return {
        toolName: envelope.tool?.toolName ?? 'unknown',
        toolInput: envelope.tool?.toolInput ?? '',
        inputDetail: envelope.tool?.inputDetail,
        status: 'retry' as const,
      };
    }

    case 'token.usage': {
      const tu = envelope.metadata?.tokenUsage as TokenUsagePayload | undefined;
      return {
        inputTokens: tu?.inputTokens ?? 0,
        outputTokens: tu?.outputTokens ?? 0,
        totalTokens: tu?.totalTokens ?? 0,
        model: tu?.model,
      };
    }
  }
}

/** 将 v1 AgentEventEnvelope 转换为 v2 AgentEvent（需要提供 runId，因为 v1 无此字段） */
export function toV2(envelope: AgentEventEnvelope, runId: string): AgentEvent {
  const v2Type = V1_TO_V2_TYPE[envelope.eventType] ?? 'run.created';
  const payload = buildV2Payload(envelope, v2Type);

  const base: BaseEvent = {
    eventId: envelope.eventId,
    sessionId: envelope.sessionId,
    runId,
    taskId: envelope.taskId,
    agentId: envelope.agentId,
    parentEventId: envelope.parentEventId,
    timestamp: envelope.timestamp,
    seq: envelope.seq,
    type: v2Type,
    version: 2,
    metadata: envelope.metadata,
  };

  // 构造完整事件对象（类型系统会根据 type 字段收窄 payload 类型）
  return { ...base, payload } as AgentEvent;
}

/** 往返转换验证：v2 -> v1 -> v2 保持关键字段不变 */
export function roundTrip(event: AgentEvent, runId: string): AgentEvent {
  const legacy = toLegacy(event);
  return toV2(legacy, runId);
}

/** 检查往返转换是否保持关键字段 */
export function verifyRoundTrip(original: AgentEvent, roundTripped: AgentEvent): {
  ok: boolean;
  mismatches: string[];
} {
  const mismatches: string[] = [];
  const keys: (keyof BaseEvent)[] = ['eventId', 'sessionId', 'runId', 'taskId', 'agentId', 'seq', 'type', 'version'];

  for (const key of keys) {
    if (original[key] !== roundTripped[key]) {
      mismatches.push(`${key}: ${String(original[key])} !== ${String(roundTripped[key])}`);
    }
  }

  return { ok: mismatches.length === 0, mismatches };
}