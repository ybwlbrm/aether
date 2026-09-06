import type { FastifyInstance, FastifyReply } from 'fastify';
import type { BackendConfig } from '../../config/index.js';
import { getProviderByCapability, getProviderById, providerSupportsThinking } from '../../lib/provider.js';
import { getDb, saveDb } from '../../db/client.js';
import { conversations, messages, agentConfigs, providers, mcpServers } from '../../db/schema/index.js';
import { fetchWithRetry } from '../../lib/fetch-retry.js';
import { eq, sql } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { getActiveMemoriesFormatted, getSettings } from '../../lib/dal.js';
import { clearReadFileCache } from '../../lib/files.js';
import { listMcpTools } from '../../lib/mcp-client.js';
import { AppError, StreamError } from '@pacc/shared';
import { createEventBus } from '../../lib/event-bus.js';
import { executeTool } from '../../lib/tool-executor.js';
import { buildAllTools, filterToolsByWebSearch } from '../../lib/tool-registry.js';
import { parseSse, withChunkTimeout, SseStreamError } from '../../lib/sse-parser.js';
import { translate, buildChatRequestBody, parseToolArgsSafe } from '../../lib/stream-translate.js';
import type { StreamChunk } from '@pacc/shared';
import { SSE_CHUNK_TIMEOUT_MS, startHeartbeat } from '../../lib/sse-utils.js';
import { createPendingApproval } from '../../lib/approvals-center.js';
import { drainDirectives } from '../../lib/inbox.js';
import { MANDATORY_COMPLIANCE_PROMPT, SISYPHUS_SYNTH_SYSTEM_PROMPT } from '../../lib/system-prompts.js';
import { truncateHistoryByTokenBudget } from '../../lib/context-window.js';
import { AGENTS, routeMessage } from './agent-definitions.js';
import { setupSse, cleanupSse, sendErrorAndEnd, type SseContext } from './sse-handler.js';
import { runAgentToolLoop, type ToolLoopContext } from './tool-loop.js';
// Aether 2.0 v2 Event Runtime wiring (Phase 4-9 integration fix):
// writes v2 AgentEvents to the `events` table alongside the legacy eventBus,
// and owns the runs-row lifecycle (ensureRunRow / finalizeRunTokens).
import { emitV2Event, ensureRunRow, finalizeRunTokens } from '../../lib/event-store-runtime.js';
// Aether 2.0 Model Runtime bridge (FIX-6): wire the legacy providers table
// into the core ModelRuntime/ModelRegistry so the bridge runs in production
// instead of being dead code. Legacy fetch path is untouched (Adapter §2.1).
import { buildAllRuntimes } from '../../lib/model-runtime-bridge.js';
import { ModelRegistry } from '../../core/models/index.js';

// 活跃的 AI 请求 AbortController 映射表（按 conversationId）
const activeRequests = new Map<string, AbortController>();

// P1-7 修复：运行时自定义提示词存放在局部 Map，不再突变模块级共享的 AGENTS 数组
const customPrompts = new Map<string, string>();

// Aether 2.0 Model Runtime registry (FIX-6): shared registry warmed from the
// providers table by handleOrchestrate; call sites can resolve runtimes here.
const modelRuntimeRegistry = new ModelRegistry();

