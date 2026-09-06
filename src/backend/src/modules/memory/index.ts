import type { FastifyInstance } from 'fastify';
import type { BackendConfig } from '../../config/index.js';
import { getDb, saveDb } from '../../db/client.js';
import { memories } from '../../db/schema/index.js';
import { eq, desc, like, or } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { AppError } from '@pacc/shared';
import { getProviderByCapability } from '../../lib/provider.js';
import { buildRuntimeForProvider } from '../../lib/model-runtime-bridge.js';

/** 记忆类型枚举（与 schema 一致） */
const MEMORY_TYPES = ['short_term', 'long_term', 'project'] as const;
type MemoryType = (typeof MEMORY_TYPES)[number];

/** AI 提取记忆的系统提示词 — 要求模型仅输出结构化 JSON */
const EXTRACT_SYSTEM_PROMPT = `你是一个记忆提取助手。从用户提供的内容中提取值得长期保留的关键信息，并按类型分类。

提取原则：
1. 只提取真正有价值的信息：用户偏好、个人事实、重要事件、项目细节、决策结论、关键数据
2. 忽略寒暄、无意义的日常对话、临时性问题
3. content 使用简体中文，完整、简洁、信息密度高（保留关键数字、名称、时间）
4. key 是便于检索的简短关键词（如「数据库连接串」「生日」）
5. tags 是 2-5 个描述性标签

类型定义：
- short_term：短期事实/上下文（如「当前正在做 X 项目」）
- long_term：长期偏好/个人信息/重要事实（如「喜欢深色主题」）
- project：项目相关信息（如「PACC 使用 sql.js 存储」）

返回格式（严格 JSON，不要输出任何其他内容、不要使用 markdown 代码块）：
{"memories":[{"type":"short_term|long_term|project","key":"简短关键词","content":"完整记忆内容","tags":["标签1","标签2"]}]}

没有值得提取的信息时返回：{"memories":[]}`;

/**
 * 解析模型输出的 JSON — 容错 markdown 代码围栏 / 前后杂音
 */
function parseMemoriesJson(text: string): { type: string; key: string; content: string; tags?: string[] }[] {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  let parsed: any = null;
  try {
    parsed = JSON.parse(cleaned);
  } catch {
    // 剥离前后杂音后重试
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start !== -1 && end > start) {
      try { parsed = JSON.parse(cleaned.slice(start, end + 1)); } catch { /* 仍失败则返回空 */ }
    }
  }
  const list = parsed?.memories;
  if (!Array.isArray(list)) return [];
  return list.filter((m: any) => m && typeof m === 'object' && typeof m.content === 'string');
}

