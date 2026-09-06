import type { StreamChunk } from '@pacc/shared';
import { buildModelRuntime, type ModelRequest } from '../../core/models/index.js';
import { buildChatRequestBody, parseToolArgsSafe } from '../../lib/stream-translate.js';
import { executeTool } from '../../lib/tool-executor.js';
import { buildToolPayload } from '@pacc/shared';
import { filterToolsByWebSearch } from '../../lib/tool-registry.js';
import { providerSupportsThinking } from '../../lib/provider.js';
import { createPendingApproval } from '../../lib/approvals-center.js';
import { drainDirectives } from '../../lib/inbox.js';
import { MANDATORY_COMPLIANCE_PROMPT } from '../../lib/system-prompts.js';
import { dedupToolResultReplacement } from '../../lib/deduplicate.js';
import { getActiveMemoriesFormatted, getSettings } from '../../lib/dal.js';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { messages, conversations, mcpServers } from '../../db/schema/index.js';
import { AppError } from '@pacc/shared';

export interface ToolLoopContext {
  agent: any;
  ep: { baseUrl: string; apiKey: string; model: string };
  agentMessages: any[];
  toolListForThisAgent: any[];
  allTools: any[];
  mcpTools: any[];
  agentSettings: any;
  allowedDirs: string[];
  defaultDir: string;
  body: any;
  convId: string;
  runTaskId: string;
  clientAbort: AbortController;
  sseSend: (event: string, payload: string) => void;
  eventBus: any;
  db: any;
  config: any;
  customPrompts: Map<string, string>;
  otherAgentsInfo: string;
  imageHint: string;
  fileAttachmentsHint: string;
  hasImages: boolean;
  deepThinking: boolean;
  reasoningEffort: 'low' | 'medium' | 'high';
  webSearchEnabled: boolean;
  epSupportsThinking: boolean;
  agentCtx: { agentId: string; agentName: string; agentType: string };
  saveDb: () => void;
}

export interface ToolLoopResult {
  agentReply: string;
  agentTokens: number;
  lastToolResult: string;
  toolCallCount: number;
}

const MAX_TOOL_CALLS_PER_REQUEST = 50;

