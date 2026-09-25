import type { StreamChunk } from '@pacc/shared';
import { buildModelRuntime, type ModelRequest } from '../../core/models/index.js';
import { buildChatRequestBody, parseToolArgsSafe } from '../../lib/stream-translate.js';
import { buildToolPayload } from '@pacc/shared';
import { filterToolsByWebSearch } from '../../lib/tool-registry.js';
import { providerSupportsThinking } from '../../lib/provider.js';
import { drainDirectives } from '../../lib/inbox.js';
import { MANDATORY_COMPLIANCE_PROMPT } from '../../lib/system-prompts.js';
import { dedupToolResultReplacement } from '../../lib/deduplicate.js';
import { getActiveMemoriesFormatted, getSettings } from '../../lib/dal.js';
import { randomUUID } from 'node:crypto';
import { eq, sql } from 'drizzle-orm';
import { messages, conversations, mcpServers } from '../../db/schema/index.js';
import { AppError } from '@pacc/shared';
// P0-01 收口：统一生产工具执行器（Agent → ToolRuntime → PolicyEngine → Approval → ToolExecutor）
import { createProductionToolExecutor, type ProductionToolExecutor } from '../../lib/production-tool-executor.js';
// §30/§31 收口：预算统一来源 —— AgentDefinition limits → budgetFromAgentLimits（禁止 30/50/128000 散落硬编码）
import { budgetFromAgentLimits } from '../../core/runtime/execution-loop.js';
// 统一 ExecutionLoop：唯一生产循环控制器（第四部分：ToolLoop 收口为薄 wrapper，无第二套循环）
import { runExecutionLoop, type ExecutionLoopDeps, type ExecutionBudget } from '../../core/runtime/execution-loop.js';

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
  /** 流中断/失败标记（§16：断流不得伪装成功 —— 上层据此标记 agent.error 而非 agent.completed） */
  interrupted?: boolean;
}

/**
 * 超级 Chat 子 Agent 工具循环。
 *
 * 第四部分收口：本函数已改造为**薄 wrapper** —— 不再自建 while 循环，
 * 统一委托 core/runtime/execution-loop.ts::runExecutionLoop 作为唯一生产循环控制器。
 * SSE 实时输出 / 事件总线 / 审批副作用经 ExecutionLoopDeps 回调转发，语义保持不变。
 * 保留：强制总结（agent 只调工具无文本时追加一轮总结）、工具结果去重。
 */
