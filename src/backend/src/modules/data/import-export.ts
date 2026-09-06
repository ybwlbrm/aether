import type { FastifyInstance } from 'fastify';
import type { BackendConfig } from '../../config/index.js';
import { getDb, saveDb } from '../../db/client.js';
import { providers, projects, conversations, messages, mediaAssets, documents } from '../../db/schema/index.js';
import { eq, desc } from 'drizzle-orm';
import { encrypt } from '../../lib/crypto.js';
import { resolve } from 'node:path';
import { getSettings, saveSettings } from '../../lib/dal.js';
import { isPathInAllowedDirs } from './utils.js';
import { filterSettingsFields } from './settings.js';
import { assertSafeFetchUrl } from '../../lib/safe-fetch.js';

/** 导入导出相关路由 */
export function registerImportExportRoutes(app: FastifyInstance, config: BackendConfig): void {
  // ====== 一键导出 / 导入（数据备份） ======

  // 导出全部用户数据（SQLite 表 + settings.json）
  app.get('/api/export/all', { schema: { description: '导出全部用户数据', tags: ['数据'] } }, async () => {
    const db = getDb();
    const providerRows = db.select().from(providers).all();
    const projectRows = db.select().from(projects).all();
    const conversationRows = db.select().from(conversations).all();
    const mediaRows = db.select().from(mediaAssets).all();
    const documentRows = db.select().from(documents).all();
    const settings = await getSettings();

    // 每个对话附带其全部消息（按时间排序）
    const conversationsWithMessages = conversationRows.map(c => ({
      ...c,
      messages: db.select().from(messages).where(eq(messages.conversationId, c.id)).orderBy(messages.createdAt).all(),
    }));

    // P0-4: 导出时脱敏 apiKey — 不泄露密文（密钥可推导）
    const providersSanitized = providerRows.map(p => ({ ...p, apiKey: '***encrypted***' }));

    return {
      providers: providersSanitized,
      projects: projectRows,
      conversations: conversationsWithMessages,
      media: mediaRows,
      documents: documentRows,
      settings,
    };
  });

  // 导入全部用户数据（幂等：按 id upsert，重复导入结果一致）
  app.post('/api/import/all', { schema: { description: '导入全部用户数据', tags: ['数据'] } }, async (request) => {
    const body = request.body as any;
    const db = getDb();
    const importedCounts = {
      providers: 0,
      projects: 0,
      conversations: 0,
      messages: 0,
      media: 0,
      documents: 0,
      settings: 0,
    };
    const skipped: string[] = [];
    // P1-5 修复：媒体/文档文件由系统生成并存储在 dataDir 子目录（data/media、data/documents），
    // 导入校验需将这些自产目录一并视为安全，否则系统自身导出的备份无法重新导入
    // B3 修复：合并动态 settings.allowedDirs（统一数据源）
    const importSettings = await getSettings().catch(() => null);
    const importDynDirs = (importSettings?.allowedDirs || []).map((d: string) => resolve(d));
    const importSafeDirs = [
      ...config.allowedDirs,
      ...importDynDirs,
      resolve(config.dataDir, 'media'),
      resolve(config.dataDir, 'documents'),
    ];

    // 1. Providers — upsert by id（先导入，保证 conversations 外键可解析）
    if (Array.isArray(body.providers)) {
      for (const p of body.providers) {
        if (!p?.id) continue;
        // Wave0-IM (P1-28): 导入 Provider 与创建/更新端点一致执行 SSRF 校验 ——
        // 否则恶意导入文件可写入内网 baseUrl，绕过 POST /api/providers 的检查。
        if (typeof p.baseUrl === 'string' && p.baseUrl.trim() !== '') {
          try {
            assertSafeFetchUrl(p.baseUrl.trim());
          } catch {
            skipped.push(`providers:${p.id} (baseUrl 存在 SSRF 风险，已跳过)`);
            continue;
          }
        }
        const now = new Date().toISOString();
        // P0-4: 导出的 apiKey 已脱敏为 ***encrypted*** — 跳过 apiKey 更新保留 existing
        // 真实明文值则用 encrypt 加密存储
        const existing = db.select().from(providers).where(eq(providers.id, p.id)).get();
        let apiKeyValue: string;
        if (!p.apiKey || p.apiKey === '***encrypted***') {
          // 保留 existing 的 apiKey（导出脱敏场景）
          apiKeyValue = existing?.apiKey ?? '';
        } else if (p.apiKey.startsWith('enc:')) {
          // 已是加密格式，原样保留
          apiKeyValue = p.apiKey;
        } else {
          // 真实明文值，加密存储
          apiKeyValue = encrypt(p.apiKey, config.encryptionKey);
        }
        const data = {
          name: p.name ?? '',
          type: p.type ?? 'custom',
          apiKey: apiKeyValue,
          baseUrl: p.baseUrl ?? null,
          models: typeof p.models === 'string' ? p.models : JSON.stringify(p.models ?? []),
          capabilities: typeof p.capabilities === 'string' ? p.capabilities : JSON.stringify(p.capabilities ?? ['text']),
          isDefault: p.isDefault ?? false,
          createdAt: p.createdAt ?? now,
          updatedAt: p.updatedAt ?? now,
        };
        if (existing) {
          db.update(providers).set(data).where(eq(providers.id, p.id)).run();
        } else {
          db.insert(providers).values({ id: p.id, ...data }).run();
        }
        importedCounts.providers++;
      }
    }

    // 2. Projects — upsert by id
    if (Array.isArray(body.projects)) {
      for (const pr of body.projects) {
        if (!pr?.id) continue;
        const now = new Date().toISOString();
        const data = {
          name: pr.name ?? '',
          description: pr.description ?? '',
          cover: pr.cover ?? null,
          screenshots: typeof pr.screenshots === 'string' ? pr.screenshots : JSON.stringify(pr.screenshots ?? []),
          techStack: typeof pr.techStack === 'string' ? pr.techStack : JSON.stringify(pr.techStack ?? []),
          links: typeof pr.links === 'string' ? pr.links : JSON.stringify(pr.links ?? []),
          github: pr.github ?? null,
          createdAt: pr.createdAt ?? now,
          updatedAt: pr.updatedAt ?? now,
        };
        const existing = db.select().from(projects).where(eq(projects.id, pr.id)).get();
        if (existing) {
          db.update(projects).set(data).where(eq(projects.id, pr.id)).run();
        } else {
          db.insert(projects).values({ id: pr.id, ...data }).run();
        }
        importedCounts.projects++;
      }
    }

    // 3. Conversations + Messages — upsert by id，消息整体重建（幂等）
    // BE-06 fix: per-conversation transaction so each conversation+messages is atomic independently.
    // sql.js/SQLite does not support nested transactions; no outer transaction exists here.
    if (Array.isArray(body.conversations)) {
      for (const c of body.conversations) {
        if (!c?.id) continue;
        const now = new Date().toISOString();
        // 外键保护：provider 不存在时跳过该对话（避免外键约束错误）
        const providerExists = db.select().from(providers).where(eq(providers.id, c.providerId)).get();
        if (!providerExists) {
          skipped.push(`conversation:${c.id} (provider ${c.providerId} 不存在)`);
          continue;
        }
        // Each conversation + its messages in its own transaction for atomicity
        db.transaction((tx) => {
          const convData = {
            title: c.title ?? '新对话',
            providerId: c.providerId,
            model: c.model ?? '',
            createdAt: c.createdAt ?? now,
            updatedAt: c.updatedAt ?? now,
          };
          const existing = tx.select().from(conversations).where(eq(conversations.id, c.id)).get();
          if (existing) {
            tx.update(conversations).set(convData).where(eq(conversations.id, c.id)).run();
            // 重建消息：先删旧消息再插入，保证重复导入结果一致
            tx.delete(messages).where(eq(messages.conversationId, c.id)).run();
          } else {
            tx.insert(conversations).values({ id: c.id, ...convData }).run();
          }
          importedCounts.conversations++;
          // 插入消息
          const msgs = Array.isArray(c.messages) ? c.messages : [];
          for (const m of msgs) {
            if (!m?.id) continue;
            tx.insert(messages).values({
              id: m.id,
              conversationId: c.id,
              role: m.role ?? 'user',
              content: m.content ?? '',
              toolCalls: m.toolCalls ?? null,
              toolResults: m.toolResults ?? null,
              createdAt: m.createdAt ?? now,
            }).run();
            importedCounts.messages++;
          }
        });
      }
    }

    // 4. Media — upsert by id
    if (Array.isArray(body.media)) {
      for (const m of body.media) {
        if (!m?.id) continue;
        // P0-8: 路径穿越防护 — 导入的 path 必须在 allowedDirs 或 dataDir 自产子目录内
        if (m.path && !isPathInAllowedDirs(m.path, importSafeDirs)) {
          skipped.push(`media:${m.id} (path 不在允许目录内)`);
          continue;
        }
        const now = new Date().toISOString();
        const data = {
          type: m.type ?? 'image',
          name: m.name ?? '',
          path: m.path ?? '',
          mimeType: m.mimeType ?? 'application/octet-stream',
          size: m.size ?? 0,
          metadata: typeof m.metadata === 'string' ? m.metadata : JSON.stringify(m.metadata ?? {}),
          createdAt: m.createdAt ?? now,
        };
        const existing = db.select().from(mediaAssets).where(eq(mediaAssets.id, m.id)).get();
        if (existing) {
          db.update(mediaAssets).set(data).where(eq(mediaAssets.id, m.id)).run();
        } else {
          db.insert(mediaAssets).values({ id: m.id, ...data }).run();
        }
        importedCounts.media++;
      }
    }

    // 5. Documents — upsert by id
    if (Array.isArray(body.documents)) {
      for (const d of body.documents) {
        if (!d?.id) continue;
        // P0-8: 路径穿越防护 — 导入的 path 必须在 allowedDirs 或 dataDir 自产子目录内
        if (d.path && !isPathInAllowedDirs(d.path, importSafeDirs)) {
          skipped.push(`document:${d.id} (path 不在允许目录内)`);
          continue;
        }
        const now = new Date().toISOString();
        const data = {
          type: d.type ?? 'doc',
          name: d.name ?? '',
          path: d.path ?? null,
          status: d.status ?? 'draft',
          createdAt: d.createdAt ?? now,
          updatedAt: d.updatedAt ?? now,
        };
        const existing = db.select().from(documents).where(eq(documents.id, d.id)).get();
        if (existing) {
          db.update(documents).set(data).where(eq(documents.id, d.id)).run();
        } else {
          db.insert(documents).values({ id: d.id, ...data }).run();
        }
        importedCounts.documents++;
      }
    }

    // 6. Settings — 合并保存到 settings.json
    // P0-2 修复：导入接口也要走安全字段过滤，否则可绕过 /api/settings 提权 allowedDirs/permissionLevel
    if (body.settings && typeof body.settings === 'object') {
      const filteredSettings = filterSettingsFields(body.settings as Record<string, any>);
      await saveSettings(filteredSettings);
      importedCounts.settings = 1;
    }

    // 显式持久化数据库（onResponse 钩子也会保存，此处确保导入立即落盘）
    try { saveDb(config); } catch (e: unknown) { console.error('[Data] 导入持久化失败:', (e instanceof Error ? e.message : String(e)) || e); }

    return { success: true, importedCounts, skipped };
  });
}