export async function runAgentToolLoop(ctx: ToolLoopContext): Promise<ToolLoopResult> {
  let agentReply = '';
  let agentTokens = 0;
  let lastToolResult = '';
  let toolCallCount = 0;

  // 循环模式：loop 开启时持续执行直到任务完整完成（极大上限，防死循环）；否则 30 轮
  let fcTurns = ctx.body.loop ? 500 : 30;

  // Build ModelRuntime from endpoint config (outside loop for reuse in force summary)
  const providerConfig = {
    id: 'ep',
    name: 'endpoint',
    type: 'openai',
    apiKey: ctx.ep.apiKey,
    baseUrl: ctx.ep.baseUrl,
    defaultModel: ctx.ep.model,
    models: [ctx.ep.model],
    capabilities: ['text', 'tool_calling'],
  };
  const runtime = buildModelRuntime(providerConfig);

  while (fcTurns-- > 0) {
    // inbox 指令（steer/followup）：运行中用户补充的指令 → drain 为 user 消息注入下一轮
    const convKey = (ctx.body.conversationId as string | undefined) ?? 'anonymous';
    const directives = drainDirectives(convKey);
    for (const d of directives) {
      ctx.agentMessages.push({ role: 'user', content: `[补充指令] ${d.text}` });
    }

    const reqBody = buildChatRequestBody({
      model: ctx.ep.model,
      messages: ctx.agentMessages,
      tools: ctx.toolListForThisAgent,
      tool_choice: 'auto',
      deepThinking: ctx.deepThinking,
      reasoningEffort: ctx.reasoningEffort,
      supportsThinking: ctx.epSupportsThinking,
      max_tokens: 4096,
    });

    const request: ModelRequest = {
      provider: providerConfig.id,
      model: ctx.ep.model,
      messages: ctx.agentMessages,
      tools: ctx.toolListForThisAgent.map(t => ({
        type: 'function' as const,
        function: {
          name: t.function.name,
          description: t.function.description,
          parameters: t.function.parameters,
        },
      })),
      maxTokens: 4096,
      signal: ctx.clientAbort.signal,
    };

    let accumulatedContent = '';
    let accumulatedReasoning = '';
    let currentToolCalls: any[] = [];
    let hasToolCalls = false;
    let turnFinish: 'stop' | 'tool_calls' | 'max-tokens' | 'error' = 'stop';

    try {
      for await (const c of runtime.stream(request)) {
        switch (c.type) {
          case 'reasoning-delta': {
            const r = c.text;
            accumulatedReasoning += r;
            ctx.sseSend('reasoning', JSON.stringify({ content: r, agentId: ctx.agent.id, agentName: ctx.agent.name }));
            if (ctx.body.conversationId) {
              ctx.eventBus.emit(ctx.convId, 'agent.reasoning.delta', {
                taskId: ctx.runTaskId,
                agentId: ctx.agent.id,
                agentType: ctx.agentCtx.agentType,
                content: r,
              });
            }
            break;
          }
          case 'text-delta': {
            const t = c.text;
            accumulatedContent += t;
            if (ctx.body.conversationId) {
              ctx.eventBus.emit(ctx.convId, 'agent.message.delta', {
                taskId: ctx.runTaskId,
                agentId: ctx.agent.id,
                agentType: ctx.agentCtx.agentType,
                content: t,
              });
            }
            break;
          }
          case 'block-end': {
            if (c.block.kind === 'tool-call') {
              hasToolCalls = true;
              currentToolCalls.push({ id: c.block.id, type: 'function', function: { name: c.block.name, arguments: c.block.arguments } });
            }
            break;
          }
          case 'usage': {
            agentTokens += c.usage.totalTokens ?? (c.usage.inputTokens + c.usage.outputTokens);
            break;
          }
          case 'finish': {
            if (c.reason.kind === 'error') {
              throw new Error(c.reason.message || 'LLM 流式响应错误');
            }
            turnFinish = c.reason.kind;
            break;
          }
        }
      }
    } catch (e: unknown) {
      if (e instanceof Error && e.name === 'StreamError') {
        ctx.sseSend('error', JSON.stringify({ message: `AI 响应流中断: ${e.message}` }));
      }
      throw e;
    }

    // 流结束后处理结果
    if (hasToolCalls && currentToolCalls.length > 0) {
      // 有工具调用 — 执行并继续循环
      // 对齐 harness：纯工具调用轮 content 发空串（而非 null）；reasoning_content 必须回传防会话"砖化"
      ctx.agentMessages.push({
        role: 'assistant',
        content: accumulatedContent || '',
        tool_calls: currentToolCalls,
        ...(accumulatedReasoning ? { reasoning_content: accumulatedReasoning } : {}),
      });

      for (const tc of currentToolCalls) {
        // PF-02: 工具调用预算检查 — 超过 50 次则优雅终止
        toolCallCount++;
        if (toolCallCount > MAX_TOOL_CALLS_PER_REQUEST) {
          const budgetMsg = `⚠️ 已达到工具调用上限 (${MAX_TOOL_CALLS_PER_REQUEST} 次)，本次请求停止执行。如需继续，请发送新消息。`;
          ctx.sseSend('message', JSON.stringify({ content: budgetMsg }));
          if (ctx.body.conversationId) {
            ctx.eventBus.emit(ctx.convId, 'agent.message.delta', {
              taskId: ctx.runTaskId,
              agentId: ctx.agent.id,
              agentType: ctx.agentCtx.agentType,
              content: budgetMsg,
            });
          }
          agentReply = budgetMsg;
          break;
        }

        const funcName = tc.function?.name || '';
        // parseToolArgsSafe：非法 JSON 降级为 {ok:false}，走工具降级路径（不炸流）
        const parsed = parseToolArgsSafe(tc.function?.arguments);
        let args: any = parsed.args;
        if (!parsed.ok) {
          const errMsg = `工具参数不是合法 JSON: ${String(tc.function?.arguments || '').slice(0, 500)}`;
          ctx.sseSend('tool-call', JSON.stringify({ name: funcName, arguments: {}, id: tc.id }));
          ctx.sseSend('tool-result', JSON.stringify({ name: funcName, result: errMsg, id: tc.id }));
          if (ctx.body.conversationId) {
            ctx.eventBus.emit(ctx.convId, 'tool.completed', {
              taskId: ctx.runTaskId,
              agentId: ctx.agent.id,
              agentType: ctx.agentCtx.agentType,
              status: 'error',
              content: errMsg,
              tool: { ...buildToolPayload(funcName, {}), error: { message: errMsg }, toolOutput: undefined },
              parentEventId: undefined,
            });
          }
          ctx.agentMessages.push({ role: 'tool', tool_call_id: tc.id, content: errMsg });
          continue;
        }

        const mcpTool = ctx.mcpTools.find((t: any) => t.name === funcName);
        let result: string;

        // 统一协议：tool.started（带 agentId —— 多 Agent 并行归属的关键修复）
        const toolStarted = ctx.body.conversationId
          ? ctx.eventBus.emit(ctx.convId, 'tool.started', {
              taskId: ctx.runTaskId,
              agentId: ctx.agent.id,
              agentType: ctx.agentCtx.agentType,
              status: 'started',
              tool: buildToolPayload(funcName, args),
            })
          : null;

        try {
          // BE-05: 传递 abort signal 到工具执行，支持客户端断连时取消
          const execResult = await executeTool(funcName, args, {
            mcpTools: ctx.mcpTools,
            getMcpServers: () => ctx.db.select().from(mcpServers).all() as any[],
            allowedDirs: ctx.allowedDirs,
            permissionLevel: ctx.agentSettings.permissionLevel ?? 2,
            defaultDir: ctx.defaultDir,
            sessionId: (ctx.body.conversationId as string | undefined) ?? 'anonymous',
            signal: ctx.clientAbort.signal,
            onApproval: async (toolName: string, toolArgs: any, argsSummary: string) => {
              const { id: approvalId, promise } = createPendingApproval({
                toolName,
                args: toolArgs,
                conversationId: ctx.body.conversationId ?? 'anonymous',
                prompt: ({ id: apId, toolName: name, argsSummary: summ }) => {
                  ctx.sseSend('ask-confirm', JSON.stringify({ id: apId, toolName: name, argsSummary: summ }));
                  if (ctx.body.conversationId) {
                    ctx.eventBus.emit(ctx.convId, 'task.ask-confirm', {
                      taskId: ctx.runTaskId,
                      agentId: ctx.agent.id,
                      agentType: ctx.agentCtx.agentType,
                      content: `需要确认执行工具 ${name}`,
                      metadata: { approvalId: apId, toolName: name, argsSummary: summ },
                    });
                  }
                },
              });
              const { approved, decision } = await promise;
              if (ctx.body.conversationId) {
                ctx.eventBus.emit(ctx.convId, 'task.plan', {
                  taskId: ctx.runTaskId,
                  agentId: ctx.agent.id,
                  agentType: ctx.agentCtx.agentType,
                  content: approved ? `用户已批准执行 ${toolName}` : `用户未批准 ${toolName}（${decision === 'timeout' ? '审批超时' : '已拒绝'}）`,
                });
              }
              return { approved, decision };
            },
          });
          result = execResult.result;
          if (execResult.error) throw new Error(execResult.error);
        } catch (e: unknown) {
          const errMsg = (e instanceof Error ? e.message : String(e)) || '工具执行失败';
          result = `错误: ${errMsg}`;
          lastToolResult = result;
          if (ctx.body.conversationId && toolStarted) {
            ctx.eventBus.emit(ctx.convId, 'tool.error', {
              taskId: ctx.runTaskId,
              agentId: ctx.agent.id,
              agentType: ctx.agentCtx.agentType,
              status: 'error',
              content: errMsg,
              tool: { ...buildToolPayload(funcName, args), error: { message: errMsg }, toolOutput: undefined },
              parentEventId: toolStarted.eventId,
            });
          }
          ctx.sseSend('tool-call', JSON.stringify({ name: funcName, arguments: args, id: tc.id }));
          ctx.sseSend('tool-result', JSON.stringify({ name: funcName, result: result.slice(0, 500), id: tc.id }));
          ctx.agentMessages.push({ role: 'tool', tool_call_id: tc.id, content: `错误: ${errMsg}` });
          continue;
        }

        lastToolResult = result; // 记录工具结果供去重
        ctx.agentMessages.push({ role: 'tool', tool_call_id: tc.id, content: result.slice(0, 50000) });

        // 旧协议（兼容旧前端）
        ctx.sseSend('tool-call', JSON.stringify({ name: funcName, arguments: args, id: tc.id }));
        ctx.sseSend('tool-result', JSON.stringify({ name: funcName, result: result.slice(0, 500), id: tc.id }));

        // 统一协议：tool.completed（完整结果入 envelope，带 agentId + 关联 started）
        if (ctx.body.conversationId && toolStarted) {
          ctx.eventBus.emit(ctx.convId, 'tool.completed', {
            taskId: ctx.runTaskId,
            agentId: ctx.agent.id,
            agentType: ctx.agentCtx.agentType,
            status: 'completed',
            tool: buildToolPayload(funcName, args, result),
            parentEventId: toolStarted.eventId,
          });
        }
      }

      // PF-02: 若工具调用预算耗尽，跳出外层 while 循环
      if (toolCallCount > MAX_TOOL_CALLS_PER_REQUEST) {
        break;
      }
    } else {
      // 纯文本回复 — 结束
      agentReply = accumulatedContent || '';
      break;
    }
  }

  // 去重：若 AI 回复原样复述了工具执行结果，替换为简短提示（避免白字+绿框重复显示）
  const dedupReplacement = dedupToolResultReplacement(agentReply, lastToolResult);
  if (dedupReplacement) {
    agentReply = dedupReplacement;
  }

  // 核心修复：工具循环结束后，若 agent 一直调工具没给文本总结（agentReply 为空），
  // 追加一轮「强制总结」调用，让 AI 基于全部工具结果给出完整总结，而不是填占位符
  if (!agentReply) {
    try {
      const summaryRequest: ModelRequest = {
        provider: providerConfig.id,
        model: ctx.ep.model,
        messages: [...ctx.agentMessages, { role: 'user', content: '请基于上面所有工具执行的结果，给出完整的总结与最终答复。如果任务还没完成，请继续说明还需要做什么。' }],
        tools: ctx.toolListForThisAgent.map(t => ({
          type: 'function' as const,
          function: {
            name: t.function.name,
            description: t.function.description,
            parameters: t.function.parameters,
          },
        })),
        maxTokens: 4096,
        signal: ctx.clientAbort.signal,
      };
      const summaryResponse = await runtime.complete(summaryRequest);
      let summaryText = summaryResponse.content.trim();
      if (summaryText) {
        // 流式推送给前端（模拟流式输出）
        if (ctx.body.conversationId) {
          ctx.eventBus.emit(ctx.convId, 'agent.message.delta', {
            taskId: ctx.runTaskId,
            agentId: ctx.agent.id,
            agentType: ctx.agentCtx.agentType,
            content: summaryText,
          }, { persist: false });
        }
        agentReply = summaryText;
      }
    } catch {
      // 强制总结失败则回退占位符
    }
  }

  if (!agentReply) agentReply = '✅ 处理完成（工具调用已执行）';

  // C4 修复：工具型 agent 的实际成果（写了什么文件/命令输出）并入结果，
  // 否则 Sisyphus 汇总时只看到占位符"✅ 处理完成"，最终回答空洞
  const toolSummary = lastToolResult && lastToolResult !== agentReply
    ? lastToolResult.slice(0, 2000)
    : '';

  return { agentReply, agentTokens, lastToolResult: toolSummary, toolCallCount };
}