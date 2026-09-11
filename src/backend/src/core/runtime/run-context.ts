/**
 * createRunContext — Aether 2.0 统一 Run 上下文创建入口（P0-02/P0-04 收口）
 *
 * 目标：一次执行只创建一个 Run ID，taskId 默认与 runId 相同，所有组件
 * （SSE / EventBus / EventStore / Approval / Cancellation / ToolLoop / Agent）
 * 共享同一份 runId/taskId，杜绝"task.started 用 ID A、其余事件用 ID B"的幽灵数据。
 *
 * setupSse() 不得自行生成运行 ID —— 必须由上层 createRunContext() 创建后传入。
 *
 * Transport-agnostic：仅 node:crypto randomUUID，无 Fastify/SSE 依赖。
 */

import { randomUUID } from 'node:crypto';

/** Run 上下文 — 一次执行的统一身份 */
export interface RunContext {
  /** Run ID（唯一，一次执行一个） */
  runId: string;
  /** Task ID（默认 = runId，同一执行唯一） */
  taskId: string;
  /** 会话/对话 ID（可能为 anonymous） */
  sessionId: string;
  /** 对话 ID（undefined = anonymous 或未关联） */
  conversationId?: string;
  /** 默认 agent 身份 */
  agentId: string;
  agentType: string;
  /** 是否已关联真实对话（anonymous=false） */
  hasConversation: boolean;
}

export interface CreateRunContextOptions {
  /** 对话 ID（缺省 anonymous） */
  conversationId?: string;
  /** 默认 agentId（缺省 'main'） */
  agentId?: string;
  /** 默认 agentType（缺省 'conversation'） */
  agentType?: string;
  /** 显式指定 runId（测试/恢复场景；生产应留空自动生成） */
  runId?: string;
}

/**
 * 创建统一 Run 上下文。
 * - runId 自动生成（或显式传入）
 * - taskId 默认 = runId（一次执行一个 ID）
 * - sessionId = conversationId || 'anonymous'
 */
export function createRunContext(opts: CreateRunContextOptions = {}): RunContext {
  const runId = opts.runId ?? randomUUID();
  const conversationId = opts.conversationId;
  return {
    runId,
    taskId: runId,
    sessionId: conversationId ?? 'anonymous',
    conversationId,
    agentId: opts.agentId ?? 'main',
    agentType: opts.agentType ?? 'conversation',
    hasConversation: conversationId !== undefined && conversationId !== '',
  };
}
