/**
 * approval 决议注册中心 — 全局 pending approval 表，供前端通过 API 决议。
 *
 * executeTool 的 onApproval 回调创建 pending 审批并挂起等待；
 * 前端收到 task.ask-confirm 事件后打开确认框，POST /api/approvals/:id/decide
 * 回传 approved/rejected；后端 resolve 挂起的 Promise。
 * 60s 无决议自动超时拒绝（approval.ts 内建）。
 */
import { randomUUID } from 'node:crypto';
import { createApproval, summarizeArgs, type ApprovalRequest } from './approval.js';

interface PendingApproval {
  request: ApprovalRequest;
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
}): { id: string; promise: Promise<{ approved: boolean; decision: 'approved' | 'rejected' | 'timeout' }> } {
  const id = `apr-${randomUUID().slice(0, 8)}`;
  const argsSummary = summarizeArgs(opts.args);
  const { token, promise } = createApproval({
    id,
    toolName: opts.toolName,
    argsSummary,
    prompt: () => opts.prompt({ id, toolName: opts.toolName, argsSummary }),
  });

  pending.set(id, {
    request: {
      id,
      toolName: opts.toolName,
      argsSummary,
      createdAt: Date.now(),
      timeoutMs: 60_000,
      onDecision: () => {},
      cleanup: () => {},
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
  return true;
}

/** 列出当前 pending（调试/健康检查用） */
export function listPendingApprovals(): Array<{ id: string; toolName: string; argsSummary: string }> {
  return Array.from(pending.values()).map(({ request }) => ({
    id: request.id,
    toolName: request.toolName,
    argsSummary: request.argsSummary,
  }));
}

/** 测试辅助：清空 pending */
export function clearPendingApprovals(): void {
  for (const p of pending.values()) p.dispose();
  pending.clear();
}