import type { SupabaseClient } from '@supabase/supabase-js';
import type { BackendConfig } from '../../config/index.js';
import type { SyncConfig } from './sync-config.js';
import { getDb, saveDb } from '../../db/client.js';
import { conversations, messages } from '../../db/schema/index.js';
import { eq, desc } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { getProviderByCapability } from '../../lib/provider.js';
import { fileTools, executeFileTool } from '../../lib/files.js';
import { commandTools, executeCommand, addCommandHistory } from '../../lib/command.js';
import { searchTools, executeGrep, executeGlob, executeWebSearch, executeWebFetch } from '../../lib/search-tools.js';
import { lspTools, executeLspDiagnostics } from '../../lib/lsp-client.js';
import { dedupToolResultReplacement } from '../../lib/deduplicate.js';
import { testTools, executeRunTests } from '../../lib/test-runner.js';
import { codeReviewTools, executeCodeReview } from '../../lib/code-review.js';
import { listMcpTools, callMcpTool } from '../../lib/mcp-client.js';
import { mcpServers } from '../../db/schema/index.js';
import { getSettings } from '../../lib/dal.js';
import { parseSse, withChunkTimeout } from '../../lib/sse-parser.js';
import { translate } from '../../lib/stream-translate.js';
import { SSE_CHUNK_TIMEOUT_MS } from '../../lib/sse-utils.js';
import { createEventBus } from '../../lib/event-bus.js';
import { buildToolPayload } from '@pacc/shared';
import { MANDATORY_COMPLIANCE_PROMPT } from '../../lib/system-prompts.js';
import { registerDevice } from './sync-config.js';
import { resolve } from 'node:path';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { isSafeFetchUrl } from '../../lib/safe-fetch.js';

// ============================================================
// 处理远程命令（手机端发来的指令）
// ============================================================