export async function runAgentToolLoop(ctx: ToolLoopContext): Promise<ToolLoopResult> {
  let agentReply = '';
  let agentTokens = 0;
  let lastToolResult = '';
  let toolCallCount = 0;

  // §30/§31 收口：预算统一来源 —— AgentDefinition limits → budgetFromAgentLimits
  const agentLimits = (ctx.agent as { limits?: { maxTurns?: number; maxToolCalls?: number; maxTimeMs?: number; maxTokens?: number } } | undefined)?.limits;
  const unifiedBudget = budgetFromAgentLimits(agentLimits, !!ctx.body.loop);

  // P0-01 收口：统一生产工具执行器（PolicyEngine 唯一裁决 + Approval 完整绑定 + Timeout + Cancel）
  const productionExecutor: ProductionToolExecutor = createProductionToolExecutor({
    mcpTools: ctx.mcpTools,
    getMcpServers: () => ctx.db.select().from(mcpServers).all() as any[],
    allowedDirs: ctx.allowedDirs,
    permissionLevel: ctx.agentSettings.permissionLevel ?? 2,
    defaultDir: ctx.defaultDir,
    sessionId: (ctx.body.conversationId as string | undefined) ?? 'anonymous',
    runId: ctx.runTaskId,
    taskId: ctx.runTaskId,
    agentId: ctx.agent.id,
    signal: ctx.clientAbort.signal,
    onApprovalPrompt: ({ id, toolName, argsSummary }) => {
      // P0-07：审批事件带完整运行上下文（runId/taskId/agentId）
      ctx.sseSend('ask-confirm', JSON.stringify({ id, toolName, argsSummary }));
      if (ctx.body.conversationId) {
        ctx.eventBus.emit(ctx.convId, 'task.ask-confirm', {
          taskId: ctx.runTaskId,
          agentId: ctx.agent.id,
          agentType: ctx.agentCtx.agentType,
          content: `需要确认执行工具 ${toolName}`,
          metadata: { approvalId: id, toolName, argsSummary, runId: ctx.runTaskId, agentId: ctx.agent.id },
        });
      }
    },
  });

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

  // ExecutionLoopDeps：唯一循环控制器的依赖注入（第四部分收口）
  const deps: ExecutionLoopDeps = {
    model: runtime,
    hasTools: ctx.toolListForThisAgent.length > 0,
    buildRequest: (msgs, _turn): ModelRequest => ({
      provider: providerConfig.id,
      model: ctx.ep.model,
      messages: msgs,
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
    }),
    executeTool: async (tool, _turn): Promise<string> => {
      // 工具执行副作用：SSE tool-call/tool-result、eventBus tool.started/completed
      const funcName = tool.name;
      // parseToolArgsSafe：非法 JSON 降级为 {ok:false}，走工具降级路径（不炸流）
      const parsed = parseToolArgsSafe(tool.arguments);
      let args: any = parsed.args;
      if (!parsed.ok) {
        const errMsg = `工具参数不是合法 JSON: ${String(tool.arguments || '').slice(0, 500)}`;
        ctx.sseSend('tool-call', JSON.stringify({ name: funcName, arguments: {}, id: tool.id }));
        ctx.sseSend('tool-result', JSON.stringify({ name: funcName, result: errMsg, id: tool.id }));
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
        return errMsg;
      }

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

      let result: string;
      try {
        // P0-01 收口：统一生产执行器（PolicyEngine 唯一裁决 + Approval + Timeout + Cancel）
        const execResult = await productionExecutor.execute(funcName, args);
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
        ctx.sseSend('tool-call', JSON.stringify({ name: funcName, arguments: args, id: tool.id }));
        ctx.sseSend('tool-result', JSON.stringify({ name: funcName, result: result.slice(0, 500), id: tool.id }));
        return `错误: ${errMsg}`;
      }

      lastToolResult = result; // 记录工具结果供去重

      // 旧协议（兼容旧前端）
      ctx.sseSend('tool-call', JSON.stringify({ name: funcName, arguments: args, id: tool.id }));
      ctx.sseSend('tool-result', JSON.stringify({ name: funcName, result: result.slice(0, 500), id: tool.id }));

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
      return result.slice(0, 50000);
    },
    // 流式 chunk 转发：SSE 实时输出 + 事件总线（进入统一 Loop 不丢失实时输出）
    onChunk: (chunk: StreamChunk) => {
      switch (chunk.type) {
        case 'reasoning-delta': {
          const r = chunk.text;
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
          const t = chunk.text;
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
        default: break;
      }
    },
    // 完成判定：缺省有文本即完成（与 Normal 一致）
    isTaskComplete: (resp) => resp.content.trim() !== '',
  };

  // inbox 指令（steer/followup）：运行中用户补充的指令 → 注入为初始消息尾部（Loop 启动前读取一次）
  const convKey = (ctx.body.conversationId as string | undefined) ?? 'anonymous';
  const directives = drainDirectives(convKey);
  for (const d of directives) {
    ctx.agentMessages.push({ role: 'user', content: `[补充指令] ${d.text}` });
  }

  // 唯一生产循环控制器（第四部分：ToolLoop 收口）
  const executionBudget: ExecutionBudget = {
    maxTurns: unifiedBudget.maxTurns,
    maxToolCalls: unifiedBudget.maxToolCalls,
    maxTimeMs: unifiedBudget.maxTimeMs,
    maxTokens: unifiedBudget.maxTokens,
    maxCostCny: unifiedBudget.maxCostCny,
  };
  const result = await runExecutionLoop(deps, ctx.agentMessages, {
    loop: !!ctx.body.loop,
    budget: executionBudget,
    signal: ctx.clientAbort.signal,
  });

  agentReply = result.content;
  agentTokens = result.usage.cumulativeTotalTokens;
  toolCallCount = result.toolCallCount;
  // §16/§17 收口：流中断/失败不得伪装成功 —— 即使已有部分内容，也必须标记 interrupted，
  // 由上层（orchestration）据此发 agent.error 而非 agent.completed。
  const loopInterrupted = result.interrupted === true || result.state === 'failed';

  // 去重：若 AI 回复原样复述了工具执行结果，替换为简短提示（避免白字+绿框重复显示）
  const dedupReplacement = dedupToolResultReplacement(agentReply, lastToolResult);
  if (dedupReplacement) {
    agentReply = dedupReplacement;
  }

  // 流中断时不走"强制总结"（强制总结会掩盖中断事实），直接标记 interrupted
  if (loopInterrupted) {
    if (!agentReply) agentReply = '⚠️ 响应流中断（未收到完整结束标记）';
    return { agentReply, agentTokens, lastToolResult, toolCallCount, interrupted: true };
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
