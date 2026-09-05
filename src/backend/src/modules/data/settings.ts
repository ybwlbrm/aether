import type { FastifyInstance } from 'fastify';
import type { BackendConfig } from '../../config/index.js';
import { getSettings, saveSettings } from '../../lib/dal.js';
import { resolve } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

// W4-3: 路径校验统一至 lib/path-guard.ts（转发，供调用方兼容）

/** P0-2 修复：过滤设置对象，剥离危险字段，仅保留白名单字段 */
export function filterSettingsFields(raw: Record<string, any>): Record<string, any> {
  const SAFE_SETTINGS_FIELDS = new Set([
    'port', 'theme', 'bgImage', 'bgImages', 'bgMode', 'bgDir', 'bgInterval',
    'defaultProviders', 'glassEffect', 'updatedAt',
  ]);
  const DANGEROUS_SETTINGS_FIELDS = new Set([
    'allowedDirs', 'defaultDir', 'permissionLevel',
  ]);
  const filtered: Record<string, any> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (DANGEROUS_SETTINGS_FIELDS.has(key)) continue;
    if (SAFE_SETTINGS_FIELDS.has(key)) filtered[key] = value;
  }
  return filtered;
}

/** 设置相关路由 */
export function registerSettingsRoutes(app: FastifyInstance, config: BackendConfig): void {
  // ====== Settings ======
  app.get('/api/settings', { schema: { description: '获取设置', tags: ['数据'] } }, async () => {
    return getSettings();
  });

  // P0-12: 设置更新 — 限制可修改字段，防止 CSRF 提权 allowedDirs/permissionLevel
  // 危险字段（allowedDirs, permissionLevel, defaultDir）需单独的管理端点修改
  // P0-1 修复：补全 port 和 glassEffect，否则 Settings 保存会静默丢失这两个字段
  const SAFE_SETTINGS_FIELDS = new Set([
    'port', 'theme', 'bgImage', 'bgImages', 'bgMode', 'bgDir', 'bgInterval',
    'defaultProviders', 'glassEffect', 'updatedAt',
  ]);
  const DANGEROUS_SETTINGS_FIELDS = new Set([
    'allowedDirs', 'defaultDir', 'permissionLevel',
  ]);

  app.post('/api/settings', { schema: { description: '保存设置', tags: ['数据'] } }, async (request, reply) => {
    const body = (request.body as Record<string, any>) || {};
    // P0-12: 危险字段需要单独的管理端点，不允许通过通用 settings 修改
    // P0-2 修复：先检查危险字段拒绝，再用 filterSettingsFields 白名单过滤
    for (const key of Object.keys(body)) {
      if (DANGEROUS_SETTINGS_FIELDS.has(key)) {
        return reply.code(403).send({ error: `字段 "${key}" 不允许通过此端点修改，请使用专门的管理接口` });
      }
    }
    const filtered = filterSettingsFields(body);
    // P2 修复：超大 base64 背景图迁移为文件 — 避免 settings.json 内嵌 MB 级 data URL 导致读写性能劣化。
    // 超过 256KB 的 single bgImage 自动转存到 data/backgrounds/ 并替换为文件 URL。
    if (typeof filtered.bgImage === 'string' && filtered.bgImage.startsWith('data:image/') && filtered.bgImage.length > 256 * 1024) {
      try {
        const match = filtered.bgImage.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/);
        if (match) {
          const ext = match[1] === 'jpeg' ? 'jpg' : 'png';
          const name = `${randomUUID()}.${ext}`;
          const bgDir = resolve(config.dataDir, 'backgrounds');
          if (!existsSync(bgDir)) mkdirSync(bgDir, { recursive: true });
          writeFileSync(resolve(bgDir, name), Buffer.from(match[2], 'base64'));
          filtered.bgImage = `/data/backgrounds/${name}`;
        }
      } catch (e: unknown) {
        console.warn('[Data] 背景图迁移失败，保留原值:', e instanceof Error ? e.message : String(e));
      }
    }
    // P1-6 修复：bgImages 数组同样迁移 — 逐项将超大 base64 背景图转存为文件并替换为 URL，
    // 否则数组内嵌的 MB 级 data URL 仍会导致 settings.json 读写性能劣化
    if (Array.isArray(filtered.bgImages)) {
      filtered.bgImages = filtered.bgImages.map((img: unknown) => {
        if (typeof img !== 'string' || !img.startsWith('data:image/') || img.length <= 256 * 1024) return img;
        try {
          const match = img.match(/^data:image\/(png|jpeg|jpg);base64,(.+)$/);
          if (!match) return img;
          const ext = match[1] === 'jpeg' ? 'jpg' : 'png';
          const name = `${randomUUID()}.${ext}`;
          const bgDir = resolve(config.dataDir, 'backgrounds');
          if (!existsSync(bgDir)) mkdirSync(bgDir, { recursive: true });
          writeFileSync(resolve(bgDir, name), Buffer.from(match[2], 'base64'));
          return `/data/backgrounds/${name}`;
        } catch (e: unknown) {
          console.warn('[Data] 背景图迁移失败，保留原值:', e instanceof Error ? e.message : String(e));
          return img;
        }
      });
    }
    return saveSettings(filtered);
  });

  // P0-12: 专门的管理端点 — 修改 allowedDirs/defaultDir/permissionLevel
  app.post('/api/settings/security', { schema: { description: '修改安全相关设置', tags: ['数据'] } }, async (request, reply) => {
    const body = request.body as { allowedDirs?: string[]; defaultDir?: string; permissionLevel?: number };
    const settings = await getSettings();
    if (body.allowedDirs !== undefined) {
      // B1 修复：不再静默过滤不存在的路径 — 不存在的目录自动创建（mkdir -p），
      // 避免用户输入新目录被丢弃导致"修改不生效"；无法创建时返回明确错误。
      const validated: string[] = [];
      const errors: string[] = [];
      const raw = Array.isArray(body.allowedDirs) ? body.allowedDirs : [];
      for (const d of raw) {
        const resolved = resolve(d);
        if (!existsSync(resolved)) {
          try {
            mkdirSync(resolved, { recursive: true });
            validated.push(resolved);
          } catch (e: unknown) {
            errors.push(`${d}: 无法创建目录 ${e instanceof Error ? e.message : String(e)}`);
          }
        } else {
          validated.push(resolved);
        }
      }
      if (errors.length > 0) {
        return reply.code(400).send({ error: `部分目录不可用: ${errors.join('; ')}` });
      }
      settings.allowedDirs = validated;
    }
    // B2 修复：defaultDir 空串视为未设置（不再 resolve('')=cwd 触发误 400）
    if (body.defaultDir && settings.allowedDirs && settings.allowedDirs.length > 0) {
      const resolved = resolve(body.defaultDir);
      // 大小写不敏感比较（Windows 路径）
      const lower = resolved.toLowerCase();
      if (!settings.allowedDirs.some(d => d.toLowerCase() === lower)) {
        return reply.code(400).send({ error: 'defaultDir 必须在 allowedDirs 内' });
      }
      settings.defaultDir = resolved;
    }
    if (body.permissionLevel !== undefined) {
      settings.permissionLevel = body.permissionLevel === 1 ? 1 : 2;
    }
    await saveSettings(settings);
    return { success: true, allowedDirs: settings.allowedDirs, defaultDir: settings.defaultDir };
  });

  // ====== Default Providers ======
  app.get('/api/settings/default-providers', { schema: { description: '获取默认 Provider 配置', tags: ['数据'] } }, async () => {
    const settings = await getSettings();
    return settings.defaultProviders || {};
  });

  app.post('/api/settings/default-providers', { schema: { description: '设置默认 Provider 配置', tags: ['数据'] } }, async (request) => {
    const body = request.body as { image?: string; video?: string; text?: string; audio?: string };
    const settings = await getSettings();
    settings.defaultProviders = { ...settings.defaultProviders, ...body };
    await saveSettings(settings);
    return { success: true, defaultProviders: settings.defaultProviders };
  });
}