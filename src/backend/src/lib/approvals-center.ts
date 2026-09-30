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
 *
 * 整改计划第 1 章（P0）：为 approval grant 增加持久化字段
 * { grantId, runId, taskId, toolName, argsHash, issuer, expiresAt, consumedAt }；
 * decideApproval 原子校验并消费 —— 同一 grant 重放 / 跨会话批准 / 过期 grant 均失败。
 */
import { randomUUID } from 'node:crypto';
import { createApproval, summarizeArgs, type ApprovalRequest } from './approval.js';
import { createHash } from 'node:crypto';

/** P0-07: 计算参数哈希（用户批准的必须是"这一份具体参数"，而非"该工具以后随便执行"） */
export function hashToolArgs(args: Record<string, unknown>): string {
  const canonical = JSON.stringify(args ?? {});
  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/**
 * ApprovalGrant — 一次审批授权的持久化记录（整改计划第 1 章）。
 * - grantId: 与 approval id 一致（apr-xxx），全局唯一
 * - issuer: 发起审批的来源（如 'local' 本地用户 / 'remote:mobile' 远程批准方）
 * - expiresAt: 过期时间戳（ms），超过后不可消费
 * - consumedAt: 消费时间戳（ms），null 表示尚未消费
 */
export interface ApprovalGrant {
  grantId: string;
  runId?: string;
  taskId?: string;
  toolName: string;
  argsHash: string;
  issuer: string;
  expiresAt: number;
  consumedAt: number | null;
  decision?: 'approved' | 'rejected';
}

/** Pending approval 记录，包含绑定上下文（run/task/agent/toolCall + argsHash + grant 元数据） */
interface PendingApproval {
  request: ApprovalRequest & {
    conversationId?: string;
    runId?: string;
    taskId?: string;
    agentId?: string;
    toolCallId?: string;
    argsHash?: string;
  };
  grant: ApprovalGrant;
  settle: (d: 'approved' | 'rejected') => void;
  dispose: () => void;
}

const pending = new Map<string, PendingApproval>();
/** 已消费的 grant 存档（整改计划第 1 章：重放防护 —— 区分"从未存在"与"已被消费"） */
const consumed = new Map<string, ApprovalGrant>();

/** 默认 issuer：本地用户通过浏览器批准 */
export const DEFAULT_ISSUER = 'local';

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
  /** 授权来源（默认 'local'；移动端批准可传 'remote:mobile'） */
  issuer?: string;
  /** P0-08: Run Cancel 信号 —— abort 时立即结束审批等待（decision=aborted） */
  signal?: AbortSignal;
}): { id: string; promise: Promise<{ approved: boolean; decision: 'approved' | 'rejected' | 'timeout' | 'aborted' }> } {
  const id = `apr-${randomUUID().slice(0, 8)}`;
  const argsSummary = summarizeArgs(opts.args);
  // P0-07: argsHash —— 批准绑定具体参数
  const argsHash = hashToolArgs(opts.args);
  const timeoutMs = opts.timeoutMs ?? 60_000;
  const now = Date.now();
  const { token, promise } = createApproval({
    id,
    toolName: opts.toolName,
    argsSummary,
    prompt: () => opts.prompt({ id, toolName: opts.toolName, argsSummary }),
    timeoutMs,
    signal: opts.signal,
  });

  const grant: ApprovalGrant = {
    grantId: id,
    runId: opts.runId,
    taskId: opts.taskId,
    toolName: opts.toolName,
    argsHash,
    issuer: opts.issuer ?? DEFAULT_ISSUER,
    expiresAt: now + timeoutMs,
    consumedAt: null,
  };

  pending.set(id, {
    request: {
      id,
      toolName: opts.toolName,
      argsSummary,
      createdAt: now,
      timeoutMs,
      onDecision: () => {},
      cleanup: () => {},
      conversationId: opts.conversationId,
      runId: opts.runId,
      taskId: opts.taskId,
      agentId: opts.agentId,
      toolCallId: opts.toolCallId,
      argsHash,
    },
    grant,
    settle: (d) => token.settle(d),
    dispose: () => { token.dispose(); pending.delete(id); },
  });
  // 超时自动清理（存档已消费的不清理，重放检测依赖它；超时未消费的删掉即可）
  void promise.finally(() => {
    const p = pending.get(id);
    if (p && p.grant.consumedAt === null) pending.delete(id);
  });
  return { id, promise };
}

