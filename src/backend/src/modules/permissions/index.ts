import type { FastifyInstance } from 'fastify';
import type { BackendConfig } from '../../config/index.js';
import { getSettings, saveSettings } from '../../lib/dal.js';
import { AppError } from '@pacc/shared';

export function registerPermissionsRoutes(app: FastifyInstance, _config: BackendConfig): void {

  // 获取当前权限级别
  app.get('/api/permissions', {
    schema: { description: '获取当前权限级别', tags: ['权限'] },
  }, async () => {
    const settings = await getSettings();
    const level = settings.permissionLevel ?? 2;
    const labels: Record<number, string> = { 1: 'Level 1（只读）', 2: 'Level 2（完全）', 3: 'Level 3（超级）' };
    return { level, label: labels[level] || `Level ${level}` };
  });

  // 设置权限级别
  app.post('/api/permissions', {
    schema: {
      description: '设置权限级别',
      tags: ['权限'],
      body: {
        type: 'object',
        required: ['level'],
        properties: { level: { type: 'number', enum: [1, 2, 3] } },
      },
    },
  }, async (request) => {
    const body = request.body as { level: number };
    if (![1, 2, 3].includes(body.level)) throw AppError.validation('权限级别必须为 1、2 或 3');
    const level = body.level;
    const settings = await getSettings();
    settings.permissionLevel = level;
    await saveSettings(settings);
    const labels: Record<number, string> = { 1: 'Level 1（只读）', 2: 'Level 2（完全）', 3: 'Level 3（超级）' };
    return { level, label: labels[level] };
  });
}