export async function processRemoteCommand(
  sb: SupabaseClient,
  cfg: SyncConfig,
  command: any,
  backendConfig: BackendConfig
): Promise<void> {
  const db = getDb();
  const commandId = command.id;
  let content = command.content;
  const existingConvId = command.conversation_id;

  // P0-1: 解析并剥离手机端附加的模式/Level/开关前缀 [mode=X][level=Y][deep=Z][web=W][loop=L]
  let remoteMode = 'normal';
  let remoteLevel = 2;
  let remoteDeep = false;
  let remoteWeb = true;
  let remoteLoop = false;
  const metaMatch = content.match(/^\[mode=(\w+)\]\[level=(\d+)\](?:\[deep=(\w+)\])?(?:\[web=(\w+)\])?(?:\[loop=(\w+)\])?\s*/);
  if (metaMatch) {
    remoteMode = metaMatch[1] === 'super' ? 'super' : 'normal';
    remoteLevel = Number(metaMatch[2]) === 1 ? 1 : 2;
    remoteDeep = metaMatch[3] === 'true';
    remoteWeb = metaMatch[4] !== 'false';
    remoteLoop = metaMatch[5] === 'true';
    content = content.slice(metaMatch[0].length); // 剥离前缀
  }

  // 核心修复：先创建对话+保存用户消息并同步到 Supabase，再调 AI。
  // 这样即使 AI 失败（如 429 限流），用户消息和对话也已在手机端可见。
  try {
    // 确保 desktop 设备已注册（conversations_sync/messages_sync 的外键依赖 devices 表）
    try {
      await registerDevice(sb, cfg);
    } catch (e: unknown) {
      console.warn('[Sync] 处理前设备注册失败（继续尝试）:', e instanceof Error ? e.message : e);
    }

    // 标记为 processing
    await sb.from('remote_commands').update({ status: 'processing' }).eq('id', commandId);

    // 获取 AI Provider（text 能力）
    const provider = getProviderByCapability('text', backendConfig.encryptionKey);

    // 创建或复用对话（不因 Provider 缺失而中断 — 也会同步用户消息）
    let convId: string;
    let convTitle: string;

    if (existingConvId) {
      // 手机端带了 conversation_id → 复用该对话（不存在时也按此 id 创建，保证后续消息进入同一对话）
      const existing = db.select().from(conversations).where(eq(conversations.id, existingConvId)).get();
      if (existing) {
        convId = existingConvId;
        convTitle = existing.title;
      } else {
        convId = existingConvId;
        convTitle = content.length > 30 ? content.slice(0, 30) + '...' : content;
        const now0 = new Date().toISOString();
        db.insert(conversations).values({
          id: convId,
          title: convTitle,
          providerId: provider?.id || 'unknown',
          model: provider?.defaultModel || 'gpt-4o',
          createdAt: now0,
          updatedAt: now0,
        }).run();
      }
    } else {
      convId = randomUUID();
      convTitle = content.length > 30 ? content.slice(0, 30) + '...' : content;
      const now0 = new Date().toISOString();
      db.insert(conversations).values({
        id: convId,
        title: convTitle,
        providerId: provider?.id || 'unknown',
        model: provider?.defaultModel || 'gpt-4o',
        createdAt: now0,
        updatedAt: now0,
      }).run();
    }

    // 保存用户消息到本地（含文件附件处理）
    let userMsgId = randomUUID();
    const now = new Date().toISOString();
    let storedContent = content;

    // 处理消息中的文件附件：检测 [上传文件: 名](data:...) 格式，解码保存到本地
    // 与 conversations 模块的桌面端文件上传处理保持一致
    const fileDataRegex = /\[上传文件:\s*([^\]]+)\]\(data:([^;]+);base64,([^)]+)\)/g;
    let fileMatch;
    while ((fileMatch = fileDataRegex.exec(storedContent)) !== null) {
      const fileName = fileMatch[1].trim();
      const mimeType = fileMatch[2];
      const base64Data = fileMatch[3];
      // 非图片文件通过此路径处理（图片由下方多模态逻辑处理）
      if (!mimeType.startsWith('image/')) {
        try {
          const chatFilesDir = resolve(backendConfig.dataDir, 'chat-files');
          if (!existsSync(chatFilesDir)) mkdirSync(chatFilesDir, { recursive: true });
          const safeName = fileName.replace(/[<>:"/\\|?*]/g, '_');
          const fullPath = resolve(chatFilesDir, safeName);
          writeFileSync(fullPath, Buffer.from(base64Data, 'base64'));
          // 替换 content 中的 data URL 为本地路径
          storedContent = storedContent.replace(fileMatch[0], `[上传文件: ${fileName}](${fullPath})`);
          console.log(`[Sync] 已保存手机端上传的文件: ${fullPath}`);
        } catch (e: unknown) {
          console.warn('[Sync] 保存手机端上传文件失败:', e instanceof Error ? e.message : String(e));
        }
      }
    }
    // 处理图片附件：检测 ![](data:image/...) 格式，保存到 chat-images/
    const imgFileRegex = /!\[([^\]]*)\]\((data:image\/(png|jpeg|jpg|gif|webp);base64,([^)]+))\)/g;
    let imgMatch;
    while ((imgMatch = imgFileRegex.exec(storedContent)) !== null) {
      try {
        const chatImagesDir = resolve(backendConfig.dataDir, 'chat-images');
        if (!existsSync(chatImagesDir)) mkdirSync(chatImagesDir, { recursive: true });
        const ext = imgMatch[3] === 'jpeg' ? 'jpg' : imgMatch[3];
        const imgName = `${randomUUID()}.${ext}`;
        const fullPath = resolve(chatImagesDir, imgName);
        writeFileSync(fullPath, Buffer.from(imgMatch[4], 'base64'));
        storedContent = storedContent.replace(imgMatch[1], `/data/chat-images/${imgName}`);
      } catch (e: unknown) {
        console.warn('[Sync] 保存手机端上传图片失败:', e instanceof Error ? e.message : String(e));
      }
    }

    db.insert(messages).values({
      id: userMsgId,
      conversationId: convId,
      role: 'user',
      content: storedContent,
      createdAt: now,
    }).run();

    // P0-2: 立即把 conversation_id 写回 remote_commands，让桌面端能立刻开始轮询导航
    try {
      await sb.from('remote_commands').update({
        conversation_id: convId,
        status: 'processing',
      }).eq('id', commandId);
    } catch { /* 忽略 */ }

    // ========== 立即同步对话 + 用户消息（AI 调用之前） ==========
    // BE-07 修复：使用 commandId 作为幂等键，实现补偿逻辑 + 重试（最多 3 次）
    // 若消息 upsert 失败且对话已创建，删除该对话（补偿），避免孤儿记录。
    const MAX_SYNC_RETRIES = 3;
    let syncSuccess = false;
    let lastSyncError: unknown;

    for (let attempt = 1; attempt <= MAX_SYNC_RETRIES && !syncSuccess; attempt++) {
      try {
        // 幂等性检查：若 remote_commands 已有 conversation_id，说明该命令已部分处理过，
        // 复用该 conversation_id 而非创建新对话，防止重复。
        let effectiveConvId = convId;
        let effectiveUserMsgId = userMsgId;
        let isRetryOfExisting = false;

        if (attempt > 1) {
          // 重试时，从远程命令读取已分配的 conversation_id（若有）
          const { data: cmdCheck } = await sb
            .from('remote_commands')
            .select('conversation_id')
            .eq('id', commandId)
            .single();
          if (cmdCheck?.conversation_id) {
            effectiveConvId = cmdCheck.conversation_id;
            isRetryOfExisting = true;
            console.log(`[Sync] 重试第 ${attempt} 次：复用已有 conversation_id=${effectiveConvId}`);
          }
        }

        // 步骤 1：upsert 对话元数据
        const { error: convErr } = await sb.from('conversations_sync').upsert({
          id: effectiveConvId,
          device_id: cfg.deviceId,
          title: convTitle,
          model: provider?.defaultModel || 'gpt-4o',
          message_count: db.select().from(messages).where(eq(messages.conversationId, effectiveConvId)).all().length,
          created_at: now,
          updated_at: now,
        }, { onConflict: 'id' });
        if (convErr) throw convErr;

        // 步骤 2：upsert 用户消息
        const { error: msgErr } = await sb.from('messages_sync').upsert({
          id: effectiveUserMsgId,
          conversation_id: effectiveConvId,
          device_id: cfg.deviceId,
          role: 'user',
          content,
          created_at: now,
        }, { onConflict: 'id' });
        if (msgErr) {
          // 补偿：消息写入失败，删除刚创建的对话，避免孤儿记录
          console.warn('[Sync] 用户消息 upsert 失败，执行补偿删除对话:', msgErr.message);
          try {
            await sb.from('conversations_sync').delete().eq('id', effectiveConvId);
          } catch { /* 补偿删除失败不阻塞抛出原错误 */ }
          throw msgErr;
        }

        // 步骤 3：同步历史消息（复用现有对话时）
        const allHist = db.select().from(messages).where(eq(messages.conversationId, effectiveConvId)).orderBy(messages.createdAt).all();
        const histToSync = allHist.filter(h => h.id !== effectiveUserMsgId);
        if (histToSync.length > 0) {
          const BATCH = 100;
          // BP-008 修复：Supabase 批量 upsert（传对象数组），替代逐条 Promise.all（N 次网络往返 → 1 次/批）
          for (let i = 0; i < histToSync.length; i += BATCH) {
            const batch = histToSync.slice(i, i + BATCH).map(hm => ({
              id: hm.id,
              conversation_id: hm.conversationId,
              device_id: cfg.deviceId,
              role: hm.role,
              content: hm.content,
              tool_calls: hm.toolCalls,
              tool_results: hm.toolResults,
              created_at: hm.createdAt,
            }));
            try {
              await sb.from('messages_sync').upsert(batch, { onConflict: 'id' });
            } catch { /* 批次失败不阻塞，但记录便于排查 */
              console.warn(`[Sync] 历史消息批量同步失败（批次 ${i / BATCH}，${batch.length} 条），尝试逐条兜底`);
              // 兜底：逐条重试，避免个别脏数据拖垮整批
              await Promise.all(batch.map(async hm => {
                try {
                  await sb.from('messages_sync').upsert(hm, { onConflict: 'id' });
                } catch { /* 单条失败不阻塞批次 */ }
              }));
            }
          }
        }

        syncSuccess = true;
        // 成功后确保 remote_commands 带上 conversation_id（幂等键落盘）
        try {
          await sb.from('remote_commands').update({ conversation_id: effectiveConvId }).eq('id', commandId);
        } catch { /* 幂等键落盘失败不阻塞主流程 */ }
        convId = effectiveConvId; // 同步成功后更新本地 convId 引用
        userMsgId = effectiveUserMsgId;
      } catch (e: unknown) {
        lastSyncError = e;
        console.error(`[Sync] 同步用户消息到 Supabase 失败 (尝试 ${attempt}/${MAX_SYNC_RETRIES}):`, e instanceof Error ? e.message : e);
        if (attempt < MAX_SYNC_RETRIES) {
          // 指数退避：1s, 2s, 4s...
          const delay = 1000 * Math.pow(2, attempt - 1);
          await new Promise(r => setTimeout(r, delay));
        }
      }
    }

    if (!syncSuccess) {
      console.error('[Sync] 同步用户消息彻底失败，已达最大重试次数:', lastSyncError instanceof Error ? lastSyncError.message : lastSyncError);
      // 不抛出，让后续流程继续（AI 调用仍会尝试，错误最终会通过 syncAssistantError 同步）
    }

    // 无 Provider：同步错误消息后结束
    if (!provider) {
      const errMsg = '未配置 AI Provider，请在 Aether 桌面端添加 AI Provider';
      await syncAssistantError(sb, cfg, convId, commandId, content, errMsg, now, backendConfig);
      return;
    }

    // ========== 流式调用 AI（带文件工具 + MCP 工具，支持 function calling 操作电脑） ==========
    // 流式输出：手机端可见逐字显示 + 思考过程
    const baseUrl = provider.baseUrl.replace(/\/$/, '');
    const model = provider.defaultModel;
    const history = db.select()
      .from(messages)
      .where(eq(messages.conversationId, convId))
      .orderBy(messages.createdAt)
      .all()
      // Q4 优化：上下文窗口管理 — 限制历史消息数量（与桌面对话框 MAX_HISTORY=50 对齐）。
      // 全量历史会膨胀 prompt token，显著拖慢首 token 响应。
      .slice(-50);

    // 加载设置（工作目录、权限、allowedDirs）
    const settings = await getSettings();
    const allowedDirs = Array.isArray(settings.allowedDirs) && settings.allowedDirs.length > 0
      ? settings.allowedDirs
      : [process.cwd()];
    const defaultDir = settings.defaultDir || allowedDirs[0] || process.cwd();
    const permissionLevel = typeof settings.permissionLevel === 'number' ? settings.permissionLevel : 2;

    // 加载 MCP 工具（与文件工具合并）
    const getMcpServers = () => db.select().from(mcpServers).all() as any[];
    const mcpTools = await listMcpTools(getMcpServers);
    const allTools = [
      ...fileTools,
      ...commandTools,
      ...searchTools,
      ...lspTools,
      ...testTools,
      ...codeReviewTools,
      ...mcpTools.map(t => ({
        type: 'function',
        function: {
          name: t.name,
          description: t.description || '',
          parameters: t.inputSchema || { type: 'object', properties: {} },
        },
      })),
    ];
    // 手机端联网搜索开关：remoteWeb=false 时过滤搜索系工具
    const activeTools = remoteWeb
      ? allTools
      : allTools.filter((t: any) => !/web_search|web_fetch|browser\./.test(t.function?.name ?? ''));

    const systemPrompt = `${MANDATORY_COMPLIANCE_PROMPT}

你是 Aether 远程助手。你运行在用户的电脑上（桌面端 Aether），拥有完整的本地文件操作能力。

远程用户通过手机发送了指令，请直接执行。用简体中文回答。

## 执行模式
- 模式: ${remoteMode === 'super' ? '超级模式（多步深入分析，拆解问题后一步步完成）' : '普通模式（直接高效回答）'}
- 权限等级: ${remoteLevel === 1 ? 'Level 1（只读操作，禁止修改/删除文件）' : 'Level 2（读写操作，可修改文件）'}
- 深度思考: ${remoteDeep ? '开启（请深入思考后作答）' : '关闭（直接作答）'}
- 联网搜索: ${remoteWeb ? '开启（可使用 web_search 工具）' : '关闭（不要使用联网搜索工具）'}
- 循环模式: ${remoteLoop ? '开启（持续执行直到完整完成任务，不要中途停止）' : '关闭'}

## 文件操作
- 工作目录: ${defaultDir}
- 文件操作限制在 allowedDirs 目录内: ${JSON.stringify(allowedDirs)}
- 未指定路径时使用工作目录
- 需要读取/写入文件时使用 read_file / write_file / list_files / delete_file / create_directory 工具
- 修改文件前先确认内容

你有 ${mcpTools.length} 个 MCP 工具可用。

## 重要规则
- **工具调用的结果（如 read_file、list_files 等）已由系统直接展示给用户，请勿在回答中重复输出工具结果的完整内容。只需基于结果进行分析、总结或给出下一步建议。**`;

    const apiMessages: any[] = [
      { role: 'system', content: systemPrompt },
      ...history.map(m => {
        const msg: any = { role: m.role, content: m.content };
        if (m.role === 'assistant' && m.toolCalls) {
          try { msg.tool_calls = JSON.parse(m.toolCalls); } catch { /* ignore */ }
        }
        if (m.role === 'tool' && m.toolCalls) {
          try { msg.tool_call_id = JSON.parse(m.toolCalls).id; } catch { /* ignore */ }
        }
        return msg;
      }),
    ];

    // 检测用户消息中的图片 data URL，转为多模态格式（AI 才能看到图片）
    const lastUserMsg = apiMessages.slice().reverse().find(m => m.role === 'user');
    if (lastUserMsg && typeof lastUserMsg.content === 'string') {
      const imgRegex = /!\[([^\]]*)\]\((data:image\/[^)]+)\)/g;
      const images: string[] = [];
      let match;
      while ((match = imgRegex.exec(lastUserMsg.content)) !== null) {
        images.push(match[2]);
      }
      if (images.length > 0) {
        // 去掉 content 中的图片 markdown，转为多模态 content parts
        const textContent = lastUserMsg.content.replace(/!\[([^\]]*)\]\((data:image\/[^)]+)\)/g, '').trim() || '用户上传了图片';
        const contentParts: any[] = [{ type: 'text', text: textContent }];
        for (const img of images.slice(0, 10)) {
          contentParts.push({ type: 'image_url', image_url: { url: img } });
        }
        lastUserMsg.content = contentParts;
      }
    }

    let aiContentFinal = '';
    let usageTotal = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
    let maxTurns = remoteLoop ? 500 : 30; // 循环模式：loop 开启时持续执行直到任务完整完成；否则 30 轮
    let lastErr: string = '';
    let streamMsgId: string = ''; // 流式消息 ID，在循环外定义，最终使用
    let lastToolResult = ''; // 最近一次工具执行结果，用于去重

    // 创建 EventBus 用于发射活动事件（桌面端 ActivityStream 消费）
    const eventBus = createEventBus(getDb(), undefined, () => saveDb(backendConfig));
    const runTaskId = randomUUID();
    eventBus.emit(convId, 'task.started', {
      taskId: runTaskId, agentId: 'main', agentType: 'conversation',
      content: content.slice(0, 200),
    });

    while (maxTurns-- > 0) {
      // 429 重试：最多 3 次，指数退避
      let aiResponse: Response | null = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          // 纵深防御：显式校验 baseUrl（虽受控但防配置篡改/注入）
          if (!isSafeFetchUrl(baseUrl)) throw new Error('baseUrl 存在 SSRF 风险：禁止访问链路本地/元数据地址或非 http(s) 协议');
          const resp = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': `Bearer ${provider.apiKey}`,
            },
            body: JSON.stringify({
              model,
              messages: apiMessages,
              tools: activeTools,
              tool_choice: 'auto',
              stream: true, // 流式输出，手机端可见逐字显示
              // 手机端深度思考开关：remoteDeep=true 时附加 thinking 参数
              ...(remoteDeep ? { thinking: { type: 'enabled' } } : {}),
            }),
            signal: AbortSignal.timeout(300000), // 5分钟超时
          });
          if (resp.status === 429 && attempt < 3) {
            const delay = 5000 * Math.pow(2, attempt);
            console.log(`[Sync] AI 429 限流，${delay / 1000}s 后重试 (${attempt + 1}/3)`);
            await new Promise(r => setTimeout(r, delay));
            continue;
          }
          if (!resp.ok) {
            const errText = (await resp.text().catch(() => '')).slice(0, 200);
            lastErr = `AI API 请求失败 (${resp.status}): ${errText}`;
            if (resp.status === 429) {
              await syncAssistantError(sb, cfg, convId, commandId, content, `❌ AI 服务被限流（429）。请稍后再试或更换 API Key。${errText}`, now, backendConfig);
              return;
            }
            throw new Error(lastErr);
          }
          aiResponse = resp;
          break;
        } catch (e: unknown) {
          if (e instanceof Error && e.name === 'AbortError') {
            lastErr = 'AI 请求超时（300s）';
          } else {
            lastErr = e instanceof Error ? e.message : String(e);
          }
          if (attempt >= 3) {
            await syncAssistantError(sb, cfg, convId, commandId, content, `❌ ${lastErr}`, now, backendConfig);
            return;
          }
          const delay = 2000 * Math.pow(2, attempt);
          console.log(`[Sync] AI 调用失败，${delay / 1000}s 后重试 (${attempt + 1}/3): ${lastErr}`);
          await new Promise(r => setTimeout(r, delay));
        }
      }

      if (!aiResponse) {
        await syncAssistantError(sb, cfg, convId, commandId, content, `❌ AI 调用失败: ${lastErr || '未知错误'}`, now, backendConfig);
        return;
      }

      // ========== 流式读取 SSE 响应（零节流，每 chunk 立即同步双端） ==========
      const reader = aiResponse.body!.getReader();
      const decoder = new TextDecoder();
      let streamBuffer = '';
      let accumulatedContent = '';
      let reasoningContent = '';
      let currentToolCalls: any[] = [];
      let streamUsage = { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 };
      // 流式消息用最终消息 ID —— 全程 upsert 同一条，不产生重复
      streamMsgId = randomUUID();

      // 立即在本地 DB 插入空消息占位（电脑端可实时看到内容增长）
      try {
        db.insert(messages).values({
          id: streamMsgId,
          conversationId: convId,
          role: 'assistant',
          content: '',
          createdAt: new Date().toISOString(),
        }).run();
      } catch { /* 已存在则忽略 */ }

      // Q4 修复：流式同步改为 250ms 累积节流 + 串行 flush 队列。
      // 原 15ms 节流在海外 Supabase（RTT ~570ms）下每 chunk 都发起一次并发 upsert，
      // 连接/请求排队导致手机端收到的字符更新严重滞后（"回复卡顿"的元凶）。
      // 新实现：累积 250ms 内的增量一次性写入；flushSync 串行执行防堆积。
      let throttleTimer: ReturnType<typeof setTimeout> | null = null;
      let pendingContent = '';
      let pendingReasoning = '';
      let flushChain: Promise<void> = Promise.resolve();
      const flushSync = () => {
        throttleTimer = null;
        const c = pendingContent;
        const r = pendingReasoning;
        pendingContent = '';
        pendingReasoning = '';
        // 串行入队：前一次网络往返完成后再写下一次，避免请求堆积
        flushChain = flushChain.then(async () => {
          try {
            db.update(messages).set({ content: c, toolResults: r ? JSON.stringify({ reasoning: r }) : null }).where(eq(messages.id, streamMsgId)).run();
          } catch (writeErr: unknown) {
            console.warn('[Sync] 流式消息本地落库失败（不阻塞但需关注）:', writeErr instanceof Error ? writeErr.message : String(writeErr));
          }
          if (c !== '' || r !== '') {
            try {
              await sb.from('messages_sync').upsert({
                id: streamMsgId,
                conversation_id: convId,
                device_id: cfg.deviceId,
                role: 'assistant',
                content: c || '...',
                tool_results: r ? JSON.stringify({ reasoning: r }) : null,
                created_at: now,
              }, { onConflict: 'id' });
            } catch { /* Supabase 写失败不阻塞 */ }
          }
        }).catch(() => undefined);
      };
      const scheduleSync = (content: string, reasoning: string) => {
        pendingContent = content;
        if (reasoning) pendingReasoning = reasoning;
        if (!throttleTimer) {
          throttleTimer = setTimeout(flushSync, 250);
        }
      };

      // 流式过程：每收到 chunk 立即调度（20ms 微节流），几乎无延迟且丝滑
      try {
        for await (const c of translate(parseSse(withChunkTimeout(reader, SSE_CHUNK_TIMEOUT_MS)))) {
          switch (c.type) {
            case 'reasoning-delta': {
              reasoningContent += c.text;
              // 必须落库（persist 默认 true），桌面端 fetchEvents 才能读到 → ActivityStream 渲染 thinking
              eventBus.emit(convId, 'agent.reasoning.delta', {
                taskId: runTaskId, agentId: 'main', agentType: 'conversation', content: c.text,
              });
              // 思考之后还有正文，等待正文 chunk 一起同步（避免频繁写）
              if (!accumulatedContent) {
                scheduleSync(accumulatedContent, reasoningContent);
              }
              break;
            }
            case 'text-delta': {
              accumulatedContent += c.text;
              // 必须落库，桌面端 ActivityStream 才能渲染消息增量
              eventBus.emit(convId, 'agent.message.delta', {
                taskId: runTaskId, agentId: 'main', agentType: 'conversation', content: c.text,
              });
              scheduleSync(accumulatedContent, reasoningContent);
              break;
            }
            case 'block-end': {
              if (c.block.kind === 'tool-call') {
                currentToolCalls.push({ id: c.block.id, function: { name: c.block.name, arguments: c.block.arguments }, index: currentToolCalls.length });
              }
              break;
            }
            case 'usage': {
              streamUsage.prompt_tokens += c.usage.inputTokens;
              streamUsage.completion_tokens += c.usage.outputTokens;
              streamUsage.total_tokens += c.usage.totalTokens ?? (c.usage.inputTokens + c.usage.outputTokens);
              break;
            }
            default: break;
          }
        }
      } catch (e: unknown) {
        // SseStreamError/MALFORMED：sync 上下文不炸整体流程，记日志并走正常收尾（已产出内容已同步）
        if (e instanceof Error) console.warn(`[Sync] AI 流式解析中断: ${e.message}`);
      }

      // 流结束，确保最后内容落盘（清除定时器，等待排队的 flush 完成）
      if (throttleTimer) { clearTimeout(throttleTimer); throttleTimer = null; }
      if (pendingContent || pendingReasoning) {
        flushSync();
      }
      await flushChain.catch(() => undefined);

      // 更新 token 用量
      if (streamUsage.total_tokens > 0) {
        usageTotal.prompt_tokens += streamUsage.prompt_tokens;
        usageTotal.completion_tokens += streamUsage.completion_tokens;
        usageTotal.total_tokens += streamUsage.total_tokens;
      }

      // 处理工具调用或最终回复
      if (currentToolCalls.length > 0) {
        // 有工具调用
        const assistantMsg: any = {
          role: 'assistant',
          content: accumulatedContent || null,
          tool_calls: currentToolCalls.map((tc: any) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.function.name, arguments: tc.function.arguments },
          })),
        };
        apiMessages.push(assistantMsg);

        // 保存工具调用消息到本地 + Supabase — 复用 streamMsgId 避免与占位行重复
        const toolCallMsgId = streamMsgId; // 复用占位 ID，不创建新行
        db.update(messages).set({
          content: accumulatedContent || JSON.stringify(currentToolCalls.map(tc => tc.function?.name)),
          toolCalls: JSON.stringify(currentToolCalls.map(tc => ({
            id: tc.id, type: 'function',
            function: { name: tc.function?.name, arguments: tc.function?.arguments || '{}' },
          }))),
        }).where(eq(messages.id, toolCallMsgId)).run();
        try {
          await sb.from('messages_sync').upsert({
            id: toolCallMsgId,
            conversation_id: convId,
            device_id: cfg.deviceId,
            role: 'assistant',
            content: accumulatedContent || JSON.stringify(currentToolCalls.map(tc => tc.function?.name)),
            tool_calls: JSON.stringify(currentToolCalls.map(tc => ({
              id: tc.id, type: 'function',
              function: { name: tc.function?.name, arguments: tc.function?.arguments || '{}' },
            }))),
            tool_results: reasoningContent ? JSON.stringify({ reasoning: reasoningContent }) : null,
            created_at: new Date().toISOString(),
          }, { onConflict: 'id' });
        } catch { /* 单条失败不阻塞 */ }

        // 执行每个工具
        for (const tc of currentToolCalls) {
          const funcName = tc.function?.name || '';
          let args: any = {};
          try { args = JSON.parse(tc.function?.arguments || '{}'); } catch { /* ignore */ }
          // 发射 tool.started 事件（必须落库，桌面端 ActivityStream 显示工具调用）
          eventBus.emit(convId, 'tool.started', {
            taskId: runTaskId, agentId: 'main', agentType: 'conversation',
            status: 'started', tool: buildToolPayload(funcName, args),
          });
          const mcpTool = mcpTools.find(t => t.name === funcName);
          let result: string;
          if (mcpTool) {
            try {
              result = await callMcpTool(mcpTool.serverName, funcName.slice(mcpTool.serverName.length + 1), args, getMcpServers, permissionLevel);
            } catch (e: unknown) {
              result = `MCP 工具调用失败: ${e instanceof Error ? e.message : String(e)}`;
            }
          } else {
            try {
              if (funcName === 'execute_command') {
                result = await executeCommand(args.command, args.workdir, args.timeout, allowedDirs, permissionLevel, defaultDir);
                addCommandHistory({ command: args.command || '', output: result, duration: 0, success: !result.startsWith('错误:'), source: 'agent' });
              } else if (funcName === 'grep') {
                result = executeGrep(args.pattern, args.path, args.include, args.maxResults, allowedDirs, permissionLevel, defaultDir);
              } else if (funcName === 'glob') {
                result = executeGlob(args.pattern, args.path, allowedDirs, permissionLevel, defaultDir);
              } else if (funcName === 'web_search') {
                result = await executeWebSearch(args.query, args.maxResults);
              } else if (funcName === 'web_fetch') {
                result = await executeWebFetch(args.url, args.format, allowedDirs, permissionLevel, defaultDir);
              } else if (funcName === 'lsp_diagnostics') {
                result = await executeLspDiagnostics(args.filePath, allowedDirs, permissionLevel, defaultDir);
              } else if (funcName === 'run_tests') {
                result = await executeRunTests(args.command, args.path, args.timeout, allowedDirs, permissionLevel, defaultDir);
              } else if (funcName === 'code_review') {
                result = executeCodeReview(args.filePath, args.code, args.language, allowedDirs, permissionLevel, defaultDir);
              } else {
                result = await executeFileTool(funcName, args, allowedDirs, defaultDir, permissionLevel);
              }
            } catch (e: unknown) {
              result = `工具执行失败: ${e instanceof Error ? e.message : String(e)}`;
            }
          }
          // 记录最近一次工具结果，用于去重（覆盖 MCP 和文件工具）
          lastToolResult = result;
          const toolMsgId = randomUUID();
          db.insert(messages).values({
            id: toolMsgId,
            conversationId: convId,
            role: 'tool',
            content: result,
            toolCalls: JSON.stringify({ id: tc.id, type: 'function', function: { name: funcName, arguments: args } }),
            createdAt: new Date().toISOString(),
          }).run();
          try {
            await sb.from('messages_sync').upsert({
              id: toolMsgId,
              conversation_id: convId,
              device_id: cfg.deviceId,
              role: 'tool',
              content: result.slice(0, 3000), // 完整同步到手机端，可展开查看
              tool_calls: JSON.stringify({ id: tc.id, type: 'function', function: { name: funcName, arguments: args } }),
              created_at: new Date().toISOString(),
            }, { onConflict: 'id' });
          } catch { /* 单条失败不阻塞 */ }
          apiMessages.push({ role: 'tool', tool_call_id: tc.id, content: result.slice(0, 2000) });
          // 发射 tool.completed 事件（必须落库，桌面端 ActivityStream 显示工具完成）
          eventBus.emit(convId, 'tool.completed', {
            taskId: runTaskId, agentId: 'main', agentType: 'conversation',
            status: 'completed', tool: buildToolPayload(funcName, args, result),
          });
        }
      } else {
        // 无工具调用，最终文本回复
        aiContentFinal = accumulatedContent || '';
        break;
      }
    }

    // maxTurns 耗尽兜底
    if (!aiContentFinal) {
      // 核心修复：工具循环结束后 AI 没给文本总结（aiContentFinal 为空），追加一轮强制总结，
      // 让 AI 基于所有工具结果给出完整答复，而不是填占位符
      try {
        const summaryReq = {
          model,
          messages: [...apiMessages, { role: 'user', content: '请基于上面所有工具执行的结果，给出完整的总结与最终答复。如果任务还没完成，请继续说明还需要做什么。' }],
          tools: allTools,
          tool_choice: 'none',
          stream: true,
        };
        // 纵深防御：显式校验 baseUrl
        if (!isSafeFetchUrl(baseUrl)) throw new Error('baseUrl 存在 SSRF 风险');
        const summaryRes = await fetch(`${baseUrl}/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${provider.apiKey}` },
          body: JSON.stringify(summaryReq),
          signal: AbortSignal.timeout(120000),
        });
        if (summaryRes.ok) {
          const sReader = summaryRes.body!.getReader();
          let summaryText = '';
          try {
            for await (const c of translate(parseSse(withChunkTimeout(sReader, SSE_CHUNK_TIMEOUT_MS)))) {
              if (c.type === 'text-delta') summaryText += c.text;
            }
          } catch { /* 流式解析失败则用已累积文本 */ }
          if (summaryText.trim()) aiContentFinal = summaryText.trim();
        }
      } catch { /* 强制总结失败则回退占位符 */ }
    }
    if (!aiContentFinal) {
      aiContentFinal = '✅ 处理完成（工具调用已执行）';
    }

    // 去重复：如果 AI 回复原样复述了工具结果，替换为简洁提示
    const dedupReplacement = dedupToolResultReplacement(aiContentFinal, lastToolResult);
    if (dedupReplacement) {
      aiContentFinal = dedupReplacement;
    }

    // 使用流式消息 ID 作为最终消息 ID（不重新创建，避免重复）
    const finalMsgId = streamMsgId;
    // 更新本地消息内容为最终版（流式过程可能已部分写入）
    try {
      db.update(messages).set({
        content: aiContentFinal,
        toolResults: JSON.stringify(usageTotal.total_tokens > 0 ? usageTotal : { total_tokens: Math.max(1, Math.round(aiContentFinal.length / 4)) }),
      }).where(eq(messages.id, finalMsgId)).run();
    } catch (updateErr: unknown) {
      console.warn('[Sync] 最终消息本地更新失败（不阻塞但需关注）:', updateErr instanceof Error ? updateErr.message : String(updateErr));
    }

    // 更新对话时间
    db.update(conversations).set({ updatedAt: new Date().toISOString() }).where(eq(conversations.id, convId)).run();

    // ========== 同步最终 AI 回复到 Supabase（用同一 ID，不重复） ==========
    await sb.from('messages_sync').upsert({
      id: finalMsgId,
      conversation_id: convId,
      device_id: cfg.deviceId,
      role: 'assistant',
      content: aiContentFinal,
      tool_results: JSON.stringify(usageTotal.total_tokens > 0 ? usageTotal : { total_tokens: Math.max(1, Math.round(aiContentFinal.length / 4)) }),
      created_at: now,
    }, { onConflict: 'id' });

    // 更新对话的消息数 + 时间
    await sb.from('conversations_sync').upsert({
      id: convId,
      device_id: cfg.deviceId,
      title: convTitle,
      model: provider.defaultModel,
      message_count: db.select().from(messages).where(eq(messages.conversationId, convId)).all().length,
      created_at: now,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' });

    // 标记命令完成，同时写入 conversation_id 供手机端追踪
    await sb.from('remote_commands').update({
      status: 'completed',
      conversation_id: convId,
      result_summary: aiContentFinal.slice(0, 200),
      processed_at: new Date().toISOString(),
    }).eq('id', commandId);

    // 记录同步日志
    await sb.from('sync_log').insert({
      device_id: cfg.deviceId,
      action: 'remote_command',
      status: 'success',
      details: `命令已处理: ${content.slice(0, 100)}`,
      created_at: new Date().toISOString(),
    });

    // 持久化本地数据库
    saveDb(backendConfig);

    // 发射 task.completed 事件（桌面端 ActivityStream 显示任务完成状态）
    eventBus.emit(convId, 'task.completed', {
      taskId: runTaskId, agentId: 'main', agentType: 'conversation',
      status: 'completed', content: '完成', endReason: 'completed',
    });
  } catch (e: unknown) {
    const errMsg = e instanceof Error ? e.message : String(e);
    console.error('[Sync] 远程命令处理失败:', errMsg);
    // 标记命令失败（尽力而为）
    try {
      await sb.from('remote_commands').update({
        status: 'failed',
        error: errMsg,
        processed_at: new Date().toISOString(),
      }).eq('id', commandId);
    } catch { /* ignore */ }
  }
}