export async function handleOrchestrate(
  app: FastifyInstance,
  config: BackendConfig,
  request: any,
  reply: FastifyReply
): Promise<void> {
  const body = request.body as {
    prompt: string;
    conversationId?: string;
    history?: any[];
    images?: string[];
    files?: { name: string; dataUrl: string }[];
    deepThinking?: boolean;
    reasoningEffort?: 'low' | 'medium' | 'high';
    webSearch?: boolean;
    loop?: boolean;
  };

  clearReadFileCache();
  const db = getDb();
  const now = new Date().toISOString();

  // 修复3：若用户上传了图片，注入提示词说明（图片已随请求提供，勿用 MCP 截屏），
  // 并透传到后续 AI 多模态调用
  const hasImages = Array.isArray(body.images) && body.images.length > 0;
  const imageHint = hasImages
    ? `\n\n## 图片输入\n- 用户已上传 ${(body.images || []).length} 张图片，图片内容直接可见。请直接分析图片，不要调用截屏/桌面视觉工具。`
    : '';

  // 处理文件附件（非图片文件）
  let fileAttachmentsHint = '';
  if (Array.isArray(body.files) && body.files.length > 0) {
    const chatFilesDir = resolve(config.dataDir, 'chat-files');
    if (!existsSync(chatFilesDir)) mkdirSync(chatFilesDir, { recursive: true });
    const fileInfos: string[] = [];
    for (const f of body.files.slice(0, 10)) {
      try {
        const match = f.dataUrl.match(/^data:(.+);base64,(.+)$/);
        if (match) {
          const safeName = f.name.replace(/[<>:"/\\|?*]/g, '_');
          const fullPath = resolve(chatFilesDir, safeName);
          writeFileSync(fullPath, Buffer.from(match[2], 'base64'));
          fileInfos.push(fullPath);
        }
      } catch (e: unknown) {
        console.warn('[Agent] 保存文件失败:', e instanceof Error ? e.message : String(e));
      }
    }
    if (fileInfos.length > 0) {
      fileAttachmentsHint = `\n\n## 用户上传的文件\n用户上传了 ${body.files.length} 个文件，已保存到服务端。完整路径如下（请直接使用 read_file 读取指定文件，不要用 list_files 列出目录）：\n${fileInfos.map((fp, i) => `- ${body.files![i].name} → ${fp}`).join('\n')}`;
    }
  }

  // 加载所有 agent 配置
  const allConfigs = db.select().from(agentConfigs).all();
  const configMap = new Map(allConfigs.map(c => [c.agentId, c]));

  // Aether 2.0 Model Runtime bridge (FIX-6): warm the providers table into the
  // core ModelRegistry + ModelRuntime instances each orchestration. Zero
  // behavior change to the legacy fetch path — this makes the bridge a real
  // production call site (it existed only in tests before).
  // P0-13：必须传 config.encryptionKey —— bridge 内部解密 providers 表的密文 Key。
  try {
    buildAllRuntimes(db, modelRuntimeRegistry, config.encryptionKey);
  } catch (err) {
    console.warn('[Orchestration] ModelRuntime bridge warm failed:', err instanceof Error ? err.message : String(err));
  }

  // 解析 agent 的 provider + model 配置
  function resolveAgentEndpoint(agentId: string): { baseUrl: string; apiKey: string; model: string } | null {
    const cfg = configMap.get(agentId);
    const fallback = getProviderByCapability('text', config.encryptionKey);
    if (cfg) {
      const p = getProviderById(cfg.providerId, config.encryptionKey);
      if (p) return { baseUrl: p.baseUrl.replace(/\/$/, ''), apiKey: p.apiKey, model: cfg.model || p.defaultModel || fallback?.defaultModel || 'gpt-4o' };
    }
    if (!fallback) return null;
    return { baseUrl: fallback.baseUrl.replace(/\/$/, ''), apiKey: fallback.apiKey, model: fallback.defaultModel || 'gpt-4o' };
  }

  // 修复 L573：provider 检查移到 SSE 头之前，避免 writeHead 后 return JSON 导致协议冲突
  const sisyphusEp = resolveAgentEndpoint('sisyphus');
  if (!sisyphusEp) {
    return reply.code(503).send({ error: 'No AI provider configured' });
  }

  const convId = body.conversationId || 'anonymous';
  const runTaskId = randomUUID();

  // Aether 2.0 v2 Event Runtime wiring (FIX-1/FIX-2): every orchestration run
  // owns a `runs` row and mirrors key lifecycle events into the `events` table,
  // so GET /api/runs/:runId/events and replay return real data. The legacy
  // eventBus path below is untouched (Adapter pattern §2.1).
  try {
    ensureRunRow(db, runTaskId, body.conversationId, 'super');
    void emitV2Event({
      runId: runTaskId,
      sessionId: convId,
      taskId: runTaskId,
      agentId: 'sisyphus',
      type: 'run.created',
      payload: { status: 'created' },
    });
  } catch { /* v2 runtime must never break legacy orchestration */ }

  // 使用 sse-handler 的 setupSse 创建上下文（内部完成 writeHead 与 sseSend，避免重复写头）
  const sseCtx = setupSse(reply, body.conversationId, db, config, () => saveDb(config));
  const { eventBus, clientAbort, heartbeatInterval } = sseCtx;
  const sseSend = sseCtx.sseSend;

  // 注册到全局映射表，用于取消端点
  activeRequests.set(body.conversationId || '', clientAbort);
  reply.raw.on('close', () => { if (body.conversationId) activeRequests.delete(body.conversationId); });

  try {
    // 解析文件操作权限
    const agentSettings = await getSettings();
    const allowedDirs = Array.isArray(agentSettings.allowedDirs) && agentSettings.allowedDirs.length > 0
      ? agentSettings.allowedDirs
      : [process.cwd()];
    const defaultDir = agentSettings.defaultDir || allowedDirs[0] || process.cwd();

    // 加载 MCP 工具（与文件工具合并）— 统一走 tool-registry 的 buildAllTools（消除重复实现）
    const getMcpServers = () => db.select().from(mcpServers).all() as any[];
    const mcpTools = await listMcpTools(getMcpServers);
    const allTools = buildAllTools(mcpTools);

    // 会话持久化：标记对话正在生成
    if (body.conversationId) {
      db.update(conversations).set({ generationStatus: 'generating', updatedAt: now }).where(eq(conversations.id, body.conversationId)).run();
    }

    // 保存用户消息到对话
    if (body.conversationId) {
      db.insert(messages).values({
        id: randomUUID(), conversationId: body.conversationId, role: 'user', content: body.prompt, createdAt: now,
      }).run();
    }

    // 1. Sisyphus 智能分析
    let targetIds: string[] = [];
    // C1: 区分「AI 分析成功但返回空数组（简单问答）」与「AI 分析失败」
    let aiParsedOk = false;

    try {
      // 极简 prompt——deepseek 模型对长 prompt 返回空，必须用极简格式
      // L26: 添加中文指令
      // C2: 注入历史尾部（帮助 AI 理解"继续/按上面的方案"等指代性请求）
      const recentContext = (body.history || []).slice(-4)
        .filter((m: any) => m.role === 'user' || m.role === 'assistant')
        .map((m: any) => `${m.role === 'user' ? '用户' : 'AI'}: ${typeof m.content === 'string' ? m.content.slice(0, 200) : ''}`)
        .join('\n');
      const analysisPrompt = `你是AI编排器。分析任务该交给哪些Agent。Agent能力:atlas=架构设计,hephaestus=写代码构建,prometheus=规划,momus=审查,oracle=推理,librarian=搜索,explore=探索代码,metis=分析需求,multimodal-looker=图片分析,sisyphus-junior=子任务。任务:${body.prompt}${recentContext ? `\n上下文:\n${recentContext}` : ''}。只输出JSON数组，如["hephaestus","atlas"]。注意：简单问答不需要分配Agent，输出空数组[]即可。`;

      const analysisRes = await fetchWithRetry(`${sisyphusEp.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sisyphusEp.apiKey}` },
        body: JSON.stringify({
          model: sisyphusEp.model,
          messages: [{ role: 'user', content: analysisPrompt }],
          max_tokens: 300,
          temperature: 0,
          stream: false,
        }),
        signal: clientAbort.signal,
      }, sseSend);

      if (analysisRes.ok) {
        const analysisData = await analysisRes.json() as any;
        const text = (analysisData.choices?.[0]?.message?.content || '').trim();
        // 先尝试直接解析 JSON
        try {
          const parsed = JSON.parse(text);
          if (Array.isArray(parsed)) {
            aiParsedOk = true;
            targetIds = parsed.filter((id: string) => AGENTS.some(a => a.id === id));
          }
        } catch {
          // 尝试从文本中提取 JSON 数组
          const jsonMatch = text.match(/\[[\s\S]*?\]/);
          if (jsonMatch) {
            try {
              const parsed = JSON.parse(jsonMatch[0]);
              if (Array.isArray(parsed)) {
                aiParsedOk = true;
                targetIds = parsed.filter((id: string) => AGENTS.some(a => a.id === id));
              }
            } catch (e: unknown) {
              // BE-SC-01: 记录原始文本片段便于排查 JSON 提取失败
              console.warn('[Agents] AI 路由 JSON 提取失败，原文前 200 字符:', text.slice(0, 200), e instanceof Error ? e.message : String(e));
            }
          }
        }
      } else {
        // BE-04a: 显式记录 AI 分析非 ok 响应，避免静默落入关键词兜底
        const errText = await analysisRes.text().catch(() => '');
        console.warn('[Agents] AI 分析请求失败，状态码:', analysisRes.status, '响应:', errText.slice(0, 200), '将回退到关键词路由');
      }
    } catch (e: unknown) {
      // BE-04a: 显式记录 AI 分析异常，避免静默落入关键词兜底
      console.warn('[Agents] AI 分析异常:', e instanceof Error ? e.message : String(e), '将回退到关键词路由');
    }

    // C1: 只有「AI 分析失败」时才走关键词兜底；
    // AI 明确返回空数组（简单问答）→ 直接单 sisyphus 直答，不再强制拆成多 agent
    if (targetIds.length === 0 && !aiParsedOk) {
      const routeResult = routeMessage(body.prompt);
      targetIds = routeResult;
    }
    // Sisyphus 负责汇总——只在有其他Agent时才加Sisyphus做编排汇总；
    // 简单Q&A（无其他Agent）也加Sisyphus直接回答
    if (!targetIds.includes('sisyphus')) targetIds.push('sisyphus');
    const targetAgents = AGENTS.filter(a => targetIds.includes(a.id));

    // 发送分析结果给前端
    sseSend('analysis', JSON.stringify({ agents: targetAgents.map(a => ({ id: a.id, name: a.name, icon: a.icon, role: a.role })) }));
    // 统一协议：任务计划（plan）— 编排分派后、执行前发出（对齐 harness plan 模式：计划先行）
    if (body.conversationId) {
      const planSteps = targetAgents
        .filter(a => a.id !== 'sisyphus')
        .map(a => `· ${a.name}（${a.role}）`)
        .join('\n');
      eventBus.emit(convId, 'task.plan', {
        taskId: runTaskId,
        agentId: 'sisyphus',
        agentType: 'orchestrator',
        status: 'running',
        content: planSteps
          ? `执行计划：\n${planSteps}\n· Sisyphus（汇总整合）`
          : '执行计划：\n· Sisyphus（直接回答）',
      });
    }
    // 统一协议：编排分析完成 → agent.started（由 sisyphus 分发）
    const agentOf = (agentId: string) => {
      const a = AGENTS.find(x => x.id === agentId);
      return { agentId: a?.id ?? agentId, agentName: a?.name ?? agentId, agentType: a?.role ?? 'agent' };
    };
    const analysisInfo = agentOf('sisyphus');
    if (body.conversationId) {
      eventBus.emit(convId, 'agent.started', {
        taskId: runTaskId,
        agentId: 'sisyphus',
        agentType: 'orchestrator',
        status: 'started',
        content: `正在分派任务给 ${targetAgents.filter(a => a.id !== 'sisyphus').map(a => a.name).join('、') || 'Sisyphus'}（共 ${targetAgents.length} 个 Agent）`,
      });
      eventBus.emit(convId, 'agent.status', {
        taskId: runTaskId,
        agentId: 'sisyphus',
        agentType: 'orchestrator',
        status: 'running',
        content: `正在分析任务并分派 Agent`,
      });
      // v2 mirror: run.started + agent.started (sisyphus orchestrator)
      void emitV2Event({ runId: runTaskId, sessionId: convId, taskId: runTaskId, agentId: 'sisyphus', type: 'run.started', payload: { status: 'running' } });
      void emitV2Event({ runId: runTaskId, sessionId: convId, taskId: runTaskId, agentId: 'sisyphus', type: 'agent.started', payload: { status: 'running' } });
    }

    // 2. 每个 Agent 使用自己的配置模型并行调用，逐个发送结果
    const results: any[] = [];
    // 不再提前群发 agent-start（旧协议 agent-start 保留兼容）；新协议按真实执行时机触发
    // 旧协议兼容：仍在循环前发送 agent-start
    for (const agent of targetAgents) {
      sseSend('agent-start', JSON.stringify({ agentId: agent.id, name: agent.name, icon: agent.icon, role: agent.role }));
    }

    // 并行调用但逐个收集结果 — L19: 每个 Agent 知道其他 Agent 在并行工作
    const otherAgentsInfo = targetAgents.filter(a => a.id !== 'sisyphus').map(a => `${a.name}(${a.role})`).join('、');
    await Promise.all(targetAgents.map(async (agent) => {
      const ep = resolveAgentEndpoint(agent.id);
      // 统一协议：按真实执行时机发送 agent.started（不再是循环前群发假信号）
      const agentCtx = agentOf(agent.id);
      if (body.conversationId) {
        eventBus.emit(convId, 'agent.started', {
          taskId: runTaskId,
          agentId: agent.id,
          agentType: agentCtx.agentType,
          status: 'started',
          content: `${agent.name}（${agent.role}）开始工作`,
        });
      }
      if (!ep) {
        const errResult = { agentId: agent.id, name: agent.name, icon: agent.icon, role: agent.role, status: 'error', reply: 'No provider configured', tokens: 0 };
        results.push(errResult);
        sseSend('agent-result', JSON.stringify(errResult));
        if (body.conversationId) {
          eventBus.emit(convId, 'agent.error', {
            taskId: runTaskId, agentId: agent.id, agentType: agentCtx.agentType,
            status: 'error', content: '未配置 Provider 或模型', parentEventId: undefined,
          });
        }
        return;
      }
      try {
        // 单个 Agent 调用（含 function calling 循环）
        // L19: 在 system prompt 中注入其他 Agent 的存在，避免重复工作
        const crossContext = otherAgentsInfo ? `\n\n注意：其他 Agent 正在并行工作（${otherAgentsInfo}），请聚焦你的专业领域，不要重复其他 Agent 的工作。` : '';
        // 注入用户记忆（从 DB + JSON 合并读取）
        const memoriesContext = await getActiveMemoriesFormatted();
        const memoryBlock = memoriesContext ? `\n\n## 用户记忆（长期/短期）\n${memoriesContext}\n` : '';
        // 权限级别提示（Level 3 = 超级，可访问整个文件系统）
        const permLevel = agentSettings.permissionLevel ?? 2;
        const permHint = permLevel === 3
          ? `\n\n## 权限说明\n- 当前为 Level 3（超级）权限，你可以访问整个文件系统的任何路径，无目录限制。\n- 直接使用绝对路径调用 list_files、read_file、write_file 等工具操作任意文件。`
          : `\n\n## 权限说明\n- 文件操作仅限 ${allowedDirs.join('、')} 目录及其子目录内。`;
        let agentMessages = [
          // P1-7 修复：优先使用运行时自定义提示词（局部 Map），回退到内置提示词
          { role: 'system', content: MANDATORY_COMPLIANCE_PROMPT + '\n\n' + (customPrompts.get(agent.id) ?? agent.systemPrompt) + crossContext + memoryBlock + imageHint + permHint + fileAttachmentsHint + '\n\n## 任务清单\n- 执行多步骤任务时，先用 todo_write 建立待办清单，每完成一步更新一次（DeepSeek Harness 风格：计划先行、逐项勾选）。' },
          ...(function() {
            // 上下文窗口管理：限制历史消息 token 预算（共享实现，含 CJK 估算修正 AI-007）
            const history2 = (body.history || []).filter((m: any) => m.role === 'user' || m.role === 'assistant');
            return truncateHistoryByTokenBudget(history2, 1000000, 0.7, 5);
          })(),
          { role: 'user', content: body.prompt },
          // 修复3：图片作为多模态输入直接附加到本轮对话（AI 可见，无需截屏）
          ...(hasImages ? body.images!.map(img => ({ role: 'user' as const, content: [{ type: 'image_url', image_url: { url: img } }] })) : []),
        ];

        // 构建 ToolLoopContext 并调用 tool-loop
        const toolLoopCtx: ToolLoopContext = {
          agent,
          ep,
          agentMessages,
          toolListForThisAgent: filterToolsByWebSearch(allTools, body.webSearch !== false),
          allTools,
          mcpTools,
          agentSettings,
          allowedDirs,
          defaultDir,
          body,
          convId,
          runTaskId,
          clientAbort,
          sseSend,
          eventBus,
          db,
          config,
          customPrompts,
          otherAgentsInfo,
          imageHint,
          fileAttachmentsHint,
          hasImages,
          deepThinking: body.deepThinking ?? false,
          reasoningEffort: body.reasoningEffort ?? 'medium',
          webSearchEnabled: body.webSearch !== false,
          epSupportsThinking: providerSupportsThinking({ baseUrl: ep.baseUrl, defaultModel: ep.model, models: [ep.model] } as never),
          agentCtx,
          saveDb: () => saveDb(config),
        };

        const toolLoopResult = await runAgentToolLoop(toolLoopCtx);

        const doneResult = {
          agentId: agent.id,
          name: agent.name,
          icon: agent.icon,
          role: agent.role,
          status: 'done',
          reply: toolLoopResult.agentReply,
          tokens: toolLoopResult.agentTokens,
          toolSummary: toolLoopResult.lastToolResult,
        };
        results.push(doneResult);
        sseSend('agent-result', JSON.stringify(doneResult));
        if (body.conversationId) {
          eventBus.emit(convId, 'agent.completed', {
            taskId: runTaskId, agentId: agent.id, agentType: agentCtx.agentType,
            status: 'completed', content: toolLoopResult.agentReply.slice(0, 500),
          });
        }
      } catch (e: unknown) {
        const errResult = { agentId: agent.id, name: agent.name, icon: agent.icon, role: agent.role, status: 'error', reply: (e instanceof Error ? e.message : String(e)) };
        results.push(errResult);
        sseSend('agent-result', JSON.stringify(errResult));
        if (body.conversationId) {
          eventBus.emit(convId, 'agent.error', {
            taskId: runTaskId, agentId: agent.id, agentType: agentOf(agent.id).agentType,
            status: 'error', content: errResult.reply,
          });
        }
      }
    }));

    // 3. Sisyphus 汇总所有结果 — 流式输出
    // L21: 过滤掉失败的 Agent 结果，避免把报错文本当作"分析结果"汇总
    const validResults = results.filter(r => r.status !== 'error');
    const errorResults = results.filter(r => r.status === 'error');
    const historyContext = (body.history || []).filter((m: any) => m.role === 'user' || m.role === 'assistant').slice(-6)
      .map((m: any) => {
        // 剥离图片 markdown URL（/data/chat-images/ 是服务端虚拟路径，AI 无法访问）
        const txt = typeof m.content === 'string'
          ? m.content
            .replace(/!\[[^\]]*\]\(\/data\/chat-images\/[^)]+\)/g, '[图片]')
            .replace(/!\[[^\]]*\]\((data:image\/[^)]+)\)/g, '[图片]')
            .trim()
          : m.content;
        return `${m.role === 'user' ? '用户' : 'AI'}: ${txt}`;
      }).join('\n');
    // L26: 添加中文指令 + 图片提示（修复3：用户上传的图片已可见，勿再用截屏工具）
    const synthPrompt = `请用简体中文回答。以下是多个专业 Agent 对用户问题的分析结果。请综合这些结果，给用户一个完整、连贯、统一的最终回答。
${hasImages ? `\n注意：用户上传了 ${body.images!.length} 张图片，图片内容已作为多模态输入可见，综合分析时直接参考图片。\n` : ''}

${historyContext ? `对话历史：\n${historyContext}\n\n` : ''}用户问题：${body.prompt}

各 Agent 分析结果：
${validResults.map(r => `【${r.name} - ${r.role}】\n${r.reply}${r.toolSummary ? `\n[实际工具成果]\n${r.toolSummary}` : ''}`).join('\n\n')}
${errorResults.length > 0 ? `\n注意：以下 Agent 执行失败，结果不可用：${errorResults.map(r => r.name).join('、')}` : ''}

请整合以上内容，输出最终回答。要求：
1. 覆盖所有 Agent 的有价值观点
2. 逻辑连贯，避免重复
3. 直接给出最终答案，不要提到"根据各Agent分析"等`;
    let finalReply = '';
    let totalAgentTokens = results.reduce((sum: number, r: any) => sum + (r.tokens || 0), 0);
    try {
      const synthRes = await fetchWithRetry(`${sisyphusEp.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${sisyphusEp.apiKey}` },
        body: JSON.stringify(buildChatRequestBody({
          model: sisyphusEp.model,
          messages: [
            { role: 'system', content: MANDATORY_COMPLIANCE_PROMPT + '\n\n' + SISYPHUS_SYNTH_SYSTEM_PROMPT },
            { role: 'user', content: synthPrompt },
            // 修复3：汇总阶段也附加用户上传的图片（多模态可见，避免依赖子 Agent 文本转述）
            ...(hasImages ? body.images!.map(img => ({ role: 'user' as const, content: [{ type: 'image_url', image_url: { url: img } }] })) : []),
          ],
          deepThinking: body.deepThinking,
          reasoningEffort: body.reasoningEffort,
          supportsThinking: providerSupportsThinking({ baseUrl: sisyphusEp.baseUrl, defaultModel: sisyphusEp.model, models: [sisyphusEp.model] } as never),
          max_tokens: 2048,
        })),
        signal: clientAbort.signal,
      }, sseSend);

      let synthReasoning = ''; // 汇总阶段 thinking 截获（用于 completion 事件回传）
      if (synthRes.ok && synthRes.body) {
        const reader = synthRes.body.getReader();
        // 最终输出专属事件：agent.output.delta（过程与最终回答分离的关键——前端只在 process 面板展示过程）
        try {
          for await (const c of translate(parseSse(withChunkTimeout(reader, SSE_CHUNK_TIMEOUT_MS, clientAbort.signal)))) {
            switch (c.type) {
              case 'reasoning-delta': {
                synthReasoning += c.text;
                sseSend('reasoning', JSON.stringify({ content: c.text }));
                if (body.conversationId) {
                  eventBus.emit(convId, 'agent.reasoning.delta', {
                    taskId: runTaskId, agentId: 'sisyphus', agentType: 'orchestrator', content: c.text,
                  });
                }
                break;
              }
              case 'text-delta': {
                finalReply += c.text;
                sseSend('message', JSON.stringify({ content: c.text }));
                if (body.conversationId) {
                  eventBus.emit(convId, 'agent.output.delta', {
                    taskId: runTaskId, agentId: 'sisyphus', agentType: 'orchestrator', content: c.text,
                  });
                }
                break;
              }
              case 'usage': {
                totalAgentTokens += c.usage.totalTokens ?? (c.usage.inputTokens + c.usage.outputTokens);
                break;
              }
              case 'finish': {
                if (c.reason.kind === 'error') throw new Error(c.reason.message || '汇总生成失败');
                break;
              }
              default: break;
            }
          }
          // 最终回答完成事件（含完整文本；username 前端据此投影最终气泡）
          if (body.conversationId) {
            eventBus.emit(convId, 'agent.output.completed', {
              taskId: runTaskId, agentId: 'sisyphus', agentType: 'orchestrator',
              status: 'completed', content: finalReply,
            });
          }
        } catch (e: unknown) {
          if (e instanceof SseStreamError) {
            sseSend('error', JSON.stringify({ message: `AI 响应流中断: ${e.message}` }));
          }
          throw e;
        }
      }
    } catch { /* 汇总失败则用第一个结果 */
      finalReply = results[0]?.reply || '处理完成';
      sseSend('message', JSON.stringify({ content: finalReply }));
    }

    // 保存 AI 汇总结果到对话（含 token 累计）
    // P1-14 修复：用户 abort 后不保存半截回复到 DB
    // 修复：若模型未返回 usage（流式接口部分不返回），用汇总内容长度估算兜底，确保 tokenTotal 不为 0
    if (body.conversationId && !clientAbort.signal.aborted) {
      if (totalAgentTokens <= 0) {
        const replyLen = (finalReply || results[0]?.reply || '处理完成').length;
        totalAgentTokens = Math.max(1, Math.round(replyLen / 4));
      }
      db.insert(messages).values({
        id: randomUUID(), conversationId: body.conversationId, role: 'assistant',
        content: finalReply || results[0]?.reply || '处理完成',
        toolResults: totalAgentTokens > 0 ? JSON.stringify({ total_tokens: totalAgentTokens }) : null,
        createdAt: new Date().toISOString(),
      }).run();

      // PF-01: 增量维护 conversations.token_total，避免后续全表聚合
      if (totalAgentTokens > 0) {
        db.update(conversations)
          .set({ tokenTotal: sql`${conversations.tokenTotal} + ${totalAgentTokens}`, updatedAt: new Date().toISOString() })
          .where(eq(conversations.id, body.conversationId))
          .run();
      }

      db.update(conversations).set({ generationStatus: 'idle', updatedAt: now }).where(eq(conversations.id, body.conversationId)).run();
    }
    // 持久化数据库（SSE 用 reply.raw 会绕过 Fastify 的 onResponse 钩子，需手动保存）
    try { saveDb(config); } catch (e: unknown) { console.error('[Agents] 持久化失败:', (e instanceof Error ? e.message : String(e)) || e); }

    // 发送 token 事件
    if (totalAgentTokens > 0) {
      sseSend('token', JSON.stringify({ total_tokens: totalAgentTokens }));
      if (body.conversationId) {
        eventBus.emit(convId, 'token', {
          taskId: runTaskId, agentId: 'sisyphus', agentType: 'orchestrator',
          metadata: { total_tokens: totalAgentTokens as number, sub_agents: targetAgents.length as number },
        }, { persist: false });
      }
    }

    // 统一协议：编排完成 → agent.completed(sisyphus) + task.completed
    if (body.conversationId) {
      eventBus.emit(convId, 'agent.completed', {
        taskId: runTaskId, agentId: 'sisyphus', agentType: 'orchestrator',
        status: 'completed', content: (finalReply || results[0]?.reply || '处理完成').slice(0, 500),
      });
      eventBus.emit(convId, 'task.completed', {
        taskId: runTaskId, agentId: 'sisyphus', agentType: 'orchestrator',
        status: 'completed', content: '完成',
        // 结束原因：客户端中止 → aborted；其余正常 → completed
        endReason: clientAbort.signal.aborted ? 'aborted' : 'completed',
      });
      // Aether 2.0 v2 mirror (FIX-1/FIX-2): finalize the runs row with terminal
      // status + token snapshot, and emit run.completed / run.cancelled.
      const terminalStatus = clientAbort.signal.aborted ? 'cancelled' as const : 'completed' as const;
      try {
        finalizeRunTokens(db, runTaskId, terminalStatus, { totalTokens: totalAgentTokens }, undefined);
        void emitV2Event({
          runId: runTaskId, sessionId: convId, taskId: runTaskId, agentId: 'sisyphus',
          type: terminalStatus === 'cancelled' ? 'run.cancelled' : 'run.completed',
          payload: { endReason: terminalStatus === 'cancelled' ? 'aborted' : 'completed', tokenUsage: { inputTokens: 0, outputTokens: 0, totalTokens: totalAgentTokens } },
        });
      } catch { /* v2 runtime must never break legacy orchestration */ }
    }

    // 发送结束标记
    sseSend('message', '[DONE]');

    // 关闭 SSE 流
    reply.raw.end();
  } catch (e: unknown) {
    // P1-1: 异常时发送错误事件，确保 reply.raw.end() 被调用，防连接挂起
    try { sseSend('error', JSON.stringify({ message: (e instanceof Error ? e.message : String(e)) || '内部错误' })); } catch { /* SSE 写入失败=客户端已断开，忽略 */ }
    // 统一协议：任务失败（仅真实会话；用户主动取消走 task.cancelled 由 cancel 端点发射）
    if (body.conversationId && !clientAbort.signal.aborted) {
      try {
        eventBus.emit(convId, 'task.failed', {
          taskId: runTaskId, agentId: 'sisyphus', agentType: 'orchestrator',
          status: 'error', content: (e instanceof Error ? e.message : String(e)) || '内部错误',
        });
        // Aether 2.0 v2 mirror (FIX-2): mark the run failed and record the error
        try {
          finalizeRunTokens(db, runTaskId, 'failed', { totalTokens: 0 }, (e instanceof Error ? e.message : String(e)) || '内部错误');
          void emitV2Event({
            runId: runTaskId, sessionId: convId, taskId: runTaskId, agentId: 'sisyphus',
            type: 'run.failed',
            payload: { endReason: 'error', error: { message: (e instanceof Error ? e.message : String(e)) || '内部错误' } },
          });
        } catch { /* v2 runtime must never break legacy orchestration */ }
      } catch (emitErr: unknown) { console.error('[Agents] task.failed 事件发射失败:', emitErr instanceof Error ? emitErr.message : String(emitErr)); }
    }
    try { sseSend('message', '[DONE]'); } catch { /* SSE 写入失败=客户端已断开，忽略 */ }
    try { reply.raw.end(); } catch { /* 响应已关闭，忽略 */ }
    // 会话持久化：标记生成中断
    if (body.conversationId) {
      try {
        db.update(conversations).set({ generationStatus: 'interrupted', updatedAt: new Date().toISOString() }).where(eq(conversations.id, body.conversationId)).run();
        saveDb(config);
      } catch (persistErr: unknown) {
        // BE-SC-02: DB 持久化失败必须 error 级日志（数据一致性问题，不可静默）
        console.error('[Agents] 会话中断状态持久化失败:', persistErr instanceof Error ? persistErr.message : String(persistErr));
      }
    }
  } finally {
    // 清理
    cleanupSse(sseCtx, body.conversationId);
    if (body.conversationId) activeRequests.delete(body.conversationId);
  }
}