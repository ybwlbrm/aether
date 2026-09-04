/**
 * Approval 决议端点 — ask-user 交互审批的 HTTP 入口。
 * 前端收到 task.ask-confirm SSE 事件后弹出确认框，
 * 用户选择后 POST /api/approvals/:id/decide {decision:'approved'|'rejected'} 回传。
 */
import type { FastifyInstance } from 'fastify';
import type { BackendConfig } from '../../config/index.js';
import { decideApproval, listPendingApprovals } from '../../lib/approvals-center.js';

export function registerApprovalRoutes(app: FastifyInstance, _config: BackendConfig): void {
  // 列出当前等待审批（前端/调试用）
  app.get('/api/approvals', {
    schema: {
      description: '列出所有待用户确认的工具审批',
      tags: ['Approval'],
    },
  }, async () => {
    return { approvals: listPendingApprovals() };
  });

  // 决议一个审批
  app.post('/api/approvals/:id/decide', {
    schema: {
      description: '用户对工具审批做出决定（approved/rejected）',
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
    const found = decideApproval(id, decision);
    if (!found) {
      return reply.code(404).send({ error: { message: '审批不存在或已过期' } });
    }
    return { success: true, id, decision };
  });
}