// ============================================================
// 同步一条 assistant 错误消息 + 本地保存 + 命令标记失败（AI 失败时保证手机端可见）
// ============================================================

export async function syncAssistantError(
  sb: SupabaseClient,
  cfg: SyncConfig,
  convId: string,
  commandId: string,
  userContent: string,
  errMsg: string,
  now: string,
  backendConfig: BackendConfig
): Promise<void> {
  const db = getDb();
  const errMsgId = randomUUID();
  try {
    // 本地保存错误消息
    db.insert(messages).values({
      id: errMsgId,
      conversationId: convId,
      role: 'assistant',
      content: errMsg,
      createdAt: new Date().toISOString(),
    }).run();
    db.update(conversations).set({ updatedAt: new Date().toISOString() }).where(eq(conversations.id, convId)).run();

    // 同步错误消息到 Supabase
    await sb.from('messages_sync').upsert({
      id: errMsgId,
      conversation_id: convId,
      device_id: cfg.deviceId,
      role: 'assistant',
      content: errMsg,
      created_at: new Date().toISOString(),
    }, { onConflict: 'id' });

    // 更新对话消息数
    await sb.from('conversations_sync').upsert({
      id: convId,
      device_id: cfg.deviceId,
      title: (db.select().from(conversations).where(eq(conversations.id, convId)).get())?.title || '远程命令',
      model: 'unknown',
      message_count: db.select().from(messages).where(eq(messages.conversationId, convId)).all().length,
      created_at: now,
      updated_at: new Date().toISOString(),
    }, { onConflict: 'id' });

    // 标记命令失败并写 conversation_id
    await sb.from('remote_commands').update({
      status: 'failed',
      conversation_id: convId,
      error: errMsg,
      result_summary: errMsg.slice(0, 200),
      processed_at: new Date().toISOString(),
    }).eq('id', commandId);

    await sb.from('sync_log').insert({
      device_id: cfg.deviceId,
      action: 'remote_command',
      status: 'failed',
      details: `命令处理失败: ${errMsg.slice(0, 100)}`,
      created_at: new Date().toISOString(),
    });

    saveDb(backendConfig);
  } catch (e: unknown) {
    console.error('[Sync] 同步错误消息失败:', e instanceof Error ? e.message : e);
  }
}