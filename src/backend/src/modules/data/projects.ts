import type { FastifyInstance } from 'fastify';
import type { BackendConfig } from '../../config/index.js';
import { getProjects, saveProject, updateProject, deleteProject } from '../../lib/dal.js';

/** 项目相关路由 */
export function registerProjectsRoutes(app: FastifyInstance, config: BackendConfig): void {
  // ====== Projects ======
  app.get('/api/projects', { schema: { description: '获取项目列表', tags: ['数据'] } }, async () => {
    return getProjects();
  });

  app.post('/api/projects', { schema: { description: '新建项目', tags: ['数据'] } }, async (request) => {
    const body = (request.body ?? {}) as Record<string, unknown>;
    const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);
    const type: 'url' | 'bat' | 'command' = body.type === 'bat' || body.type === 'command' ? body.type : 'url';
    const target = str(body.target) ?? '';
    return saveProject({ name: str(body.name) ?? '', type, target, category: str(body.category), description: str(body.description) });
  });

  app.put('/api/projects/:id', { schema: { description: '更新项目', tags: ['数据'] } }, async (request) => {
    const { id } = request.params as { id: string };
    const body = (request.body ?? {}) as Record<string, unknown>;
    const result = await updateProject(id, body);
    if (!result) return { error: 'Project not found' };
    return result;
  });

  app.delete('/api/projects/:id', { schema: { description: '删除项目', tags: ['数据'] } }, async (request) => {
    const { id } = request.params as { id: string };
    const ok = await deleteProject(id);
    return { success: ok };
  });
}