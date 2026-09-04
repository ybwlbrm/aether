import type { FastifyInstance } from 'fastify';
import type { BackendConfig } from '../../config/index.js';
import { getDb, saveDb } from '../../db/client.js';
import { wikiPages, promptTemplates } from '../../db/schema/index.js';
import { eq, desc } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';

export function registerKnowledgeRoutes(app: FastifyInstance, config: BackendConfig): void {
  const db = getDb();

  // ====== Wiki Pages ======
  app.get('/api/knowledge/wiki', { schema: { description: '获取所有 Wiki 页面', tags: ['知识库'] } }, async () => {
    return db.select().from(wikiPages).orderBy(desc(wikiPages.updatedAt)).all();
  });

  app.post('/api/knowledge/wiki', { schema: { description: '创建 Wiki 页面', tags: ['知识库'] } }, async (request, reply) => {
    const body = request.body as { title: string; content?: string; category?: string };
    // P1 修复：标题必填校验，阻止空标题页面污染知识库
    if (!body.title || !String(body.title).trim()) {
      return reply.code(400).send({ error: '标题不能为空' });
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    const title = String(body.title).trim();
    db.insert(wikiPages).values({ id, title, content: body.content || '', category: body.category || '通用', createdAt: now, updatedAt: now }).run();
    saveDb(config);
    return { id, title, content: body.content || '', category: body.category || '通用', createdAt: now, updatedAt: now };
  });

  app.put('/api/knowledge/wiki/:id', { schema: { description: '更新 Wiki 页面', tags: ['知识库'] } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { title?: string; content?: string; category?: string };
    const existing = db.select().from(wikiPages).where(eq(wikiPages.id, id)).get();
    if (!existing) return reply.code(404).send({ error: '页面不存在' });
    // P1 修复：标题更新同样校验非空
    const newTitle = body.title !== undefined ? String(body.title).trim() : existing.title;
    if (!newTitle) return reply.code(400).send({ error: '标题不能为空' });
    const now = new Date().toISOString();
    db.update(wikiPages).set({
      title: newTitle,
      content: body.content !== undefined ? body.content : existing.content,
      category: body.category !== undefined ? body.category : existing.category,
      updatedAt: now,
    }).where(eq(wikiPages.id, id)).run();
    saveDb(config);
    const row = db.select().from(wikiPages).where(eq(wikiPages.id, id)).get()!;
    return row;
  });

  app.delete('/api/knowledge/wiki/:id', { schema: { description: '删除 Wiki 页面', tags: ['知识库'] } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = db.select().from(wikiPages).where(eq(wikiPages.id, id)).get();
    if (!existing) return reply.code(404).send({ error: '页面不存在' });
    db.delete(wikiPages).where(eq(wikiPages.id, id)).run();
    saveDb(config);
    return { success: true };
  });

  // ====== Prompt Templates ======
  app.get('/api/knowledge/templates', { schema: { description: '获取所有提示词模板', tags: ['知识库'] } }, async () => {
    return db.select().from(promptTemplates).orderBy(desc(promptTemplates.createdAt)).all();
  });

  app.post('/api/knowledge/templates', { schema: { description: '创建提示词模板', tags: ['知识库'] } }, async (request) => {
    const body = request.body as { name: string; content: string };
    const now = new Date().toISOString();
    const id = randomUUID();
    db.insert(promptTemplates).values({ id, name: body.name, content: body.content, createdAt: now }).run();
    saveDb(config);
    return { id, name: body.name, content: body.content, createdAt: now };
  });

  app.put('/api/knowledge/templates/:id', { schema: { description: '更新提示词模板', tags: ['知识库'] } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const body = request.body as { name?: string; content?: string };
    const existing = db.select().from(promptTemplates).where(eq(promptTemplates.id, id)).get();
    if (!existing) return reply.code(404).send({ error: '模板不存在' });
    db.update(promptTemplates).set({
      name: body.name !== undefined ? body.name : existing.name,
      content: body.content !== undefined ? body.content : existing.content,
    }).where(eq(promptTemplates.id, id)).run();
    saveDb(config);
    return db.select().from(promptTemplates).where(eq(promptTemplates.id, id)).get();
  });

  app.delete('/api/knowledge/templates/:id', { schema: { description: '删除提示词模板', tags: ['知识库'] } }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const existing = db.select().from(promptTemplates).where(eq(promptTemplates.id, id)).get();
    if (!existing) return reply.code(404).send({ error: '模板不存在' });
    db.delete(promptTemplates).where(eq(promptTemplates.id, id)).run();
    saveDb(config);
    return { success: true };
  });
}