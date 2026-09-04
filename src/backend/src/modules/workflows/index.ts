import type { FastifyInstance } from 'fastify';
import type { BackendConfig } from '../../config/index.js';
import { getAllWorkflows, createWorkflow, getWorkflowById, updateWorkflow, deleteWorkflow, getWorkflowRuns } from './store.js';
import { executeWorkflow } from './execution-engine.js';
import { executeNode } from './node-executors.js';
import { aiCreateWorkflow } from './ai-creator.js';
import type { WorkflowNode, WorkflowEdge } from './types.js';

// 重新导出类型和核心函数，保持向后兼容
export type { WorkflowNode, WorkflowEdge };
export { executeNode, executeWorkflow, aiCreateWorkflow };

/** 注册所有工作流路由 */
export function registerWorkflowRoutes(app: FastifyInstance, config: BackendConfig): void {
  // 获取所有工作流
  app.get('/api/workflows', {
    schema: { description: '获取所有工作流', tags: ['工作流'] },
  }, async () => {
    return getAllWorkflows();
  });

  // 创建工作流
  app.post('/api/workflows', {
    schema: {
      description: '创建工作流',
      tags: ['工作流'],
      body: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          nodes: { type: 'array' },
          edges: { type: 'array' },
          trigger: { type: 'string', enum: ['manual', 'schedule', 'webhook'] },
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body as {
      name: string;
      description?: string;
      nodes?: WorkflowNode[];
      edges?: WorkflowEdge[];
      trigger?: 'manual' | 'schedule' | 'webhook';
    };
    try {
      const result = await createWorkflow(body, config);
      return result;
    } catch (e: unknown) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // 获取单个工作流
  app.get('/api/workflows/:id', {
    schema: { description: '获取单个工作流', tags: ['工作流'] },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const workflow = await getWorkflowById(id);
    if (!workflow) return reply.code(404).send({ error: '工作流不存在' });
    return workflow;
  });

  // 更新工作流
  app.put('/api/workflows/:id', {
    schema: {
      description: '更新工作流',
      tags: ['工作流'],
      body: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          description: { type: 'string' },
          nodes: { type: 'array' },
          edges: { type: 'array' },
          trigger: { type: 'string', enum: ['manual', 'schedule', 'webhook'] },
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as {
      name?: string;
      description?: string;
      nodes?: WorkflowNode[];
      edges?: WorkflowEdge[];
      trigger?: 'manual' | 'schedule' | 'webhook';
    };
    try {
      const result = await updateWorkflow(id, body, config);
      if (!result) return reply.code(404).send({ error: '工作流不存在' });
      return result;
    } catch (e: unknown) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // 删除工作流
  app.delete('/api/workflows/:id', {
    schema: { description: '删除工作流', tags: ['工作流'] },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const ok = await deleteWorkflow(id, config);
    if (!ok) return reply.code(404).send({ error: '工作流不存在' });
    return { success: true };
  });

  // 执行工作流：按边拓扑排序，顺序执行每个节点
  app.post('/api/workflows/:id/run', {
    schema: {
      description: '执行工作流（顺序执行所有节点）',
      tags: ['工作流'],
      body: {
        type: 'object',
        properties: {
          input: { type: 'object' }, // 可选：工作流输入参数
        },
      },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { input?: Record<string, unknown> } | null;
    const workflow = await getWorkflowById(id);
    if (!workflow) return reply.code(404).send({ error: '工作流不存在' });

    try {
      const result = await executeWorkflow({
        workflowId: id,
        nodes: workflow.nodes,
        edges: workflow.edges,
        input: body?.input,
        config,
        executeNode,
        db: (await import('../../db/client.js')).getDb(),
        saveDb: (await import('../../db/client.js')).saveDb,
        request,
      });
      return result;
    } catch (e: unknown) {
      return reply.code(400).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // AI 辅助创建工作流：用户用自然语言描述需求，AI 生成完整工作流
  app.post('/api/workflows/ai-create', {
    schema: {
      description: 'AI 辅助创建工作流（自然语言 → 节点+边）',
      tags: ['工作流'],
      body: {
        type: 'object',
        required: ['description'],
        properties: {
          description: { type: 'string' },
          name: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body as { description: string; name?: string };
    try {
      const result = await aiCreateWorkflow({ description: body.description, name: body.name, config });
      return result;
    } catch (e: unknown) {
      return reply.code(500).send({ error: e instanceof Error ? e.message : String(e) });
    }
  });

  // 获取工作流的运行记录
  app.get('/api/workflows/:id/runs', {
    schema: { description: '获取工作流的运行记录', tags: ['工作流'] },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const workflow = await getWorkflowById(id);
    if (!workflow) return reply.code(404).send({ error: '工作流不存在' });
    return getWorkflowRuns(id);
  });
}