import type { FastifyInstance } from 'fastify';
import type { BackendConfig } from '../../config/index.js';
import { registerSettingsRoutes, filterSettingsFields } from './settings.js';
import { registerProjectsRoutes } from './projects.js';
import { registerExecRoutes } from './exec.js';
import { registerImportExportRoutes } from './import-export.js';
import { registerProviderTestRoutes } from './providers-test.js';
import { isPathInAllowedDirs, isPathAllowed } from './utils.js';

// 重新导出共享工具函数，保持向后兼容
export { isPathInAllowedDirs, isPathAllowed, filterSettingsFields };

/** 注册所有数据相关路由 */
export function registerDataRoutes(app: FastifyInstance, config: BackendConfig): void {
  // 注册各子模块路由
  registerSettingsRoutes(app, config);
  registerProjectsRoutes(app, config);
  registerExecRoutes(app, config);
  registerImportExportRoutes(app, config);
  registerProviderTestRoutes(app, config);

  // ====== Chat History (P2-11: /api/chat 系列已弃用，请使用 /api/conversations) ======
  app.get('/api/chat', { schema: { description: '获取聊天历史（已弃用，请使用 /api/conversations）', tags: ['数据'] } }, async () => {
    const { getChatHistories } = await import('../../lib/dal.js');
    return getChatHistories();
  });

  app.post('/api/chat', { schema: { description: '新建聊天（已弃用，请使用 POST /api/conversations）', tags: ['数据'] } }, async (request) => {
    const { saveChatHistory } = await import('../../lib/dal.js');
    const body = request.body as any;
    return saveChatHistory(body.title || '新对话');
  });

  app.post('/api/chat/:id/messages', {
    schema: { description: '添加消息（已弃用，请使用 /api/conversations/:id/messages）', tags: ['数据'] },
  }, async (request, reply) => {
    // P0-3: 删除 mock AI 回复，改为明确提示用户使用 conversations 路由
    return reply.code(410).send({ error: '此端点已弃用，请使用 POST /api/conversations/:id/messages 获取真实 AI 流式响应' });
  });

  app.delete('/api/chat/:id', { schema: { description: '删除聊天（已弃用，请使用 DELETE /api/conversations/:id）', tags: ['数据'] } }, async (request) => {
    const { deleteChatHistory } = await import('../../lib/dal.js');
    const { id } = request.params as { id: string };
    const ok = await deleteChatHistory(id);
    return { success: ok };
  });
}