import type { FastifyInstance } from 'fastify';
import type { BackendConfig } from '../../config/index.js';
import { getProviderByCapability, getProviderById } from '../../lib/provider.js';
import { getDb, saveDb } from '../../db/client.js';
import { conversations, messages, agentConfigs, providers } from '../../db/schema/index.js';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { getSettings } from '../../lib/dal.js';
import { AppError } from '@pacc/shared';
import { AGENTS, routeMessage } from './agent-definitions.js';
import { handleOrchestrate } from './orchestration.js';
import { isSafeFetchUrl } from '../../lib/safe-fetch.js';
import { buildModelRuntime, type ModelRequest } from '../../core/models/index.js';
// P0-03 收口：取消统一走 RunCancellationRegistry（run-scoped）
import { runCancellationRegistry } from '../../lib/run-cancellation-registry.js';
// 第五部分：Sisyphus Direct 生产旁路收口 —— 统一走 Run → ExecutionLoop（不再 direct complete()）
import { RunLifecycleManager } from '../../core/runtime/index.js';
import { runExecutionLoop, type ExecutionLoopDeps, type ExecutionBudget } from '../../core/runtime/execution-loop.js';

// P0-10/§27 修复：运行时自定义提示词统一由 PromptRegistry 管理（不再使用局部 Map），
// 与 orchestration.ts 共享同一实例 —— 前端编辑 Prompt 后所有生产路径（普通 Chat /
// Super Worker / Orchestrator / Synth / Direct Sisyphus）立即生效。
import { getEffectivePrompt, setPrompt, getAllPrompts } from '../../lib/prompt-registry.js';

type DirectHistoryMessage = {
  readonly role: 'user' | 'assistant'
  readonly content: unknown
}

type DirectSisyphusBody = {
  prompt: string
  conversationId?: string
  conversationTitle?: string
  providerId?: string
  model?: string
  history?: DirectHistoryMessage[]
}

