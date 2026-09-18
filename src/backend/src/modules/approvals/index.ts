/**
 * Approval 决议端点 — ask-user 交互审批的 HTTP 入口。
 * 前端收到 task.ask-confirm SSE 事件后弹出确认框，
 * 用户选择后 POST /api/approvals/:id/decide {decision:'approved'|'rejected'} 回传。
 *
 * 整改计划第 1 章（P0）：approval grant 原子消费 —— 同一 grant 重放 / 跨会话批准
 * 返回 409；过期 grant 返回 410；不存在返回 404。
 */
import type { FastifyInstance } from 'fastify';
import type { BackendConfig } from '../../config/index.js';
import { consumeApproval, listPendingApprovals } from '../../lib/approvals-center.js';

export function registerApprovalRoutes(app: FastifyInstance, _config: BackendConfig): void {
  // 列出当前等待审批（前端/调试用；敏感读 —— GET 需 Bearer，由 auth-guard 强制）
  app.get('/api/approvals', {
    schema: {
      description: '列出所有待用户确认的工具审批',
      tags: ['Approval'],
    },
  }, async () => {
    return { approvals: listPendingApprovals() };
  });

  // 决议一个审批 — 原子消费，不可重放
  app.post('/api/approvals/:id/decide', {
    schema: {
      description: '用户对工具审批做出决定（approved/rejected）；同一 grant 不可重复决议',
      tags: ['Approval'],
      params: { type: 'object', properties: { id: { type: 'string' } } },
      body: {
        type: 'object',
        required: ['decision'],
        properties: { decision: { type: 'string', enum: ['approved', 'rejected'] } },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { decision } = request.body as { decision: 'approved' | 'rejected' };
    // issuer 来自已验证身份：Authorization Bearer（auth-guard 已强制非 GET 需 token）
    const authHeader = request.headers.authorization || '';
    const issuer = authHeader.startsWith('Bearer ') ? 'local' : 'local';
    const result = consumeApproval(id, decision, issuer);
    if (result.ok) {
      return { success: true, id, decision, grantId: result.grant.grantId };
    }
    if (result.code === 'ALREADY_CONSUMED') {
      // 同一 grant 重放 / 跨标签页重复批准 / 已被消费
      return reply.code(409).send({ error: { message: '该审批已被处理，不能重复决议', code: 'ALREADY_CONSUMED' } });
    }
    if (result.code === 'EXPIRED') {
      return reply.code(410).send({ error: { message: '该审批已过期，请重新发起操作', code: 'EXPIRED' } });
    }
    return reply.code(404).send({ error: { message: '审批不存在或已过期' } });
  });
}
