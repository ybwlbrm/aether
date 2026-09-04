import type { FastifyInstance } from 'fastify';
import type { BackendConfig } from '../../config/index.js';
import { getDb, saveDb } from '../../db/client.js';
import { providers, conversations, messages } from '../../db/schema/index.js';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { CreateProviderSchema, UpdateProviderSchema, AppError } from '@pacc/shared';
import { encrypt as encryptKey, decrypt as decryptKey } from '../../lib/crypto.js';
import { isSafeFetchUrl } from '../../lib/safe-fetch.js';

// P1-7 修复：数据库中的 models/capabilities 是 JSON 字符串，健壮解析避免非法 JSON 导致 500
function parseJsonArray(value: string | null, fallback: string[] = []): string[] {
  if (!value) return fallback;
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

export function registerProviderRoutes(app: FastifyInstance, config: BackendConfig): void {
  const db = getDb();

  // 获取所有 Provider
  app.get('/api/providers', {
    schema: {
      description: '获取所有 AI Provider 配置',
      tags: ['AI Provider'],
    },
  }, async () => {
    const result = db.select().from(providers).all();
    return result.map(p => ({
      ...p,
      models: parseJsonArray(p.models, [p.models].filter(Boolean)),
      capabilities: parseJsonArray(p.capabilities, ['text']),
      apiKey: '***encrypted***',
    }));
  });

  // 获取单个 Provider
  app.get('/api/providers/:id', {
    schema: {
      description: '获取单个 AI Provider',
      tags: ['AI Provider'],
      params: { type: 'object', properties: { id: { type: 'string' } } },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const result = db.select().from(providers).where(eq(providers.id, id)).get();
    if (!result) throw AppError.notFound('Provider', id);
    return {
      ...result,
      models: parseJsonArray(result.models, [result.models].filter(Boolean)),
      capabilities: parseJsonArray(result.capabilities, ['text']),
      apiKey: '***encrypted***',
    };
  });

  // 创建 Provider
  app.post('/api/providers', {
    schema: {
      description: '创建新的 AI Provider',
      tags: ['AI Provider'],
      body: {
        type: 'object',
        required: ['name', 'type', 'apiKey', 'models'],
        properties: {
          name: { type: 'string' },
          type: { type: 'string' },
          apiKey: { type: 'string' },
          baseUrl: { type: 'string' },
          models: { type: 'array', items: { type: 'string' } },
          capabilities: { type: 'array', items: { type: 'string', enum: ['text', 'image', 'video', 'audio'] } },
          isDefault: { type: 'boolean' },
        },
      },
    },
  }, async (request) => {
    const body = CreateProviderSchema.parse(request.body);
    // SSRF 防护：校验 baseUrl（若提供）
    if (body.baseUrl && body.baseUrl.trim() && !isSafeFetchUrl(body.baseUrl.trim())) {
      throw AppError.validation('baseUrl 存在 SSRF 风险：禁止访问链路本地/元数据地址或非 http(s) 协议');
    }
    const now = new Date().toISOString();
    const id = randomUUID();

    const data = {
      id,
      name: body.name,
      type: body.type,
      apiKey: encryptKey(body.apiKey, config.encryptionKey), // AES-256-GCM 加密存储
      baseUrl: (body.baseUrl || '').trim() || null, // 去除首尾空格
      models: JSON.stringify(body.models),
      capabilities: JSON.stringify(body.capabilities),
      isDefault: body.isDefault || false,
      createdAt: now,
      updatedAt: now,
    };

    db.insert(providers).values(data).run();
    return { ...data, apiKey: '***encrypted***', models: body.models, capabilities: body.capabilities };
  });

  // 更新 Provider
  app.put('/api/providers/:id', {
    schema: {
      description: '更新 AI Provider',
      tags: ['AI Provider'],
      params: { type: 'object', properties: { id: { type: 'string' } } },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const existing = db.select().from(providers).where(eq(providers.id, id)).get();
    if (!existing) throw AppError.notFound('Provider', id);

    const body = UpdateProviderSchema.parse(request.body);
    // SSRF 防护：校验 baseUrl（若提供）
    if (body.baseUrl !== undefined && body.baseUrl && body.baseUrl.trim() && !isSafeFetchUrl(body.baseUrl.trim())) {
      throw AppError.validation('baseUrl 存在 SSRF 风险：禁止访问链路本地/元数据地址或非 http(s) 协议');
    }
    const update: Record<string, unknown> = { updatedAt: new Date().toISOString() };
    if (body.name) update.name = body.name;
    if (body.type) update.type = body.type;
    if (body.apiKey) update.apiKey = encryptKey(body.apiKey, config.encryptionKey);
    if (body.baseUrl !== undefined) update.baseUrl = body.baseUrl.trim() || null;
    if (body.models) update.models = JSON.stringify(body.models);
    if (body.capabilities) update.capabilities = JSON.stringify(body.capabilities);
    if (body.isDefault !== undefined) update.isDefault = body.isDefault;

    db.update(providers).set(update).where(eq(providers.id, id)).run();
    const result = db.select().from(providers).where(eq(providers.id, id)).get();
    return {
      ...result,
      apiKey: '***encrypted***',
      models: result ? parseJsonArray(result.models, []) : [],
      capabilities: parseJsonArray(result?.capabilities || null, ['text']),
    };
  });

  // 删除 Provider（级联删除关联的对话和消息）
  app.delete('/api/providers/:id', {
    schema: {
      description: '删除 AI Provider（级联删除关联对话）',
      tags: ['AI Provider'],
      params: { type: 'object', properties: { id: { type: 'string' } } },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const existing = db.select().from(providers).where(eq(providers.id, id)).get();
    if (!existing) throw AppError.notFound('Provider', id);
    try {
      // 级联删除关联的对话和消息（避免外键约束错误）
      const convs = db.select().from(conversations).where(eq(conversations.providerId, id)).all();
      for (const conv of convs) {
        db.delete(messages).where(eq(messages.conversationId, conv.id)).run();
        db.delete(conversations).where(eq(conversations.id, conv.id)).run();
      }
      db.delete(providers).where(eq(providers.id, id)).run();
      try { saveDb(config); } catch (e: unknown) { console.error('[Providers] 保存失败:', (e instanceof Error ? e.message : String(e)) || e); }
      return { success: true };
    } catch (e: unknown) {
      console.error('[Providers] 删除失败:', (e instanceof Error ? e.message : String(e)) || e);
      throw e;
    }
  });

  // P0-11: 获取 Provider 详情 — 不返回明文 API Key，仅返回 masked
  app.get('/api/providers/:id/detail', {
    schema: {
      description: '获取 Provider 详情（API Key 脱敏显示）',
      tags: ['AI Provider'],
      params: { type: 'object', properties: { id: { type: 'string' } } },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const result = db.select().from(providers).where(eq(providers.id, id)).get();
    if (!result) throw AppError.notFound('Provider', id);
    const plainKey = decryptKey(result.apiKey, config.encryptionKey);
    // P0-11: 仅返回 masked key，前 4 + 后 4 字符
    const masked = plainKey.length > 12
      ? `${plainKey.slice(0, 4)}${'•'.repeat(Math.max(4, plainKey.length - 8))}${plainKey.slice(-4)}`
      : '•'.repeat(Math.min(plainKey.length, 8));
    return {
      id: result.id,
      name: result.name,
      type: result.type,
      apiKey: masked,        // P0-11: masked，不再返回明文
      apiKeyLength: plainKey.length,
      baseUrl: result.baseUrl,
      models: parseJsonArray(result.models, []),
      capabilities: parseJsonArray(result.capabilities, ['text']),
      isDefault: result.isDefault,
      createdAt: result.createdAt,
      updatedAt: result.updatedAt,
    };
  });

  // P2-12 修复：明文 API Key 端点 — 加掩码返回，前端通过专用 reveal 端点 + X-Requested-With 才能获取明文
  // 改为仅在 POST 请求（需 CSRF header）时返回明文，GET 请求返回掩码
  app.get('/api/providers/:id/apikey', {
    schema: {
      description: '获取 Provider API Key（掩码显示）',
      tags: ['AI Provider'],
      params: { type: 'object', properties: { id: { type: 'string' } } },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const result = db.select().from(providers).where(eq(providers.id, id)).get();
    if (!result) throw AppError.notFound('Provider', id);
    const plainKey = decryptKey(result.apiKey, config.encryptionKey);
    // 返回掩码：前4位 + •••• + 后4位
    const masked = plainKey.length > 12
      ? plainKey.slice(0, 4) + '•'.repeat(Math.max(4, plainKey.length - 8)) + plainKey.slice(-4)
      : '•'.repeat(plainKey.length);
    return { apiKey: masked, full: false };
  });

  // P2-12 修复：明文 Key 只通过 POST（需 X-Requested-With CSRF header）获取
  app.post('/api/providers/:id/apikey', {
    schema: {
      description: '获取 Provider 明文 API Key（需 CSRF header）',
      tags: ['AI Provider'],
      params: { type: 'object', properties: { id: { type: 'string' } } },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const result = db.select().from(providers).where(eq(providers.id, id)).get();
    if (!result) throw AppError.notFound('Provider', id);
    return { apiKey: decryptKey(result.apiKey, config.encryptionKey), full: true };
  });

  // 测试连接
  app.post('/api/providers/:id/test', {
    schema: {
      description: '测试 Provider 连接，返回状态码和额度信息',
      tags: ['AI Provider'],
      params: { type: 'object', properties: { id: { type: 'string' } } },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const provider = db.select().from(providers).where(eq(providers.id, id)).get();
    if (!provider) throw AppError.notFound('Provider', id);
    // SSRF 防护：校验 baseUrl（若存在）
    if (provider.baseUrl && !isSafeFetchUrl(provider.baseUrl)) {
      return {
        success: false,
        statusCode: 0,
        statusText: '安全拦截',
        message: 'Provider baseUrl 存在 SSRF 风险：禁止访问链路本地/元数据地址或非 http(s) 协议',
        quotaStatus: '❌ baseUrl 不安全',
      };
    }
    // P0-2 修复：解密 API Key 后再用于测试连接，避免用密文导致永远 401
    const plainKey = decryptKey(provider.apiKey, config.encryptionKey);
    try {
      const response = await fetch(`${provider.baseUrl?.replace(/\/$/, '') || 'https://api.openai.com/v1'}/models`, {
        headers: { 'Authorization': `Bearer ${plainKey}` },
        signal: AbortSignal.timeout(5000),
      });

      // 限流/额度信息
      const rateLimit = {
        remaining: response.headers.get('x-ratelimit-remaining') || '未知',
        limit: response.headers.get('x-ratelimit-limit') || '未知',
        reset: response.headers.get('x-ratelimit-reset') || '未知',
      };

      // 从响应体获取额度/余额信息
      let bodyDetail = '';
      let bodyJson: any = null;
      try {
        bodyJson = await response.json();
        if (bodyJson?.error?.message) bodyDetail = bodyJson.error.message;
        if (bodyJson?.error?.code) bodyDetail += ` (${bodyJson.error.code})`;
        // 检查余额/额度字段（不同 Provider 字段名不同）
        if (bodyJson?.data?.credits) bodyDetail = `余额: ${bodyJson.data.credits}`;
        if (bodyJson?.credits) bodyDetail = `余额: ${bodyJson.credits}`;
        if (bodyJson?.balance) bodyDetail = `余额: ${bodyJson.balance}`;
        if (bodyJson?.remaining_credits) bodyDetail = `剩余额度: ${bodyJson.remaining_credits}`;
      } catch { /* 忽略解析失败 */ }

      // 判断额度状态
      let quotaStatus = '正常';
      if (response.status === 429) {
        quotaStatus = '⚠️ 请求超限（429），请降低调用频率';
      } else if (response.status === 401) {
        quotaStatus = '❌ API Key 无效或已过期';
      } else if (response.status === 402) {
        quotaStatus = '❌ 账户余额不足';
      } else if (response.status === 403) {
        quotaStatus = '❌ 无权限访问该模型';
      } else if (response.status === 500 || response.status === 502 || response.status === 503) {
        quotaStatus = '❌ 服务端错误，请稍后重试';
      } else if (response.ok) {
        const remaining = parseInt(rateLimit.remaining);
        if (!isNaN(remaining) && remaining < 10) {
          quotaStatus = `⚠️ 额度即将用尽（剩余 ${remaining} 次）`;
        } else if (!isNaN(remaining) && remaining < 100) {
          quotaStatus = `⚠️ 额度较低（剩余 ${remaining} 次）`;
        }
      }

      return {
        success: response.ok,
        statusCode: response.status,
        statusText: response.statusText,
        message: response.ok ? '连接成功' : `API 返回错误: ${response.status} ${response.statusText}`,
        bodyDetail: bodyDetail || undefined,
        quotaStatus,
        rateLimit,
      };
    } catch (e: unknown) {
      return {
        success: false,
        statusCode: 0,
        statusText: '网络错误',
        message: `连接失败: ${(e instanceof Error ? e.message : String(e))}`,
        quotaStatus: '❌ 无法连接服务器',
      };
    }
  });
}