/** 解析 tags 字段（DB 中为 JSON 字符串） */
function parseTags(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const t = JSON.parse(raw);
    return Array.isArray(t) ? t.filter((x: unknown) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** 归一化类型，非法值回退 short_term */
function normalizeType(type: string): MemoryType {
  return (MEMORY_TYPES as readonly string[]).includes(type) ? type as MemoryType : 'short_term';
}

export function registerMemoryRoutes(app: FastifyInstance, config: BackendConfig): void {
  const db = getDb();

  // 列表：全部记忆，createdAt DESC，可选 type 过滤
  app.get('/api/memory', {
    schema: {
      description: '获取记忆列表（按创建时间倒序，可选 type 过滤）',
      tags: ['记忆'],
      querystring: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['short_term', 'long_term', 'project'] },
        },
      },
    },
  }, async (request) => {
    const { type } = request.query as { type?: string };
    const rows = type
      ? db.select().from(memories).where(eq(memories.type, type as MemoryType)).orderBy(desc(memories.createdAt)).all()
      : db.select().from(memories).orderBy(desc(memories.createdAt)).all();
    return rows.map(r => ({ ...r, tags: parseTags(r.tags) }));
  });

  // 搜索：content/key/tags LIKE 匹配
  app.get('/api/memory/search', {
    schema: {
      description: '按关键词搜索记忆（LIKE 匹配 content/key/tags）',
      tags: ['记忆'],
      querystring: {
        type: 'object',
        required: ['q'],
        properties: { q: { type: 'string' } },
      },
    },
  }, async (request) => {
    const { q } = request.query as { q?: string };
    const query = (q || '').trim();
    if (!query) return [];
    const pattern = `%${query}%`;
    const rows = db.select().from(memories)
      .where(or(like(memories.content, pattern), like(memories.key, pattern), like(memories.tags, pattern)))
      .orderBy(desc(memories.createdAt))
      .all();
    return rows.map(r => ({ ...r, tags: parseTags(r.tags) }));
  });

  // 召回：根据上下文检索相关记忆（LIKE 相关度），取前 10 条
  app.get('/api/memory/recall', {
    schema: {
      description: '根据上下文召回相关记忆（LIKE 匹配，返回前 10 条）',
      tags: ['记忆'],
      querystring: {
        type: 'object',
        required: ['context'],
        properties: { context: { type: 'string' } },
      },
    },
  }, async (request) => {
    const { context } = request.query as { context?: string };
    const query = (context || '').trim();
    if (!query) return [];
    const pattern = `%${query}%`;
    const rows = db.select().from(memories)
      .where(or(like(memories.content, pattern), like(memories.key, pattern), like(memories.tags, pattern)))
      .orderBy(desc(memories.createdAt))
      .limit(10)
      .all();
    return rows.map(r => ({ ...r, tags: parseTags(r.tags) }));
  });

  // 提取：AI 抽取结构化记忆并持久化
  app.post('/api/memory/extract', {
    schema: {
      description: '使用 AI 从文本中提取结构化记忆并保存到 memories 表',
      tags: ['记忆'],
      body: {
        type: 'object',
        required: ['content'],
        properties: {
          content: { type: 'string' },
          conversationId: { type: 'string' },
        },
      },
    },
  }, async (request) => {
    const body = request.body as { content: string; conversationId?: string };
    const content = (body.content || '').trim();
    if (!content) throw AppError.validation('content 不能为空');

    const provider = getProviderByCapability('text', config.encryptionKey);
    if (!provider?.apiKey) throw AppError.internal('未配置 AI Provider 或 API Key。请在「AI Providers」页面配置后再试。');

    // 使用 ModelRuntime 替代直接 fetch
    const runtimeResult = buildRuntimeForProvider(db, provider.id, config.encryptionKey);
    if (!runtimeResult) throw AppError.internal('无法构建 ModelRuntime');
    const { runtime } = runtimeResult;

    const response = await runtime.complete({
      provider: provider.type,
      model: provider.defaultModel || 'gpt-4o',
      messages: [
        { role: 'system', content: EXTRACT_SYSTEM_PROMPT },
        { role: 'user', content: content.slice(0, 8000) },
      ],
      temperature: 0.3,
      maxTokens: 2048,
    });

    const rawText = response.content || '';
    const extracted = parseMemoriesJson(rawText);

    const now = new Date().toISOString();
    const saved: any[] = [];
    for (const m of extracted) {
      const memContent = (m.content || '').trim();
      if (!memContent) continue;
      const type = normalizeType(m.type);
      const key = (m.key || '').trim().slice(0, 100) || '未命名记忆';
      const tags = Array.isArray(m.tags) ? m.tags.filter((t: unknown) => typeof t === 'string').slice(0, 10) : [];
      const id = randomUUID();
      db.insert(memories).values({
        id,
        type,
        key,
        content: memContent,
        tags: JSON.stringify(tags),
        scope: 'user',
        importance: 0.5,
        createdAt: now,
        updatedAt: now,
      }).run();
      saved.push({ id, type, key, content: memContent, tags, createdAt: now, updatedAt: now });
    }

    // 显式持久化（与 conversations 模块一致）
    try { saveDb(config); } catch (e: unknown) { console.error('[Memory] 持久化失败:', (e instanceof Error ? e.message : String(e)) || e); }

    return { extracted: saved.length, memories: saved };
  });

  // 删除单条记忆
  app.delete('/api/memory/:id', {
    schema: {
      description: '删除单条记忆',
      tags: ['记忆'],
      params: { type: 'object', properties: { id: { type: 'string' } } },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const existing = db.select().from(memories).where(eq(memories.id, id)).get();
    if (!existing) throw AppError.notFound('记忆', id);
    db.delete(memories).where(eq(memories.id, id)).run();
    try { saveDb(config); } catch (e: unknown) { console.error('[Memory] 删除持久化失败:', (e instanceof Error ? e.message : String(e)) || e); }
    return { success: true };
  });
}