/** 结构化消费结果（整改计划第 1 章：原子校验 + 重放防护） */
export type ConsumeApprovalResult =
  | { ok: true; grant: ApprovalGrant }
  | { ok: false; code: 'NOT_FOUND' | 'ALREADY_CONSUMED' | 'EXPIRED' };

/**
 * 原子消费一个 pending approval（整改计划第 1 章）。
 * - 找不到 → NOT_FOUND（从未创建）
 * - 已被消费（consumed 存档命中 / consumedAt 非 null）→ ALREADY_CONSUMED（同一 grant 重放、跨标签页）
 * - 已过期（expiresAt < now）→ EXPIRED
 * 成功时原子：设置 consumedAt + settle + 移入 consumed 存档（消费后不可重放）。
 */
export function consumeApproval(id: string, decision: 'approved' | 'rejected', issuer: string = DEFAULT_ISSUER): ConsumeApprovalResult {
  const archived = consumed.get(id);
  if (archived) return { ok: false, code: 'ALREADY_CONSUMED' };
  const p = pending.get(id);
  if (!p) return { ok: false, code: 'NOT_FOUND' };
  if (p.grant.consumedAt !== null) return { ok: false, code: 'ALREADY_CONSUMED' };
  if (Date.now() > p.grant.expiresAt) {
    p.grant.consumedAt = Date.now();
    p.grant.decision = 'rejected';
    p.settle('rejected');
    consumed.set(id, { ...p.grant });
    p.dispose();
    return { ok: false, code: 'EXPIRED' };
  }
  p.grant.consumedAt = Date.now();
  p.grant.decision = decision;
  p.grant.issuer = issuer;
  consumed.set(id, { ...p.grant });
  p.settle(decision);
  // 立即从 pending 移除（存档保留用于重放检测）
  p.dispose();
  return { ok: true, grant: { ...p.grant } };
}

/**
 * 决议一个 pending approval（兼容旧接口：返回 boolean）。
 * 内部委托 consumeApproval；原子消费。已消费/过期/不存在均返回 false。
 */
export function decideApproval(id: string, decision: 'approved' | 'rejected'): boolean {
  const res = consumeApproval(id, decision);
  return res.ok;
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
  argsHash?: string;
  grantId: string;
  issuer: string;
  expiresAt: number;
  consumedAt: number | null;
}> {
  return Array.from(pending.values()).map(({ request, grant }) => ({
    id: request.id,
    toolName: request.toolName,
    argsSummary: request.argsSummary,
    conversationId: request.conversationId,
    runId: request.runId,
    taskId: request.taskId,
    agentId: request.agentId,
    toolCallId: request.toolCallId,
    argsHash: request.argsHash,
    grantId: grant.grantId,
    issuer: grant.issuer,
    expiresAt: grant.expiresAt,
    consumedAt: grant.consumedAt,
  }));
}

/** 查询单个 grant 快照（不存在返回 null） */
export function getApprovalGrant(id: string): ApprovalGrant | null {
  const p = pending.get(id);
  return p ? { ...p.grant } : null;
}

/** 测试辅助：强制将 grant 标记为过期（模拟超时后未清理的竞态窗口） */
export function __setGrantExpiresAtForTest(id: string, expiresAt: number): boolean {
  const p = pending.get(id);
  if (!p) return false;
  p.grant.expiresAt = expiresAt;
  return true;
}

/** 测试辅助：清空 pending 与 consumed 存档 */
export function clearPendingApprovals(): void {
  for (const p of pending.values()) p.dispose();
  pending.clear();
  consumed.clear();
}
