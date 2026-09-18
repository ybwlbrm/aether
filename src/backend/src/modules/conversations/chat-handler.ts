import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { BackendConfig } from '../../config/index.js';
import { getDb, saveDb, runInTransaction } from '../../db/client.js';
import { conversations, messages, providers, mcpServers } from '../../db/schema/index.js';
import { eq, desc, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { SendMessageSchema, AppError } from '@pacc/shared';
import { getActiveMemoriesFormatted, getSettings } from '../../lib/dal.js';
import { getProviderById, getProviderByCapability, providerSupportsThinking } from '../../lib/provider.js';
import { clearReadFileCache } from '../../lib/files.js';
import { dedupToolResultReplacement } from '../../lib/deduplicate.js';
import { truncateHistoryByTokenBudget } from '../../lib/context-window.js';
import { listMcpTools } from '../../lib/mcp-client.js';
import { syncMessageToSupabase, getSyncClient } from '../../lib/supabase-sync.js';
import { createEventBus } from '../../lib/event-bus.js';
import { buildToolPayload } from '@pacc/shared';
import { buildAllTools, filterToolsByWebSearch } from '../../lib/tool-registry.js';
import { parseSse, withChunkTimeout, SseStreamError } from '../../lib/sse-parser.js';
import { translate, buildChatRequestBody, parseToolArgsSafe } from '../../lib/stream-translate.js';
import { SSE_CHUNK_TIMEOUT_MS, startHeartbeat } from '../../lib/sse-utils.js';
import { SISYPHUS_SYSTEM_PROMPT, MANDATORY_COMPLIANCE_PROMPT } from '../../lib/system-prompts.js';
import { compactRemovedHistory, buildCompactionSystemMessage } from '../../lib/compaction.js';
import { createPendingApproval } from '../../lib/approvals-center.js';
import { pushDirective, drainDirectives } from '../../lib/inbox.js';
import { runCancellationRegistry } from '../../lib/run-cancellation-registry.js';
// P0-02/P0-04/P0-05: 统一 Run 上下文 + RunLifecycleManager（普通 Chat 与 Super 模式同构）
import { createRunContext } from '../../core/runtime/index.js';
import { RunLifecycleManager } from '../../core/runtime/index.js';
import { getWorkspaceContext } from '../../core/workspace/workspace-context.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';
import { initSseHeaders, createSseSender, startSseHeartbeat, clearSseHeartbeat, sendSseError, sendSseDone, endSseResponse } from './sse-stream.js';
import { processCompaction, executeForceSummary } from './compaction.js';
import { executeToolLoop, ToolLoopConfig } from './tool-loop.js';

interface ChatHandlerContext {
  app: FastifyInstance;
  config: BackendConfig;
  db: ReturnType<typeof getDb>;
}

/** 整改计划第 5 章（P1）：预算耗尽标签（供 BUDGET_EXCEEDED 错误消息） */
function budgetLabel(kind: 'turns' | 'duration' | 'tokens' | 'tool_calls' | 'cost'): string {
  switch (kind) {
    case 'turns': return '轮数';
    case 'duration': return '时长';
    case 'tokens': return 'Token';
    case 'tool_calls': return '工具调用';
    case 'cost': return '费用';
  }
}

/**
 * 处理发送消息（流式 SSE，使用真实AI API，注入 active memories）
 */
export async function handleSendMessage(
  request: FastifyRequest,
  reply: FastifyReply,
  context: ChatHandlerContext
): Promise<FastifyReply> {
  const { app, config, db } = context;
  const { id } = request.params as { id: string };
  const body = SendMessageSchema.parse(request.body);
  clearReadFileCache(); // 清空文件读取缓存，防止跨对话缓存污染
  const conv = db.select().from(conversations).where(eq(conversations.id, id)).get();
  if (!conv) throw AppError.notFound('对话', id);

  // A6 修复：并发发送互斥 — 若该对话已有进行中的 AI 生成，拒绝新请求
  // 使用 runCancellationRegistry 检查是否有属于该对话的活跃 run
  const activeRunIds = runCancellationRegistry.runIdsForConversation(id);
  if (activeRunIds.length > 0) {
    return reply.code(409).send({ error: { message: '该对话正在生成中，请等待完成或先停止再发送' } });
  }

  const now = new Date().toISOString();

  // 保存用户消息
  const userMsgId = randomUUID();
  // 如果有图片，保存为服务端文件，content 中嵌入文件 URL（而非 base64 数据 URL）
  let contentToStore = body.content;
  if (Array.isArray(body.images) && body.images.length > 0) {
    const chatImagesDir = resolve(config.dataDir, 'chat-images');
    if (!existsSync(chatImagesDir)) mkdirSync(chatImagesDir, { recursive: true });
    const imageUrls: string[] = [];
    for (const img of body.images.slice(0, 10)) {
      const match = img.match(/^data:image\/(png|jpeg|jpg|gif|webp);base64,(.+)$/);
      if (match) {
        const ext = match[1] === 'jpeg' ? 'jpg' : match[1];
        const name = `${randomUUID()}.${ext}`;
        try {
          writeFileSync(resolve(chatImagesDir, name), Buffer.from(match[2], 'base64'));
          imageUrls.push(`/data/chat-images/${name}`);
        } catch (e: unknown) {
          console.warn('[Chat] 保存图片失败:', e instanceof Error ? e.message : String(e));
        }
      }
    }
    if (imageUrls.length > 0) {
      contentToStore = body.content + '\n\n' + imageUrls.map(url => `![image](${url})`).join('\n');
    }
  }
  // 处理文件附件（非图片文件）
  let fileInfos: string[] = [];
  if (Array.isArray(body.files) && body.files.length > 0) {
    const chatFilesDir = resolve(config.dataDir, 'chat-files');
    if (!existsSync(chatFilesDir)) mkdirSync(chatFilesDir, { recursive: true });
    for (const f of body.files.slice(0, 10)) {
      try {
        const match = f.dataUrl.match(/^data:(.+);base64,(.+)$/);
        if (match) {
          // 用原始文件名保存，AI 可直接使用路径
          const safeName = f.name.replace(/[<>:"/\\|?*]/g, '_');
          const fullPath = resolve(chatFilesDir, safeName);
          writeFileSync(fullPath, Buffer.from(match[2], 'base64'));
          fileInfos.push(fullPath);
        }
      } catch (e: unknown) {
        console.warn('[Chat] 保存文件失败:', e instanceof Error ? e.message : String(e));
      }
    }
    if (fileInfos.length > 0) {
      contentToStore += '\n\n' + fileInfos.map((fp, i) => `[上传文件: ${body.files![i].name}](${fp})`).join('\n');
    }
  }
  // 整改计划第 4 章（P1）：用户消息 + 会话 generating 标记在同一事务写入
  runInTransaction(config, () => {
    // 会话内稳定序号（created_at, seq 稳定排序基础）
    const seqResult = db.select({ maxSeq: sql<number>`COALESCE(MAX(${messages.seq}), 0)` })
      .from(messages).where(eq(messages.conversationId, id)).get();
    const nextSeq = (seqResult?.maxSeq ?? 0) + 1;
    db.insert(messages).values({
      id: userMsgId, conversationId: id, role: 'user', content: contentToStore, seq: nextSeq, createdAt: now,
    }).run();
    // 会话持久化：标记对话正在生成（与用户消息同事务）
    db.update(conversations).set({ generationStatus: 'generating', updatedAt: now }).where(eq(conversations.id, id)).run();
  });

  // 同步用户消息到 Supabase（手机端实时可见电脑端发送的消息）
  syncMessageToSupabase(id, { id: userMsgId, role: 'user', content: contentToStore, createdAt: now });

  // 读取对话全部历史（含刚保存的用户消息），作为多轮上下文
  const history = db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(messages.createdAt).all();

  // 本轮会话事件统一归属的 agent 上下文（提前声明，供注册使用）
  // P0-02/P0-04 修复：普通 Chat 路径也使用统一 Run 上下文 —— runId 唯一，
  // taskId = runId，与 Super 模式同构；并创建 runs 行（RunLifecycleManager 状态机）。
  const runCtx = createRunContext({
    conversationId: id,
    agentId: 'main',
    agentType: 'conversation',
  });
  const runContext = {
    sessionId: id,
    taskId: runCtx.taskId,
    agentId: runCtx.agentId as 'main',
    agentType: runCtx.agentType as 'conversation',
  };
  // P0-04: 普通 Chat 同样进入统一 Run 架构（runs 行 + created→running 状态机）
  try {
    const runLifecycle = new RunLifecycleManager(db);
    runLifecycle.createAndStart({
      runId: runCtx.runId,
      conversationId: id,
      mode: 'normal',
      rootAgentId: 'main',
    });
  } catch (e: unknown) {
    console.error('[Chat] runs 行创建失败:', e instanceof Error ? e.message : String(e));
  }

  // 设置 SSE 响应头
  initSseHeaders(reply);

  // 不再监听客户端断连 abort AI 请求：用户切换页面时对话继续处理，
  // 结果保存到数据库，回来后通过轮询自动恢复
  const clientAbort = new AbortController();
  // 注册到 RunCancellationRegistry（run-scoped，使用 runContext.taskId 作为 runId）
  // P0-03 修复：客户端断开（reply.raw close）只关闭 SSE Transport，Run 继续执行
  // 并保持注册 —— 移除 close → unregister 监听；只有 Run 真正结束（finally）才注销。
  runCancellationRegistry.register(runContext.taskId, id, clientAbort);

  // 发送 SSE 事件（忽略客户端已断开的写入错误）
  const sseSend = createSseSender(reply);

  // EventBus — 统一 Agent Event 协议：SSE（新事件名）+ activity_events 落库。
  // 与旧事件名（reasoning/message/tool-call/...）并行发送，保证旧前端兼容（双轨策略）。
  const eventBus = createEventBus(
    db,
    (event, data) => {
      // 新协议事件以 eventType 为事件名（不受旧 event==message 特判影响）
      try {
        reply.raw.write(`event: ${event}\ndata: ${data}\n\n`);
      } catch { /* 客户端已断开 */ }
    },
    () => saveDb(config),
  );

  // 会话持久化：标记对话正在生成（已在上方用户消息事务中执行，此处不再重复）
  // db.update(conversations).set({ generationStatus: 'generating', updatedAt: now }).where(eq(conversations.id, id)).run();

  // 任务开始事件
  eventBus.emit(runContext.sessionId, 'task.started', {
    taskId: runContext.taskId,
    agentId: runContext.agentId,
    agentType: runContext.agentType,
    content: body.content.slice(0, 200),
  });

  // BE-08: SSE 心跳在 try 内启动，finally 保证必清理，防止早退路径泄漏 interval
  let heartbeat: ReturnType<typeof startHeartbeat> | null = null;
  // 变量提升到 try 外部，供 catch/finally 及后续代码访问
  let aiContent = '';
  let streamedContent = '';
  let reasoningContent = '';
  let usageTotal = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
  let lastToolResult = '';
  // 整改计划第 5 章（P1）：预算耗尽标记 —— 提升到 try 外部（终态写入/SSE 事件需要）
  let budgetExceeded: 'turns' | 'duration' | 'tokens' | 'tool_calls' | 'cost' | null = null;
  // 整改计划第 5 章（P1）：循环 UI 指标 —— 已用轮数/时长/工具调用（随终态事件推给前端）
  let loopMetrics: { turnsUsed: number; elapsedMs: number; toolCalls: number; budgetExceeded: string | null } | null = null;
  let endedNormally = false;
  let aiError: string | null = null;
  try {
    // SSE 心跳 — 防止长操作时连接超时
    heartbeat = startSseHeartbeat(reply);
    // 解析 Provider：优先使用请求中指定的 providerId（支持同对话切换模型），
    // 回退到对话创建时绑定的 providerId，再回退到 defaultProviders.text
    let provider = null;
    const activeProviderId = body.providerId || conv.providerId;
    if (activeProviderId) {
      provider = getProviderById(activeProviderId, config.encryptionKey);
    }
    if (!provider) {
      provider = getProviderByCapability('text', config.encryptionKey);
    }
    // 模型：优先使用请求中指定的 model，回退到对话绑定的模型
    const activeModel = body.model || conv.model || provider?.defaultModel || 'gpt-4o';
    // 注入 active memories 到 system prompt（使用 Sisyphus 人设而非 generic prompt）
    // 传入用户消息内容作为 context，按关键词召回相关记忆
    const memories = await getActiveMemoriesFormatted(body.content);
    // 整改计划第 2 章：统一 WorkspaceContext 作为 allowedDirs/defaultDir 唯一来源，
    // 不再自行回退到 settings.allowedDirs[0] / process.cwd()
    const workspaceCtx = await getWorkspaceContext(config);
    const allowedDirs = workspaceCtx.allowedDirs;
    const defaultDir = workspaceCtx.defaultDir;
    const permLevel = workspaceCtx.permissionLevel;
    // tool-loop 仍需要完整 settings 对象（用于其余配置透传），但目录/权限以 WorkspaceContext 为准
    const settings = await getSettings();
    // 权限级别决定文件操作范围描述（Level 3 = 全局访问）
    const fileScopeDesc = permLevel === 3
      ? `- 当前为 Level 3（超级）权限：**可以访问整个文件系统的任何路径**，无目录限制，包括 C 盘、D 盘任意目录、用户目录等
- 用户可以要求你读取/操作任意位置的任意文件，直接使用绝对路径即可`
      : `- 工作目录: ${defaultDir}
- 文件操作限制在该目录及其子目录内
- 未指定路径时使用工作目录`;
    // 修复3：用户上传的图片已通过多模态 vision 参数随本次请求直接提供，
    // AI 可以直接"看到"图片内容，无需也不应调用 MCP 截屏工具去截取屏幕。
    const hasImages = Array.isArray(body.images) && body.images.length > 0;
    const imageHint = hasImages
      ? `- **用户在本条消息中上传了 ${(body.images || []).length} 张图片，图片内容已作为多模态输入直接提供给你，你现在就能看到并分析这些图片。**
- 请直接基于图片内容回答，**不要调用任何截屏/桌面视觉/图片读取工具**（如 desktop_vision、screenshot 等），那是多余的。
- 也不要声称"无法查看图片"——你能看到。直接描述图片内容即可。`
      : '';
    const hasFiles = Array.isArray(body.files) && body.files.length > 0;
    const fileAttachmentsHint = hasFiles
      ? `- **用户上传了 ${body.files!.length} 个文件**，文件路径如上所示。请直接使用 read_file 读取指定文件来分析，不要用 list_files 列出目录。`
      : '';
    const systemPrompt = `${MANDATORY_COMPLIANCE_PROMPT}

${SISYPHUS_SYSTEM_PROMPT}

## 用户记忆
${memories || '无'}

## 文件操作
${fileScopeDesc}
- 修改文件前先询问用户

## 图片输入
${imageHint || '- 本轮没有图片输入。'}
${fileAttachmentsHint}

## 任务清单
- 执行多步骤任务时，先用 todo_write 建立待办清单，每完成一步更新一次（计划先行、逐项勾选）。`;

    if (provider?.apiKey) {
      // 构建 API 消息列表 — 保留 assistant 的 tool_calls 字段（OpenAI API 规范要求）
      // L6: 上下文窗口管理 — 限制历史消息数量 + token 预算，防止超出 context window
      const MAX_HISTORY = 100;

      const allHistory = history
        .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'tool');
      let recentHistory = allHistory.slice(-MAX_HISTORY);
      // A5 修复：截断后丢弃开头的孤立 tool 消息 —— 其对应的 assistant.tool_calls 已被截掉，
      // 若保留会给 OpenAI API 发孤立 tool 消息导致 400 "must be a response to a preceding message with tool_calls"
      while (recentHistory.length > 0 && recentHistory[0].role === 'tool') {
        recentHistory.shift();
      }
      // 记录因超出 MAX_HISTORY 而被移除的最早消息（供 compaction 摘要）
      const overflowHistory = allHistory.slice(0, Math.max(0, allHistory.length - MAX_HISTORY))
        .map(m => ({ role: m.role, content: typeof m.content === 'string' ? m.content : '' }));

      // Token 预算截断 — 共享实现（W4-2/lib/context-window.ts，含 CJK 估算修正 AI-007）：
      // 从最早的消息开始丢弃，直到总字符数在预算内，保底保留 5 条（含系统提示词余量 25%）
      const beforeTrunc = recentHistory;
      recentHistory = truncateHistoryByTokenBudget(beforeTrunc, 1000000, 0.75, 5);
      // 记录被预算截断的消息（供 compaction 摘要）
      for (const removed of beforeTrunc) {
        if (recentHistory.indexOf(removed) === -1) {
          overflowHistory.push({ role: removed.role, content: typeof removed.content === 'string' ? removed.content : '' });
        }
      }
      const apiMessages: any[] = [
        { role: 'system', content: systemPrompt },
        ...recentHistory
          .map((m) => {
            const msg: any = { role: m.role, content: m.content };
            // 图片 URL(markdown 或裸 URL)对 AI 无意义：/data/chat-images/ 是服务端虚拟路径，
            // AI 无法通过文件系统访问。剥离图片 markdown，仅保留纯文本进上下文，
            // 当前上传的图片由 body.images 走 vision 多模态通道传递。
            if (typeof msg.content === 'string') {
              msg.content = msg.content
                .replace(/!\[[^\]]*\]\(\/data\/chat-images\/[^)]+\)/g, '[图片]')
                .replace(/!\[[^\]]*\]\((data:image\/[^)]+)\)/g, '[图片]')
                .trim();
            }
            // L2: 保留 assistant 的 tool_calls
            if (m.role === 'assistant' && m.toolCalls) {
              try {
                const tc = JSON.parse(m.toolCalls);
                msg.tool_calls = Array.isArray(tc) ? tc : [tc];
              } catch { /* fallback */ }
              // 对齐 harness：纯工具轮 content 回放空串（而非 null，部分网关拒绝 null）
              if (msg.tool_calls.length > 0 && !msg.content) msg.content = '';
            }
            // thinking 模式：assistant 消息回传 reasoning_content（防会话"砖化"）
            if (m.role === 'assistant' && (m as any).reasoningContent) {
              msg.reasoning_content = (m as any).reasoningContent;
            }
            // L2: tool 消息需要 tool_call_id
            if (m.role === 'tool' && m.toolCalls) {
              try {
                const tc = JSON.parse(m.toolCalls);
                msg.tool_call_id = tc.id;
              } catch { /* fallback */ }
            }
            return msg;
          }),
      ];

      // 图片支持：将最后一条用户消息的 content 改为多模态数组（text + image_url）
      if (body.images && body.images.length > 0) {
        const lastUserMsg = apiMessages.slice().reverse().find(m => m.role === 'user');
        if (lastUserMsg) {
          const contentParts: any[] = [{ type: 'text', text: lastUserMsg.content }];
          for (const img of body.images.slice(0, 10)) {
            contentParts.push({ type: 'image_url', image_url: { url: img } });
          }
          lastUserMsg.content = contentParts;
        }
      }

      // compaction：被移除的最早历史交给 LLM 生成摘要注入（替代直接丢弃，保留信息保真）。
      // 失败时回退到直接丢弃，不阻塞主流程；但需记录以便排查（LC-025）。
      if (overflowHistory.length > 0 && provider.apiKey) {
        let compactionMessage: { role: 'system'; content: string } | null = null;
        try {
          compactionMessage = await processCompaction({
            baseUrl: provider.baseUrl.replace(/\/$/, ''),
            apiKey: provider.apiKey,
            model: activeModel,
            removedHistory: overflowHistory,
            recentContext: (recentHistory[recentHistory.length - 1]?.content as string) || body.content || '',
            signal: clientAbort.signal,
          });
        } catch (compactionErr: unknown) {
          console.warn('[Chat] compaction 摘要生成失败，已回退为直接丢弃最早历史:', compactionErr instanceof Error ? compactionErr.message : String(compactionErr));
        }
        if (compactionMessage) {
          apiMessages.unshift(compactionMessage);
        }
      }

      // Function calling 循环（整改计划第 5 章，P1）：
      // 默认上限从 500 降到可配置安全值 30 —— 循环模式同样受安全上限约束，
      // 防止模型失控循环导致无界成本。高级值需经过 capability（本项目未启用）。
      const LOOP_MAX_TURNS_DEFAULT = 30;
      const baseUrl = provider.baseUrl.replace(/\/$/, '');
      let maxTurns = body.loop ? LOOP_MAX_TURNS_DEFAULT : 30;

      // 加载 MCP 工具（与文件工具合并）— 统一走 tool-registry 的 buildAllTools（消除重复实现）
      const getMcpServers = () => db.select().from(mcpServers).all() as any[];
      const mcpTools = await listMcpTools(getMcpServers);
      const allTools = buildAllTools(mcpTools);

      // 深度思考 / 联网搜索开关：provider 支持 thinking 时附加参数；webSearch=false 时过滤搜索系工具
      const convSupportsThinking = providerSupportsThinking(provider, activeModel);
      const webSearchEnabled = body.webSearch !== false;
      const activeTools = filterToolsByWebSearch(allTools, webSearchEnabled);

      const toolLoopResult = await executeToolLoop({
        apiMessages,
        baseUrl,
        apiKey: provider.apiKey,
        activeModel,
        activeTools,
        maxTurns,
        clientAbortSignal: clientAbort.signal,
        sseSend,
        eventBus,
        runContext,
        conversationId: id,
        mcpTools,
        getMcpServers,
        allowedDirs,
        permissionLevel: workspaceCtx.permissionLevel,
        defaultDir,
        settings,
        deepThinking: body.deepThinking,
        reasoningEffort: body.reasoningEffort,
        supportsThinking: convSupportsThinking,
        db,
        body,
      });

      // 解构工具循环结果
      aiContent = toolLoopResult.aiContent;
      streamedContent = toolLoopResult.streamedContent;
      reasoningContent = toolLoopResult.reasoningContent;
      usageTotal = toolLoopResult.usageTotal;
      lastToolResult = toolLoopResult.lastToolResult;
      endedNormally = toolLoopResult.endedNormally;
      aiError = toolLoopResult.aiError;
      // 整改计划第 5 章（P1）：预算耗尽 —— 超过轮数/时长/token/工具调用/费用任一预算即停止，
      // 写 budget_exceeded 错误码，不再继续请求模型
      budgetExceeded = toolLoopResult.budgetExceeded;
      // 整改计划第 5 章（P1）：循环 UI 指标 —— 已用轮数/时长/工具调用（随终态事件推给前端）
      loopMetrics = {
        turnsUsed: toolLoopResult.turnsUsed,
        elapsedMs: toolLoopResult.elapsedMs,
        toolCalls: toolLoopResult.toolCallCount,
        budgetExceeded: toolLoopResult.budgetExceeded,
      };

      // maxTurns 耗尽后的兜底处理 — 这些变量在 while 循环内声明，循环外不可见
      // 用 aiContent 是否为空判断，不引用循环内变量
      if (!endedNormally && !aiContent) {
        // 核心修复：工具循环结束后 AI 没给文本总结（aiContent 为空），追加一轮强制总结，
        // 让 AI 基于所有工具结果给出完整答复，而不是填占位符
        const forceSummary = await executeForceSummary(
          apiMessages,
          activeModel,
          baseUrl,
          provider.apiKey,
          activeTools,
          body.deepThinking,
          body.reasoningEffort,
          convSupportsThinking,
          clientAbort.signal,
          sseSend,
          eventBus,
          runContext
        );
        if (forceSummary) {
          aiContent = forceSummary;
          streamedContent = aiContent;
        }
      }
      if (!endedNormally && !aiContent) {
        aiContent = '✅ 处理完成（工具调用已执行）';
      }

      // 去重复显示（SSE 发送前）：若 AI 回复原样复述了工具执行结果（同一段内容出现两次），
      // 只保留工具的绿色结果框，assistant 白字替换为简短说明，避免同内容显示两次。
      // 典型场景：视觉/分析工具返回 JSON，AI 把这段 JSON 原样粘贴进回复文本。
      const dedupReplacement = dedupToolResultReplacement(aiContent, lastToolResult);
      if (dedupReplacement) {
        aiContent = dedupReplacement;
      }

      // 流式返回最终内容 — 修复 SSE 双发：
      // 流式中每个 delta 已实时发送（完整内容已推到前端），这里若再次发送 aiContent
      // 前端纯追加会显示两遍。仅在发生「去重复制替换」（aiContent 已被换成简短提示）
      // 时发送 message-replace 事件让前端替换累积内容；未替换时不再重发。
      if (!aiContent) {
        aiContent = '处理完成（无文本输出）';
      }
      if (aiContent !== streamedContent) {
        sseSend('message-replace', JSON.stringify({ content: aiContent }));
      }
    } else {
      // P0-5 修复：无 API key 时发送明确错误事件，不保存 echo 假回复
      sendSseError(sseSend, '未配置 AI Provider 或 API Key。请在「AI Providers」页面配置后再试。');
      endSseResponse(reply);
      return reply; // BE-08: heartbeat 在 finally 中统一清理
    }
  } catch (e: unknown) {
    aiError = e instanceof Error ? e.message : String(e) || '未知错误';
    aiContent = '';
  } finally {
    clearSseHeartbeat(heartbeat);
  }

  // 流式结束后保存完整 AI 回复（token 用量存于 toolResults 字段）
  // 修复：若模型未返回 usage（部分流式接口不返回），用内容长度估算兜底，确保 tokenTotal 不为 0
  const aiMsgId = randomUUID();
  if (usageTotal.total_tokens <= 0 && aiContent.length > 0) {
    usageTotal.total_tokens = Math.max(1, Math.round(aiContent.length / 4));
    usageTotal.completion_tokens = usageTotal.total_tokens;
  }
  // 消息完成事件（统一协议）— 含最终文本与 token 用量
  eventBus.emit(runContext.sessionId, 'agent.message.completed', {
    taskId: runContext.taskId,
    agentId: runContext.agentId,
    agentType: runContext.agentType,
    content: aiContent,
    status: aiError ? 'error' : 'completed',
    metadata: usageTotal.total_tokens > 0 ? usageTotal as unknown as Record<string, unknown> : undefined,
  }, { persist: aiError === null });
  // 保存 reasoning 到 toolResults（供前端加载时显示思考过程）
  let toolResultsObj: any = {};
  if (usageTotal.total_tokens > 0) toolResultsObj = usageTotal;
  if (reasoningContent) toolResultsObj.reasoning = reasoningContent;
  const toolResultsStr = Object.keys(toolResultsObj).length > 0 ? JSON.stringify(toolResultsObj) : null;

  // A2 修复：AI 失败且无任何内容时，不插入空白 assistant 消息（避免空气泡）。
  // 有部分内容时仍保存（保留流式过程中已产出的文本）。
  // 整改计划第 4 章（P1）：AI 消息 + token_total + generationStatus（含流中断 partial content + interrupted）
  // 在同一 SQLite 事务中写入 —— 三者要么全部落库，要么全部回滚；stream-truncated/error 写 partial content + interrupted。
  if (!(aiError && aiContent.length === 0)) {
    runInTransaction(config, () => {
      // 会话内稳定序号（created_at, seq 稳定排序基础）
      const seqResult = db.select({ maxSeq: sql<number>`COALESCE(MAX(${messages.seq}), 0)` })
        .from(messages).where(eq(messages.conversationId, id)).get();
      const nextSeq = (seqResult?.maxSeq ?? 0) + 1;
      db.insert(messages).values({
        id: aiMsgId, conversationId: id, role: 'assistant', content: aiContent,
        toolResults: toolResultsStr,
        seq: nextSeq,
        // thinking 模式：落库 reasoning_content，多轮对话回放时回传 provider（防会话"砖化"）
        reasoningContent: reasoningContent || null,
        createdAt: new Date().toISOString(),
      }).run();

      // PF-01: 增量维护 conversations.token_total，避免后续全表聚合
      if (usageTotal.total_tokens > 0) {
        db.update(conversations)
          .set({ tokenTotal: sql`${conversations.tokenTotal} + ${usageTotal.total_tokens}`, updatedAt: new Date().toISOString() })
          .where(eq(conversations.id, id))
          .run();
      }

      // 整改计划第 4 章：流中断（aiError）→ 写 interrupted + partial content；正常 → idle
      db.update(conversations).set({ generationStatus: aiError ? 'interrupted' : 'idle', updatedAt: now }).where(eq(conversations.id, id)).run();
    });

    // 同步 AI 回复到 Supabase（手机端实时可见）
    syncMessageToSupabase(id, {
      id: aiMsgId, role: 'assistant', content: aiContent,
      toolResults: toolResultsStr, createdAt: new Date().toISOString(),
    });
  } else {
    // 无内容失败：仍标记 interrupted（同事务原子性）
    runInTransaction(config, () => {
      db.update(conversations).set({ generationStatus: 'interrupted', updatedAt: now }).where(eq(conversations.id, id)).run();
    });
  }

  // L3: 自动生成对话标题 — 从用户第一条消息提取（截断到 30 字符）
  const existingConv = db.select().from(conversations).where(eq(conversations.id, id)).get();
  if (existingConv && (existingConv.title === '新对话' || !existingConv.title)) {
    // P2-16 修复：用 Array.from 安全截断，避免截断 emoji surrogate pair
    const titleBase = Array.from(body.content).slice(0, 30).join('');
    const autoTitle = titleBase + (Array.from(body.content).length > 30 ? '...' : '');
    db.update(conversations).set({ title: autoTitle }).where(eq(conversations.id, id)).run();
  }

  // 流式结束后发送 token 用量事件（供前端实时展示）
  if (usageTotal.total_tokens > 0) {
    sseSend('token', JSON.stringify(usageTotal));
    eventBus.emit(runContext.sessionId, 'token', {
      taskId: runContext.taskId,
      agentId: runContext.agentId,
      agentType: runContext.agentType,
      content: undefined,
      metadata: usageTotal as unknown as Record<string, unknown>,
    }, { persist: false });
  }

  // L7: 移除自动保存对话到 Memory — 过于激进，应只在用户明确要求时保存

  // 出错时发送 SSE 错误事件
  if (aiError) {
    sendSseError(sseSend, aiError);
    eventBus.emit(runContext.sessionId, 'task.failed', {
      taskId: runContext.taskId,
      agentId: runContext.agentId,
      agentType: runContext.agentType,
      status: 'error',
      content: aiError,
      endReason: 'error',
    });
  } else if (budgetExceeded) {
    // 整改计划第 5 章（P1）：预算耗尽 → 写 budget_exceeded 错误码（前端显示恢复动作）
    const budgetMsg = `已达到${budgetLabel(budgetExceeded)}预算，任务停止执行（可停止或发送新消息继续）。`;
    sseSend('error', JSON.stringify({ message: budgetMsg, code: 'BUDGET_EXCEEDED', budgetExceeded }));
    eventBus.emit(runContext.sessionId, 'task.failed', {
      taskId: runContext.taskId,
      agentId: runContext.agentId,
      agentType: runContext.agentType,
      status: 'error',
      content: budgetMsg,
      endReason: 'budget_exceeded',
      metadata: { code: 'BUDGET_EXCEEDED', budgetExceeded, ...loopMetrics },
    });
  } else {
    // 任务完成事件（统一协议）— 结束原因：中止→aborted；正常文本→completed；轮次耗尽→max_turns
    // 整改计划第 5 章（P1）：终态事件携带循环指标（轮数/时长/工具调用）供前端循环 UI 显示
    eventBus.emit(runContext.sessionId, 'task.completed', {
      taskId: runContext.taskId,
      agentId: runContext.agentId,
      agentType: runContext.agentType,
      status: 'completed',
      content: '完成',
      endReason: clientAbort.signal.aborted ? 'aborted' : endedNormally ? 'completed' : 'max_turns',
      metadata: { ...loopMetrics },
    });
  }

  // P0-05 收口：普通 Chat 的 runs 行终态也统一走 RunLifecycleManager 状态机
  try {
    const runLifecycle = new RunLifecycleManager(db);
    if (aiError) {
      runLifecycle.transition(runContext.taskId, 'fail', {
        error: aiError,
        endReason: 'error',
        totalTokens: usageTotal.total_tokens || 0,
      });
    } else if (budgetExceeded) {
      // 预算耗尽 → fail（endReason: budget_exceeded）
      runLifecycle.transition(runContext.taskId, 'fail', {
        error: `BUDGET_EXCEEDED:${budgetExceeded}`,
        endReason: 'budget_exceeded',
        totalTokens: usageTotal.total_tokens || 0,
      });
    } else if (clientAbort.signal.aborted) {
      runLifecycle.transition(runContext.taskId, 'cancel', { totalTokens: usageTotal.total_tokens || 0 });
    } else {
      runLifecycle.transition(runContext.taskId, 'complete', {
        endReason: endedNormally ? 'completed' : 'max_turns',
        totalTokens: usageTotal.total_tokens || 0,
      });
    }
  } catch (e: unknown) {
    // Run 终态写入失败不影响主流程，但必须记录（数据一致性可观测）
    console.error('[Chat] runs 终态写入失败:', e instanceof Error ? e.message : String(e));
  }
  // P0-03 收口：Run 真正结束后才从 CancellationRegistry 注销
  runCancellationRegistry.unregister(runContext.taskId);

  sendSseDone(sseSend);
  endSseResponse(reply);

  // 显式持久化数据库（SSE 用 reply.raw 会绕过 Fastify 的 onResponse 钩子，需手动保存）
  try { saveDb(config); } catch (e: unknown) { console.error('[Conversations] 持久化失败:', (e instanceof Error ? e.message : String(e)) || e); }

  // 返回 reply 阻止 Fastify 重复发送（此时 reply.raw 已 end，sent === true）
  return reply;
}