export function registerAgentRoutes(app: FastifyInstance, config: BackendConfig): void {
  // 获取 Agent 列表（含配置信息 + 系统提示词）
  app.get('/api/agents', {
    schema: { description: '获取Agent团队列表', tags: ['Agent'] },
  }, async () => {
    const db = getDb();
    const configs = db.select().from(agentConfigs).all();
    const configMap = new Map(configs.map(c => [c.agentId, { providerId: c.providerId, model: c.model }]));
    return {
      agents: AGENTS.map(a => ({
        ...a,
        config: configMap.get(a.id) || null,
      })),
      modes: ['normal', 'super'],
    };
  });

  // 获取单个 Agent 的系统提示词
  app.get('/api/agents/:id/prompt', {
    schema: { description: '获取Agent系统提示词', tags: ['Agent'], params: { type: 'object', properties: { id: { type: 'string' } } } },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const agent = AGENTS.find(a => a.id === id);
    if (!agent) throw AppError.notFound('Agent', id);
    return { id: agent.id, name: agent.name, systemPrompt: getEffectivePrompt(id, agent.systemPrompt) };
  });

  // 更新 Agent 系统提示词（运行时覆盖，不持久化到代码）
  app.put('/api/agents/:id/prompt', {
    schema: { description: '更新Agent系统提示词', tags: ['Agent'], params: { type: 'object', properties: { id: { type: 'string' } } }, body: { type: 'object', properties: { systemPrompt: { type: 'string' } }, required: ['systemPrompt'] } },
  }, async (request) => {
    const { id } = request.params as { id: string };
    const { systemPrompt } = request.body as { systemPrompt: string };
    const agent = AGENTS.find(a => a.id === id);
    if (!agent) throw AppError.notFound('Agent', id);
    setPrompt(id, systemPrompt); // §27：统一写入 PromptRegistry（所有生产路径生效）
    return { success: true, id, systemPrompt };
  });

  // 获取所有 Agent 配置 + 可用 Providers/Models（用于设置面板）
  app.get('/api/agents/config', {
    schema: { description: '获取Agent配置及可用Provider列表', tags: ['Agent'] },
  }, async () => {
    const db = getDb();
    const configs = db.select().from(agentConfigs).all();
    const configMap = new Map(configs.map(c => [c.agentId, { providerId: c.providerId, model: c.model }]));
    const allProviders = db.select().from(providers).all().map(p => {
      // P1-7 修复：健壮解析 models/capabilities JSON，避免数据库脏数据导致 500
      let models: string[] = [];
      try { models = JSON.parse(p.models); } catch { models = [p.models].filter(Boolean); }
      let capabilities: string[] = ['text'];
      if (p.capabilities) { try { capabilities = JSON.parse(p.capabilities); } catch { capabilities = ['text']; } }
      return {
        id: p.id,
        name: p.name,
        type: p.type,
        models,
        capabilities,
      };
    });
    return {
      agents: AGENTS.map(({ systemPrompt, ...rest }) => ({
        id: rest.id,
        name: rest.name,
        icon: rest.icon,
        role: rest.role,
        description: rest.description,
        capabilities: rest.capabilities,
        config: configMap.get(rest.id) || null,
      })),
      providers: allProviders,
    };
  });

  // 更新单个 Agent 配置
  app.put('/api/agents/config/:agentId', {
    schema: {
      description: '更新Agent的Provider/Model配置',
      tags: ['Agent'],
      params: { type: 'object', properties: { agentId: { type: 'string' } } },
      body: {
        type: 'object',
        required: ['providerId', 'model'],
        properties: {
          providerId: { type: 'string' },
          model: { type: 'string' },
        },
      },
    },
  }, async (request) => {
    const { agentId } = request.params as { agentId: string };
    const body = request.body as { providerId: string; model: string };
    const agent = AGENTS.find(a => a.id === agentId);
    if (!agent) return { error: `Agent '${agentId}' not found` };
    const db = getDb();
    const now = new Date().toISOString();
    const existing = db.select().from(agentConfigs).where(eq(agentConfigs.agentId, agentId)).get();
    if (existing) {
      db.update(agentConfigs).set({ providerId: body.providerId, model: body.model, updatedAt: now }).where(eq(agentConfigs.agentId, agentId)).run();
    } else {
      db.insert(agentConfigs).values({ id: randomUUID(), agentId, providerId: body.providerId, model: body.model, createdAt: now, updatedAt: now }).run();
    }
    return { success: true, agentId, config: { providerId: body.providerId, model: body.model } };
  });

  // 超级模式编排：Sisyphus 分析 → 分派 → 并行执行 → 汇总
  app.post('/api/agents/orchestrate', {
    schema: {
      description: '超级模式：Sisyphus分析消息并分派给合适的Agent（SSE流式）',
      tags: ['Agent'],
      body: {
        type: 'object',
        required: ['prompt'],
        properties: {
          prompt: { type: 'string' },
          conversationId: { type: 'string' },
          history: { type: 'array' },
          images: { type: 'array', items: { type: 'string' } },
          files: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, dataUrl: { type: 'string' } } } },
          deepThinking: { type: 'boolean' },
          reasoningEffort: { type: 'string', enum: ['low', 'medium', 'high'] },
          webSearch: { type: 'boolean' },
        },
      },
    },
  }, async (request, reply) => {
    await handleOrchestrate(app, config, request, reply);
    // SSE 已通过 reply.raw 直写完成；必须返回 reply，避免 Fastify onSend 二次写头（ERR_HTTP_HEADERS_SENT）
    return reply;
  });

  // 普通模式：只用 Sisyphus 回答（支持保存到对话）
  app.post('/api/agents/sisyphus', {
    schema: {
      description: '普通模式：Sisyphus直接回答',
      tags: ['Agent'],
      body: {
        type: 'object',
        required: ['prompt'],
        properties: {
          prompt: { type: 'string' },
          conversationId: { type: 'string' },
          conversationTitle: { type: 'string' },
          providerId: { type: 'string' },
          model: { type: 'string' },
          history: { type: 'array' },
        },
      },
    },
  }, async (request) => {
    const body = request.body as DirectSisyphusBody;

    const db = getDb();
    const now = new Date().toISOString();

    // 解析 Sisyphus 的配置模型
    const sisyphusCfg = db.select().from(agentConfigs).where(eq(agentConfigs.agentId, 'sisyphus')).get();
    let sisyphusProvider = null;
    let sisyphusModel = '';
    if (sisyphusCfg) {
      sisyphusProvider = getProviderById(sisyphusCfg.providerId, config.encryptionKey);
      sisyphusModel = sisyphusCfg.model;
    }
    // 回退到 body 参数或默认 provider
    const fallbackProvider = getProviderByCapability('text', config.encryptionKey);
    if (!fallbackProvider) return { error: 'No AI provider configured' };
    const activeProvider = sisyphusProvider || fallbackProvider;
    const activeModel = sisyphusModel || body.model || fallbackProvider.defaultModel || 'gpt-4o';
    const activeProviderId = sisyphusCfg?.providerId || body.providerId || fallbackProvider.id;
    const sisyphus = AGENTS[0];

    // 1. 确保对话存在
    let convId = body.conversationId;
    if (!convId) {
      convId = randomUUID();
      db.insert(conversations).values({
        id: convId,
        title: body.conversationTitle || 'Sisyphus 对话',
        providerId: activeProviderId,
        model: activeModel,
        createdAt: now,
        updatedAt: now,
      }).run();
    } else {
      db.update(conversations).set({ updatedAt: now }).where(eq(conversations.id, convId)).run();
    }

    // 2. 保存用户消息
    const userMsgId = randomUUID();
    db.insert(messages).values({
      id: userMsgId, conversationId: convId, role: 'user', content: body.prompt, createdAt: now,
    }).run();

    // 3. 调用 Sisyphus —— 第五部分收口：统一走 Run → Task → AgentRuntime → ExecutionLoop
    // （不再 direct runtime.complete() 旁路；与普通 Chat 共用同一执行语义与终态事件）
    const runId = randomUUID();
    try {
      // 纵深防御：显式校验 baseUrl（虽受控但防配置篡改/注入）
      if (!isSafeFetchUrl(activeProvider.baseUrl)) throw new Error('Provider baseUrl 存在 SSRF 风险：禁止访问链路本地/元数据地址或非 http(s) 协议');
      
      const providerConfig = {
        id: activeProvider.id,
        name: activeProvider.name,
        type: activeProvider.type,
        apiKey: activeProvider.apiKey,
        baseUrl: activeProvider.baseUrl,
        defaultModel: activeProvider.defaultModel,
        models: activeProvider.models,
        capabilities: activeProvider.capabilities,
      };
      const runtime = buildModelRuntime(providerConfig);

      // Run 统一创建（第六部分：创建失败必须立刻终止，不得继续执行 Model）
      const lifecycle = new RunLifecycleManager(db);
      try {
        lifecycle.createAndStart({
          runId,
          conversationId: convId,
          mode: 'normal',
          rootAgentId: sisyphus.id,
          metadata: { source: 'sisyphus-direct' },
        });
      } catch (runErr: unknown) {
        db.insert(messages).values({
          id: randomUUID(), conversationId: convId, role: 'assistant',
          content: `[Run 创建失败] ${runErr instanceof Error ? runErr.message : String(runErr)}`,
          createdAt: new Date().toISOString(),
        }).run();
        return { error: 'Run 创建失败，无法执行', conversationId: convId };
      }

      // 历史消息（剥离图片 markdown URL —— 服务端虚拟路径 AI 无法访问）
       const historyMessages = (body.history || [])
         .filter((m) => m.role === 'user' || m.role === 'assistant')
         .map((m) => ({

          ...m,
          content: typeof m.content === 'string'
            ? m.content
              .replace(/!\[[^\]]*\]\(\/data\/chat-images\/[^)]+\)/g, '[图片]')
              .replace(/!\[[^\]]*\]\((data:image\/[^)]+)\)/g, '[图片]')
              .trim()
            : m.content,
        }));

      // 统一 ExecutionLoop 依赖注入（Normal 模式：完成必要调用后立即结束）
      const deps: ExecutionLoopDeps = {
        model: runtime,
        hasTools: false,
        buildRequest: (msgs, _turn): ModelRequest => ({
          provider: activeProvider.id,
          model: activeModel,
          systemPrompt: getEffectivePrompt(sisyphus.id, sisyphus.systemPrompt),
          messages: msgs,
          maxTokens: 2048,
          signal: AbortSignal.timeout(60000),
        }),
        executeTool: async () => '',
      };
      const loopBudget: ExecutionBudget = {
        maxTurns: 1,
        maxToolCalls: 0,
        maxTimeMs: 60_000,
        maxTokens: 0,
        maxCostCny: 0,
      };
      const result = await runExecutionLoop(deps, historyMessages, {
        loop: false,
        budget: loopBudget,
      });

      const reply = result.content.trim();
      const usage = {
        prompt_tokens: result.usage.cumulativeInputTokens,
        completion_tokens: result.usage.cumulativeOutputTokens,
        total_tokens: result.usage.cumulativeTotalTokens,
      };

       const endReason = result.state === 'cancelled'
         ? 'cancelled'
         : result.state === 'budget_exceeded'
           ? 'max_turns'
           : result.finishReason === 'max-tokens' || result.finishReason === 'content_filter'
             ? 'interrupted'
             : result.state === 'completed'
               ? 'completed'
               : 'error'
       // Run 终态写入（状态机统一；失败/中断 → fail 而非假成功）
       try {
         if (result.state === 'completed') {
           lifecycle.transition(runId, 'complete', { endReason: 'completed', inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens });
         } else if (result.state === 'cancelled') {
           lifecycle.transition(runId, 'cancel', { inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens });
         } else {
           lifecycle.transition(runId, 'fail', { error: result.content || 'AI 执行失败', endReason, inputTokens: usage.prompt_tokens, outputTokens: usage.completion_tokens });
         }
       } catch { /* 终态写入失败不阻塞回复 */ }


      // 4. 保存 AI 回复
      const aiMsgId = randomUUID();
      const totalTokens = usage.total_tokens || 0;
      db.insert(messages).values({
        id: aiMsgId, conversationId: convId, role: 'assistant', content: reply,
        toolResults: totalTokens > 0 ? JSON.stringify(usage) : null,
        createdAt: new Date().toISOString(),
      }).run();

      // PF-01: 增量维护 conversations.token_total
      if (totalTokens > 0) {
        db.update(conversations)
          .set({ tokenTotal: sql`${conversations.tokenTotal} + ${totalTokens}`, updatedAt: new Date().toISOString() })
          .where(eq(conversations.id, convId))
          .run();
      }

      return { reply, usage, conversationId: convId, runId };
    } catch (e: unknown) {
      // Run 执行失败 → 统一终态（第六部分：失败必须可见）
      try {
        const lc = new RunLifecycleManager(db);
        lc.transition(runId, 'fail', { error: e instanceof Error ? e.message : String(e), endReason: 'error' });
      } catch { /* ignore */ }
      db.insert(messages).values({
        id: randomUUID(), conversationId: convId, role: 'assistant',
        content: `[Error] ${(e instanceof Error ? e.message : String(e))}`, createdAt: new Date().toISOString(),
      }).run();
      return { error: (e instanceof Error ? e.message : String(e)) || 'Unknown error', conversationId: convId };
    }
  });

  // 取消正在进行的 AI 生成请求
  // P0-03 收口：统一走 RunCancellationRegistry（run-scoped），废弃 conversation-scoped activeRequests
  app.post('/api/agents/cancel', {
    schema: {
      description: '取消正在进行的 AI 生成',
      tags: ['Agent'],
      body: {
        type: 'object',
        required: ['conversationId'],
        properties: { conversationId: { type: 'string' } },
      },
    },
  }, async (request) => {
    const { conversationId } = request.body as { conversationId: string };
    const cancelledRunIds = runCancellationRegistry.cancelConversation(conversationId);
    if (cancelledRunIds.length > 0) {
      return { success: true, message: `已取消 ${cancelledRunIds.length} 个运行`, cancelledRunIds };
    }
    return { success: false, message: '没有正在进行的生成' };
  });
}

// Re-export for backward compatibility
export { AGENTS, routeMessage } from './agent-definitions.js';
export { handleOrchestrate } from './orchestration.js';