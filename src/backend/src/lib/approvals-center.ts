/**
 * approval 决议注册中心 — 全局 pending approval 表，供前端通过 API 决议。
 *
 * 唯一 Approval 生命周期 = approvals-center (pending Map + create/decide/list) + core/permissions/approval.ts createApproval (token 超时)
 * - approvals-center 持有 pending 记录（Map），是审批状态的单一事实来源
 * - core/permissions/approval.ts 的 createApproval 仅提供 token/promise/超时机制，不维护 pending 列表
 * - modules/approvals/index.ts 通过 approvals-center 的 decideApproval/listPendingApprovals 对外暴露 HTTP API
 *
 * executeTool 的 onApproval 回调创建 pending 审批并挂起等待；
 * 前端收到 task.ask-confirm 事件后打开确认框，POST /api/approvals/:id/decide
 * 回传 approved/rejected；后端 resolve 挂起的 Promise。
 * 60s 无决议自动超时拒绝（approval.ts 内建）。
 */
import { randomUUID } from 'node:crypto';
import { createApproval, summarizeArgs, type ApprovalRequest } from './approval.js';

/** Pending approval 记录，包含绑定上下文（run/task/agent/toolCall） */
interface PendingApproval {
  request: ApprovalRequest & {
    conversationId?: string;
    runId?: string;
    taskId?: string;
    agentId?: string;
    toolCallId?: string;
  };
  settle: (d: 'approved' | 'rejected') => void;
  dispose: () => void;
}

const pending = new Map<string, PendingApproval>();

/** 创建审批并把 pending 注册到表。prompt 用于 SSE 推送 task.ask-confirm 事件 */
export function createPendingApproval(opts: {
  toolName: string;
  args: Record<string, unknown>;
  prompt: (payload: { id: string; toolName: string; argsSummary: string }) => void;
  conversationId?: string;
  runId?: string;
  taskId?: string;
  agentId?: string;
  toolCallId?: string;
  timeoutMs?: number;
}): { id: string; promise: Promise<{ approved: boolean; decision: 'approved' | 'rejected' | 'timeout' }> } {
  const id = `apr-${randomUUID().slice(0, 8)}`;
  const argsSummary = summarizeArgs(opts.args);
  const { token, promise } = createApproval({
    id,
    toolName: opts.toolName,
    argsSummary,
    prompt: () => opts.prompt({ id, toolName: opts.toolName, argsSummary }),
    timeoutMs: opts.timeoutMs,
  });

  pending.set(id, {
    request: {
      id,
      toolName: opts.toolName,
      argsSummary,
      createdAt: Date.now(),
      timeoutMs: opts.timeoutMs ?? 60_000,
      onDecision: () => {},
      cleanup: () => {},
      conversationId: opts.conversationId,
      runId: opts.runId,
      taskId: opts.taskId,
      agentId: opts.agentId,
      toolCallId: opts.toolCallId,
    },
    settle: (d) => token.settle(d),
    dispose: () => { token.dispose(); pending.delete(id); },
  });
  // 超时自动清理
  void promise.finally(() => { pending.delete(id); });
  return { id, promise };
}

/** 决议一个 pending approval */
export function decideApproval(id: string, decision: 'approved' | 'rejected'): boolean {
  const p = pending.get(id);
  if (!p) return false;
  p.settle(decision);
  // 立即从 pending 移除，避免重复决议返回 true
  p.dispose();
  return true;
}

/** 列出当前 pending（调试/健康检查用） */
export function listPendingApprovals(): Array<{ 
  id: string; 
  toolName: string; 
  argsSummary: string;
  conversationId?: string;
  runId?: string;
  taskId?: string;
  agentId?: string;
  toolCallId?: string;
}> {
  return Array.from(pending.values()).map(({ request }) => ({
    id: request.id,
    toolName: request.toolName,
    argsSummary: request.argsSummary,
    conversationId: request.conversationId,
    runId: request.runId,
    taskId: request.taskId,
    agentId: request.agentId,
    toolCallId: request.toolCallId,
  }));
}

/** 测试辅助：清空 pending */
export function clearPendingApprovals(): void {
  for (const p of pending.values()) p.dispose();
  pending.clear();
}