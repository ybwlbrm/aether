import type { FastifyInstance } from 'fastify';
import type { BackendConfig } from '../../config/index.js';
import { getDb, saveDb } from '../../db/client.js';
import { conversations, messages, providers, mcpServers } from '../../db/schema/index.js';
import { eq, desc, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { AppError } from '@pacc/shared';
import { getProviderByCapability } from '../../lib/provider.js';
import { createEventBus } from '../../lib/event-bus.js';
import { getSyncClient } from '../../lib/supabase-sync.js';
import { pushDirective, drainDirectives } from '../../lib/inbox.js';
import { handleSendMessage } from './chat-handler.js';
import { activeRequests } from './state.js';
import { deleteConversationCascade } from './delete-conversation.js';

/**
 * 注册所有对话相关路由
 */
export function registerConversationRoutes(app: FastifyInstance, config: BackendConfig): void {
  const db = getDb();

  // 系统提示词统一收敛于 lib/system-prompts.ts（消除 agents/conversations 重复定义）

  // 获取所有对话
  app.get('/api/conversations', {
    schema: { description: '获取所有对话列表', tags: ['对话'] },
  }, async () => {
    const convs = db.select().from(conversations).orderBy(desc(conversations.updatedAt)).all();
    // PF-01: 直接使用 conversations.token_total 列，避免 N+1 全表扫描聚合
    return convs.map((c) => ({ ...c, tokenTotal: c.tokenTotal ?? 0 }));
  });

  // 获取单个对话
  app.get('/api/conversations/:id', {
    schema: {
      description: '获取对话详情',
      tags: ['对话'],
      params: { type: 'object', properties: { id: { type: 'string' } } },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const conv = db.select().from(conversations).where(eq(conversations.id, id)).get();
    if (!conv) throw AppError.notFound('对话', id);
    const msgs = db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(messages.createdAt).all();
    // PF-01: 直接使用 conversations.token_total 列
    return { ...conv, messages: msgs, tokenTotal: conv.tokenTotal ?? 0 };
  });

  // 获取对话的 Agent Activity Event 回溯（回放：刷新/断线恢复 Activity Stream）
  // 支持 afterSeq：只返回该 seq 之后的事件（Last-Event-ID 风格增量 catch-up）
  app.get('/api/conversations/:id/events', {
    schema: {
      description: '获取对话的 Agent Activity 事件（按 seq 升序，支持 afterSeq 增量回放）',
      tags: ['对话'],
      params: { type: 'object', properties: { id: { type: 'string' } } },
      querystring: {
        type: 'object',
        properties: {
          afterSeq: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1, maximum: 5000 },
        },
      },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const query = request.query as { afterSeq?: number; limit?: number };
    const conv = db.select().from(conversations).where(eq(conversations.id, id)).get();
    if (!conv) throw AppError.notFound('对话', id);
    const bus = createEventBus(db, undefined, () => saveDb(config));
    const afterSeq = typeof query.afterSeq === 'number' && query.afterSeq >= 0 ? query.afterSeq : 0;
    const events = bus.listEventsAfter(id, afterSeq, query.limit ?? 2000);
    return { events };
  });

  // 获取对话生成状态（前端切换页面后恢复动画用）
  app.get('/api/conversations/:id/status', {
    schema: {
      description: '获取对话生成状态（内存 + 数据库持久化）',
      tags: ['对话'],
      params: { type: 'object', properties: { id: { type: 'string' } } },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const inMemory = activeRequests.has(id);
    // 如果内存中有活跃请求，确保 DB 状态同步
    if (inMemory) {
      db.update(conversations).set({ generationStatus: 'generating', updatedAt: new Date().toISOString() }).where(eq(conversations.id, id)).run();
      return { generating: true, generationStatus: 'generating' };
    }
    // 内存中没有时，检查 DB 持久化状态
    const conv = db.select().from(conversations).where(eq(conversations.id, id)).get();
    if (conv && conv.generationStatus === 'generating') {
      // 发现数据库标记为 generating 但内存中无活跃请求 → 之前的生成已中断
      db.update(conversations).set({ generationStatus: 'interrupted', updatedAt: new Date().toISOString() }).where(eq(conversations.id, id)).run();
      return { generating: false, generationStatus: 'interrupted', message: '上次生成已中断，部分结果已保存。你可以继续发消息。' };
    }
    return { generating: false, generationStatus: conv?.generationStatus || 'idle' };
  });

  // 创建新对话
  app.post('/api/conversations', {
    schema: {
      description: '创建新对话',
      tags: ['对话'],
      body: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          providerId: { type: 'string' },
          model: { type: 'string' },
        },
      },
    },
  }, async (request, reply) => {
    const body = request.body as { title?: string; providerId?: string; model?: string };
    // P0-5 修复：schema 未标记 required + DB 列为 NOT NULL → 缺 providerId 时 500
    // 改为显式校验并返回友好 400（同时兼容旧前端：未传时尝试自动选择默认 provider）
    let providerId = body.providerId;
    let model = body.model;
    if (!providerId) {
      const fallback = getProviderByCapability('text', config.encryptionKey);
      if (fallback) {
        providerId = fallback.id;
        model = body.model || fallback.defaultModel;
      } else {
        return reply.code(400).send({ error: { message: '缺少 providerId，且未配置可用的 AI Provider' } });
      }
    }
    const now = new Date().toISOString();
    const id = randomUUID();
    db.insert(conversations).values({
      id,
      title: body.title || '新对话',
      providerId,
      model: model || '',
      createdAt: now,
      updatedAt: now,
    }).run();
    return db.select().from(conversations).where(eq(conversations.id, id)).get();
  });

  // 发送消息（流式 SSE，使用真实AI API，注入 active memories）
  app.post('/api/conversations/:id/messages', {
    schema: {
      description: '发送消息并流式获取AI响应（SSE）',
      tags: ['对话'],
      params: { type: 'object', properties: { id: { type: 'string' } } },
    },
  }, async (request, reply) => {
    return handleSendMessage(request, reply, { app, config, db });
  });

  // 重命名对话
  app.put('/api/conversations/:id', {
    schema: {
      description: '重命名对话',
      tags: ['对话'],
      params: { type: 'object', properties: { id: { type: 'string' } } },
      body: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const { title } = request.body as { title: string };
    const trimmed = title.trim();
    if (!trimmed) return { error: '标题不能为空' };
    db.update(conversations).set({ title: trimmed, updatedAt: new Date().toISOString() }).where(eq(conversations.id, id)).run();
    try { saveDb(config); } catch (e: unknown) { console.error('[Conversations] 重命名持久化失败:', (e instanceof Error ? e.message : String(e)) || e); }
    // A4 修复：重命名同步到 Supabase（手机端实时看到新标题）
    try {
      const { sb, cfg } = getSyncClient();
      if (sb && cfg) {
        await sb.from('conversations_sync').update({ title: trimmed, updated_at: new Date().toISOString() }).eq('id', id);
      }
    } catch (e: unknown) { console.warn('[Conversations] 重命名同步 Supabase 失败:', (e instanceof Error ? e.message : String(e)) || e); }
    return { success: true, id, title: trimmed };
  });

  // 删除对话
  app.delete('/api/conversations/:id', {
    schema: {
      description: '删除对话',
      tags: ['对话'],
      params: { type: 'object', properties: { id: { type: 'string' } } },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    // P0-21: 先中止该对话仍在进行的生成，避免 SSE 续写已删除的 conversation
    const controller = activeRequests.get(id);
    if (controller) {
      controller.abort();
      activeRequests.delete(id);
    }
    // P0-21: 按 FK 依赖顺序级联删除全部关联行（tasks/events/activity_events/messages/runs → conversations），
    // 否则 sql.js 抛 FOREIGN KEY constraint failed
    deleteConversationCascade(db, id);
    try { saveDb(config); } catch (e: unknown) { console.error('[Conversations] 删除持久化失败:', (e instanceof Error ? e.message : String(e)) || e); }
    // A4 修复：删除同步到 Supabase（手机端不再看到已删除的"幽灵对话"）
    try {
      const { sb, cfg } = getSyncClient();
      if (sb && cfg) {
        // 先删 messages_sync（级联），再删 conversations_sync
        await sb.from('messages_sync').delete().eq('conversation_id', id);
        await sb.from('conversations_sync').delete().eq('id', id);
      }
    } catch (e: unknown) { console.warn('[Conversations] 删除同步 Supabase 失败:', (e instanceof Error ? e.message : String(e)) || e); }
    return { success: true };
  });

  // 取消正在进行的 AI 生成请求
  app.post('/api/conversations/:id/cancel', {
    schema: {
      description: '取消正在进行的 AI 生成',
      tags: ['对话'],
      params: { type: 'object', properties: { id: { type: 'string' } } },
    },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const controller = activeRequests.get(id);
    if (controller) {
      controller.abort();
      activeRequests.delete(id);
      // 统一协议：task.cancelled（落库，刷新后 Activity Stream 可见）
      try {
        const bus = createEventBus(db, undefined, () => saveDb(config));
        bus.emit(id, 'task.cancelled', {
          taskId: id,
          agentId: 'main',
          agentType: 'conversation',
          status: 'cancelled',
          content: '已取消',
        });
      } catch { /* 忽略 cancel 事件落库失败 */ }
      return { success: true, message: '已取消生成' };
    }
    return { success: false, message: '没有正在进行的生成' };
  });

  // inbox 指令（steer/followup）：任务运行中的补充指令 → 队列，下一轮 fc-loop 前注入
  app.post('/api/conversations/:id/directive', {
    schema: {
      description: '向正在运行的任务补充指令（inbox steer/followup 语义，下一轮生效）',
      tags: ['对话'],
      params: { type: 'object', properties: { id: { type: 'string' } } },
      body: { type: 'object', properties: { content: { type: 'string', minLength: 1, maxLength: 5000 } }, required: ['content'] },
    },
  }, async (request, reply) => {
    const { id } = request.params as { id: string };
    const { content } = request.body as { content: string };
    // 会话必须存在
    const conv = db.select().from(conversations).where(eq(conversations.id, id)).get();
    if (!conv) throw AppError.notFound('对话', id);
    const item = pushDirective(id, content);
    if (!item.text) {
      return reply.code(400).send({ error: { message: '指令内容不能为空' } });
    }
    // 广播事件（前端显示"已注入指令"；同时落库回放）
    try {
      const bus = createEventBus(db, undefined, () => saveDb(config));
      bus.emit(id, 'agent.inbox.directive', {
        taskId: id,
        agentId: 'main',
        agentType: 'conversation',
        content: item.text,
        metadata: { directiveId: item.id },
      });
    } catch { /* 事件落库失败不阻塞 inject */ }
    return { success: true, directiveId: item.id, message: '指令已注入，将在下一轮生效' };
  });
}